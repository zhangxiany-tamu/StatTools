#!/usr/bin/env tsx
// ============================================================================
// StatTools — CRAN Tarball Extraction Pipeline
// ============================================================================
// Downloads CRAN source tarballs for top N stub packages, extracts function
// metadata from man/*.Rd files, and merges into stattools.db.
//
// Usage:
//   tsx scripts/extract-tarballs.ts                           # Top 500 (default)
//   tsx scripts/extract-tarballs.ts --top 10                  # Top 10 (test)
//   tsx scripts/extract-tarballs.ts --package X               # Single package
//   tsx scripts/extract-tarballs.ts --package-list FILE       # Explicit target list
//   tsx scripts/extract-tarballs.ts --package-list FILE --offset 500 --limit 1000
// ============================================================================

import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

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
const DB_PATH = resolve(PROJECT_ROOT, "data", "stattools.db");
const CACHE_DIR = resolve(PROJECT_ROOT, "data", "tarball_cache");
const MANIFEST_PATH = resolve(CACHE_DIR, "manifest.json");
const EXTRACTOR_SCRIPT = resolve(PROJECT_ROOT, "r", "tarball_extractor.R");
const SAFETY_CSV = resolve(PROJECT_ROOT, "data", "safety_overrides.csv");
const CRAN_BASE = "https://cran.r-project.org/src/contrib";

// ---- CLI args ---------------------------------------------------------------

const args = process.argv.slice(2);
const topN = parseInt(args.find((a, i) => args[i - 1] === "--top") || "500", 10);
const singlePackage = args.find((a, i) => args[i - 1] === "--package") || null;
const packageListPath = args.find((a, i) => args[i - 1] === "--package-list") || null;
const packageListOffset = parseInt(args.find((a, i) => args[i - 1] === "--offset") || "0", 10);
const packageListLimit = parseInt(args.find((a, i) => args[i - 1] === "--limit") || "0", 10);

// ---- Manifest ---------------------------------------------------------------

type ManifestEntry = {
  version: string;
  extracted_at: string;
  status: "ok" | "failed" | "no_man";
  functions_count: number;
  title_coverage: number;
  description_coverage: number;
};

type Manifest = {
  packages: Record<string, ManifestEntry>;
};

function loadManifest(): Manifest {
  if (existsSync(MANIFEST_PATH)) {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  }
  return { packages: {} };
}

function saveManifest(manifest: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// ---- Phase A: Select packages -----------------------------------------------

type TargetPackage = { name: string; version: string; downloads: number };

function loadPackageList(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function selectTargetPackages(db: Database.Database): TargetPackage[] {
  if (singlePackage) {
    const row = db.prepare(
      "SELECT p.name, p.version, p.downloads_monthly FROM packages p WHERE p.name = ?",
    ).get(singlePackage) as { name: string; version: string; downloads_monthly: number } | undefined;
    if (!row || !row.version) {
      console.error(`Package '${singlePackage}' not found or has no version.`);
      return [];
    }
    return [{ name: row.name, version: row.version, downloads: row.downloads_monthly }];
  }

  if (packageListPath) {
    const packages = loadPackageList(resolve(PROJECT_ROOT, packageListPath));
    const sliced = packageListLimit > 0
      ? packages.slice(packageListOffset, packageListOffset + packageListLimit)
      : packages.slice(packageListOffset);

    const stmt = db.prepare(
      "SELECT p.name, p.version, p.downloads_monthly FROM packages p WHERE p.name = ?",
    );
    const targets: TargetPackage[] = [];
    for (const pkgName of sliced) {
      const row = stmt.get(pkgName) as {
        name: string;
        version: string;
        downloads_monthly: number;
      } | undefined;
      if (!row || !row.version) {
        console.warn(`Skipping ${pkgName}: not found or missing version`);
        continue;
      }
      targets.push({
        name: row.name,
        version: row.version,
        downloads: row.downloads_monthly || 0,
      });
    }
    return targets;
  }

  const rows = db.prepare(`
    SELECT DISTINCT p.name, p.version, p.downloads_monthly
    FROM packages p
    JOIN functions f ON f.package = p.name AND f.is_stub = 1
    WHERE p.version IS NOT NULL AND p.version != ''
    ORDER BY p.downloads_monthly DESC
    LIMIT ?
  `).all(topN) as Array<{ name: string; version: string; downloads_monthly: number }>;

  return rows.map((r) => ({ name: r.name, version: r.version, downloads: r.downloads_monthly }));
}

// ---- Phase B: Download + extract tarballs -----------------------------------

async function downloadTarball(
  pkg: TargetPackage,
  manifest: Manifest,
): Promise<string | null> {
  // Check cache
  const cached = manifest.packages[pkg.name];
  if (cached && cached.version === pkg.version && cached.status === "ok") {
    const cachedDir = resolve(CACHE_DIR, pkg.name);
    if (existsSync(resolve(cachedDir, "man"))) {
      return cachedDir;
    }
  }

  const tarName = `${pkg.name}_${pkg.version}.tar.gz`;
  const tarPath = resolve(CACHE_DIR, tarName);
  const extractDir = resolve(CACHE_DIR, pkg.name);

  // Download
  const urls = [
    `${CRAN_BASE}/${tarName}`,
    `${CRAN_BASE}/Archive/${pkg.name}/${tarName}`,
  ];

  let downloaded = false;
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        writeFileSync(tarPath, buffer);
        downloaded = true;
        break;
      }
    } catch { /* try next URL */ }
  }

  if (!downloaded) {
    return null;
  }

  // Extract only man/, NAMESPACE, DESCRIPTION
  try {
    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true });
    mkdirSync(extractDir, { recursive: true });

    execFileSync("tar", [
      "xzf", tarPath,
      "-C", CACHE_DIR,
      `${pkg.name}/man`,
      `${pkg.name}/NAMESPACE`,
      `${pkg.name}/DESCRIPTION`,
    ], { timeout: 10000, stdio: "pipe" });

    // Clean up tarball to save space
    try { rmSync(tarPath); } catch { /* ok */ }

    return extractDir;
  } catch {
    // tar might fail if man/ doesn't exist in the tarball
    try { rmSync(tarPath); } catch { /* ok */ }
    return null;
  }
}

