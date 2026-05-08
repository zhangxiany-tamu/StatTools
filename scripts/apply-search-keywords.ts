#!/usr/bin/env tsx
// ============================================================================
// StatTools — Apply Search-Keyword Overrides
// ============================================================================
// Reads data/search_keywords_overrides.csv and appends per-function extra
// keywords into search_docs.search_keywords (and refreshes FTS5).
//
// The base reindexer derives keywords only from the function name itself; this
// override mechanism adds semantic synonyms (e.g. "instrumental variables 2sls"
// for AER::ivreg, "scikit-learn" for sklearn.* entries) so common queries
// rank correctly.
//
// CSV format:
//   id,extra_keywords
//   AER::ivreg,instrumental variables iv 2sls two stage least squares
//
// Usage:
//   tsx scripts/apply-search-keywords.ts [--csv=path]
// ============================================================================

import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot(__dirname);
const DB_PATH = resolve(PROJECT_ROOT, "data", "stattools.db");
const DEFAULT_CSV = resolve(PROJECT_ROOT, "data", "search_keywords_overrides.csv");

function parseFlags(argv: string[]): { csvPath: string } {
  let csvPath = DEFAULT_CSV;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--csv=")) csvPath = resolve(arg.slice("--csv=".length));
  }
  return { csvPath };
}

// Parse a CSV that may contain commas inside the keyword field by treating
// the FIRST comma as the column separator (id is single-token).
function parseLine(line: string): { id: string; keywords: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const idx = trimmed.indexOf(",");
  if (idx < 0) return null;
  const id = trimmed.slice(0, idx).trim();
  const keywords = trimmed.slice(idx + 1).trim();
  if (!id || !keywords) return null;
  return { id, keywords };
}

function main(): void {
  const { csvPath } = parseFlags(process.argv);
  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }
  const text = readFileSync(csvPath, "utf-8");
  const rows = text.split("\n").map(parseLine).filter((r): r is { id: string; keywords: string } => r != null);
  // Drop the header row if present (id == "id")
  const overrides = rows.filter((r) => r.id !== "id");
  console.log(`Loaded ${overrides.length} keyword overrides from ${csvPath}`);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  let appliedToDocs = 0;
  let missing: string[] = [];

  try {
    const select = db.prepare(`SELECT search_keywords FROM search_docs WHERE function_id = ?`);
    const update = db.prepare(`UPDATE search_docs SET search_keywords = ? WHERE function_id = ?`);
    const tx = db.transaction((items: typeof overrides) => {
      for (const { id, keywords } of items) {
        const existing = select.get(id) as { search_keywords: string } | undefined;
        if (!existing) {
          missing.push(id);
          continue;
        }
        // Append, dedupe tokens.
        const tokens = new Set<string>(
          [existing.search_keywords ?? "", keywords]
            .join(" ")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean),
        );
        update.run([...tokens].join(" "), id);
        appliedToDocs += 1;
      }
    });
    tx(overrides);

    // Refresh FTS5 for the affected rows.
    const fnIds = overrides.filter((o) => !missing.includes(o.id)).map((o) => o.id);
    if (fnIds.length > 0) {
      const placeholders = fnIds.map(() => "?").join(",");
      const ftsDel = db.prepare(`DELETE FROM search_docs_fts WHERE rowid IN (SELECT rowid FROM search_docs WHERE function_id IN (${placeholders}))`);
      ftsDel.run(...fnIds);
      const ftsIns = db.prepare(`
        INSERT INTO search_docs_fts (rowid, package, name, title, description, task_views, search_keywords)
        SELECT rowid, package, name, title, description, '', search_keywords
        FROM search_docs WHERE function_id IN (${placeholders})
      `);
      ftsIns.run(...fnIds);
    }

    console.log(`  applied: ${appliedToDocs} search_docs rows (FTS5 refreshed)`);
    if (missing.length > 0) {
      console.log(`  missing: ${missing.length} (${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""})`);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
}
