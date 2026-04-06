// ============================================================================
// StatTools — Incremental Reindex
// ============================================================================
// After a successful package install, extracts function metadata for that
// single package and inserts it into the existing stattools.db.
// Uses a separate read-write connection. Caller must trigger
// SearchEngine.refresh() after completion.

import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot(__dirname);
const EXTRACTOR_SCRIPT = resolve(PROJECT_ROOT, "r", "schema_extractor.R");
const SAFETY_CSV = resolve(PROJECT_ROOT, "data", "safety_overrides.csv");

type ExtractedFunction = {
  readonly package: string;
  readonly function_name: string;
  readonly title: string;
  readonly description: string;
  readonly has_formula: boolean;
  readonly has_dots: boolean;
};

/** Extract function metadata for a single package via R subprocess. */
async function extractPackageFunctions(
  packageName: string,
  rPath: string = "Rscript",
): Promise<readonly ExtractedFunction[]> {
  const proc = spawn(rPath, ["--vanilla", EXTRACTOR_SCRIPT, packageName], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const results: ExtractedFunction[] = [];
  const rl = createInterface({ input: proc.stdout! });

  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.package && entry.function_name) {
        results.push(entry as ExtractedFunction);
      }
    } catch { /* skip malformed lines */ }
  }

  await new Promise<void>((res) => {
    proc.on("exit", () => res());
  });

  return results;
}

/** Load safety overrides that match a given package. */
function loadPackageSafetyOverrides(
  packageName: string,
): ReadonlyMap<string, string> {
  const overrides = new Map<string, string>();
  if (!existsSync(SAFETY_CSV)) return overrides;

  const lines = readFileSync(SAFETY_CSV, "utf-8").trim().split("\n");
  const prefix = `${packageName}::`;

  for (const line of lines.slice(1)) {
    const [functionId, safetyClass] = line.split(",").map((s) => s.trim());
    if (functionId?.startsWith(prefix) && safetyClass) {
      overrides.set(functionId, safetyClass);
    }
  }

  return overrides;
}

/** Generate search keywords from package and function name. */
function generateSearchKeywords(pkg: string, fnName: string): string {
  const words: string[] = [];
  words.push(
    ...fnName
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[._]/g, " ")
      .toLowerCase()
      .split(/\s+/),
  );
  words.push(pkg.toLowerCase());
  return [...new Set(words)].join(" ");
}

export type ReindexResult = {
  readonly packageName: string;
  readonly functionsInserted: number;
  readonly overridesApplied: number;
  readonly durationMs: number;
};

/**
 * Reindex a single package into the existing database.
 * Opens a separate read-write connection, does all writes, then closes.
 * Caller must call SearchEngine.refresh() after this completes.
 */
export async function reindexPackage(
  dbPath: string,
  packageName: string,
  rPath: string = "Rscript",
): Promise<ReindexResult> {
  const startTime = Date.now();

  // 1. Extract function metadata via R
  const functions = await extractPackageFunctions(packageName, rPath);
  if (functions.length === 0) {
    return {
      packageName,
      functionsInserted: 0,
      overridesApplied: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // 2. Load matching safety overrides
  const overrides = loadPackageSafetyOverrides(packageName);

  // 3. Open a separate read-write connection
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    // 4. Update packages table: mark as installed
    db.prepare(`
      INSERT INTO packages (name, installed, install_status, last_updated)
      VALUES (?, 1, 'installed', ?)
      ON CONFLICT(name) DO UPDATE SET
        installed = 1,
        install_status = 'installed',
        last_updated = excluded.last_updated
    `).run(packageName, new Date().toISOString());

    // 5. Remove old stub entry if it exists
    db.prepare("DELETE FROM search_docs WHERE function_id = ?")
      .run(`${packageName}::${packageName}`);
    db.prepare("DELETE FROM functions WHERE id = ? AND is_stub = 1")
      .run(`${packageName}::${packageName}`);

    // 6. Insert functions and search docs
    const insertFn = db.prepare(`
      INSERT OR REPLACE INTO functions
        (id, package, name, title, description, safety_class, has_formula_arg, has_dots, is_stub)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    const insertDoc = db.prepare(`
      INSERT OR REPLACE INTO search_docs
        (function_id, package, name, title, description, search_keywords)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction(() => {
      for (const fn of functions) {
        const id = `${fn.package}::${fn.function_name}`;
        const safetyClass = overrides.get(id) || "unclassified";
        const desc = fn.description.slice(0, 500);

        insertFn.run(
          id,
          fn.package,
          fn.function_name,
          fn.title,
          desc,
          safetyClass,
          fn.has_formula ? 1 : 0,
          fn.has_dots ? 1 : 0,
        );

        const keywords = generateSearchKeywords(fn.package, fn.function_name);
        insertDoc.run(id, fn.package, fn.function_name, fn.title, desc, keywords);
      }
    });
    insertAll();

    // 7. Rebuild FTS5 for the new rows.
    //    FTS5 content-sync table columns: package, name, title, description, task_views, search_keywords
    //    Delete old entries then re-insert for this package.
    const escapedPkg = packageName.replace(/'/g, "''");
    db.exec(`
      DELETE FROM search_docs_fts WHERE rowid IN (
        SELECT rowid FROM search_docs WHERE package = '${escapedPkg}'
      )
    `);
    db.exec(`
      INSERT INTO search_docs_fts (rowid, package, name, title, description, task_views, search_keywords)
      SELECT rowid, package, name, title, description, '', search_keywords
      FROM search_docs
      WHERE package = '${escapedPkg}'
    `);
  } finally {
    db.close();
  }

  return {
    packageName,
    functionsInserted: functions.length,
    overridesApplied: overrides.size,
    durationMs: Date.now() - startTime,
  };
}