// ---- Phase C: Run R extraction ----------------------------------------------

type ExtractedFunction = {
  package: string;
  function_name: string;
  title: string;
  description: string;
  has_formula: boolean;
  has_dots: boolean;
  source: string;
};

async function extractFunctions(
  pkgDirs: string[],
): Promise<ExtractedFunction[]> {
  if (pkgDirs.length === 0) return [];

  const proc = spawn("Rscript", ["--vanilla", EXTRACTOR_SCRIPT, ...pkgDirs], {
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
    } catch { /* skip */ }
  }

  // Log stderr
  let stderrBuf = "";
  proc.stderr?.on("data", (c: Buffer) => { stderrBuf += c.toString(); });

  await new Promise<void>((res) => proc.on("exit", () => res()));

  return results;
}

// ---- Phase D: Merge into SQLite ---------------------------------------------

function loadSafetyOverrides(): Map<string, string> {
  const overrides = new Map<string, string>();
  if (!existsSync(SAFETY_CSV)) return overrides;
  const lines = readFileSync(SAFETY_CSV, "utf-8").trim().split("\n");
  for (const line of lines.slice(1)) {
    const [id, cls] = line.split(",").map((s) => s.trim());
    if (id && cls) overrides.set(id, cls);
  }
  return overrides;
}

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

function mergeIntoDb(
  db: Database.Database,
  functions: ExtractedFunction[],
  overrides: Map<string, string>,
): { inserted: number; titleCoverage: number; descCoverage: number } {
  if (functions.length === 0) return { inserted: 0, titleCoverage: 0, descCoverage: 0 };

  const pkg = functions[0].package;
  let hasTitles = 0;
  let hasDescs = 0;

  // Delete old stub + any existing entries for this package
  db.exec(`DELETE FROM search_docs WHERE package = '${pkg.replace(/'/g, "''")}'`);
  db.exec(`DELETE FROM functions WHERE package = '${pkg.replace(/'/g, "''")}'`);

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

      insertFn.run(id, fn.package, fn.function_name, fn.title, desc,
        safetyClass, fn.has_formula ? 1 : 0, fn.has_dots ? 1 : 0);

      const keywords = generateSearchKeywords(fn.package, fn.function_name);
      insertDoc.run(id, fn.package, fn.function_name, fn.title, desc, keywords);

      if (fn.title) hasTitles++;
      if (fn.description) hasDescs++;
    }
  });
  insertAll();

  // Update packages table — preserve installed state if already installed
  db.prepare(`
    UPDATE packages SET install_status = CASE
      WHEN installed = 1 THEN install_status
      ELSE 'tarball_indexed'
    END
    WHERE name = ?
  `).run(pkg);

  // Rebuild FTS5 for this package
  const escapedPkg = pkg.replace(/'/g, "''");
  db.exec(`
    DELETE FROM search_docs_fts WHERE rowid IN (
      SELECT rowid FROM search_docs WHERE package = '${escapedPkg}'
    )
  `);
  db.exec(`
    INSERT INTO search_docs_fts (rowid, package, name, title, description, task_views, search_keywords)
    SELECT rowid, package, name, title, description, '', search_keywords
    FROM search_docs WHERE package = '${escapedPkg}'
  `);

  return {
    inserted: functions.length,
    titleCoverage: functions.length > 0 ? hasTitles / functions.length : 0,
    descCoverage: functions.length > 0 ? hasDescs / functions.length : 0,
  };
}

// ---- Main -------------------------------------------------------------------

async function main() {
  console.log("=== StatTools Tarball Extraction Pipeline ===\n");

  mkdirSync(CACHE_DIR, { recursive: true });
  const manifest = loadManifest();
  const overrides = loadSafetyOverrides();

  // Phase A: Select packages
  const dbRO = new Database(DB_PATH, { readonly: true });
  const targets = selectTargetPackages(dbRO);
  dbRO.close();

  console.log(`Selected ${targets.length} packages for extraction\n`);
  if (targets.length === 0) return;

  // Phase B: Download tarballs (parallel batches of 15)
  console.log("Downloading tarballs...");
  const batchSize = 15;
  const extracted: Array<{ pkg: TargetPackage; dir: string }> = [];
  let downloadFailed = 0;

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (pkg) => {
        const dir = await downloadTarball(pkg, manifest);
        return { pkg, dir };
      }),
    );

    for (const r of results) {
      if (r.dir) {
        extracted.push({ pkg: r.pkg, dir: r.dir });
      } else {
        downloadFailed++;
        manifest.packages[r.pkg.name] = {
          version: r.pkg.version,
          extracted_at: new Date().toISOString(),
          status: "failed",
          functions_count: 0,
          title_coverage: 0,
          description_coverage: 0,
        };
      }
    }

    if (i + batchSize < targets.length) {
      process.stdout.write(`  ${Math.min(i + batchSize, targets.length)}/${targets.length} downloaded\r`);
    }
  }
  console.log(`  ${extracted.length} downloaded, ${downloadFailed} failed`);

  // Phase C: Extract functions (batch R invocations of 30)
  console.log("\nExtracting function metadata...");
  const rBatchSize = 30;
  const allFunctions = new Map<string, ExtractedFunction[]>();

  for (let i = 0; i < extracted.length; i += rBatchSize) {
    const batch = extracted.slice(i, i + rBatchSize);
    const dirs = batch.map((b) => b.dir);
    const functions = await extractFunctions(dirs);

    // Group by package
    for (const fn of functions) {
      if (!allFunctions.has(fn.package)) allFunctions.set(fn.package, []);
      allFunctions.get(fn.package)!.push(fn);
    }

    if (i + rBatchSize < extracted.length) {
      process.stdout.write(`  ${Math.min(i + rBatchSize, extracted.length)}/${extracted.length} extracted\r`);
    }
  }
  console.log(`  ${allFunctions.size} packages with functions, ${[...allFunctions.values()].reduce((s, a) => s + a.length, 0)} total functions`);

  // Phase D: Merge into SQLite
  console.log("\nMerging into database...");
  const dbRW = new Database(DB_PATH);
  dbRW.pragma("journal_mode = WAL");

  let totalInserted = 0;
  let packagesUpdated = 0;
  let lowTitleCoverage = 0;

  for (const [pkg, functions] of allFunctions) {
    const result = mergeIntoDb(dbRW, functions, overrides);
    totalInserted += result.inserted;
    packagesUpdated++;

    manifest.packages[pkg] = {
      version: targets.find((t) => t.name === pkg)?.version || "",
      extracted_at: new Date().toISOString(),
      status: "ok",
      functions_count: result.inserted,
      title_coverage: Math.round(result.titleCoverage * 100),
      description_coverage: Math.round(result.descCoverage * 100),
    };

    if (result.titleCoverage < 0.8) {
      lowTitleCoverage++;
    }
  }

  // Also mark packages with no man/ dir
  for (const t of targets) {
    if (!allFunctions.has(t.name) && !manifest.packages[t.name]?.status) {
      manifest.packages[t.name] = {
        version: t.version,
        extracted_at: new Date().toISOString(),
        status: "no_man",
        functions_count: 0,
        title_coverage: 0,
        description_coverage: 0,
      };
    }
  }

  dbRW.close();
  saveManifest(manifest);

  // Summary
  const totalFunctions = new Database(DB_PATH, { readonly: true })
    .prepare("SELECT COUNT(*) as c FROM functions").get() as { c: number };
  const totalStubs = new Database(DB_PATH, { readonly: true })
    .prepare("SELECT COUNT(*) as c FROM functions WHERE is_stub = 1").get() as { c: number };

  console.log("\n=== Extraction Complete ===");
  console.log(`  Packages processed: ${targets.length}`);
  console.log(`  Packages with functions: ${packagesUpdated}`);
  console.log(`  Download failures: ${downloadFailed}`);
  console.log(`  Functions inserted: ${totalInserted}`);
  console.log(`  Low title coverage (<80%): ${lowTitleCoverage}`);
  console.log(`  Total functions in DB: ${totalFunctions.c}`);
  console.log(`  Remaining stubs: ${totalStubs.c}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
