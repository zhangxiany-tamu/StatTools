#!/usr/bin/env tsx
// ============================================================================
// StatTools — Build SQLite Index (Phase 2: Full CRAN)
// ============================================================================
// Sources:
//   1. PACKAGES.gz from CRAN — all 23k+ packages (name, version, title, deps)
//   2. cranlogs.r-pkg.org — monthly download counts
//   3. CRAN Task Views from GitHub — 56 category → package mappings
//   4. r/schema_extractor.R — function metadata for INSTALLED packages
//   5. data/safety_overrides.csv — curated safety classifications
//
// Usage:
//   npx tsx scripts/build-index.ts              # Full build
//   npx tsx scripts/build-index.ts --local-only # Only installed packages (fast)
// ============================================================================

import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";

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
const EXTRACTOR_SCRIPT = resolve(PROJECT_ROOT, "r", "schema_extractor.R");
const CRAN_PACKAGES_URL = "https://cran.r-project.org/src/contrib/PACKAGES.gz";
const CRANLOGS_API = "https://cranlogs.r-pkg.org/downloads/total/last-month";
const TASK_VIEWS_API = "https://raw.githubusercontent.com/cran-task-views/ctv/main";

const localOnly = process.argv.includes("--local-only");

// ---- Schema ----------------------------------------------------------------

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS packages (
    name TEXT PRIMARY KEY,
    version TEXT,
    title TEXT,
    description TEXT,
    task_views TEXT DEFAULT '[]',
    downloads_monthly INTEGER DEFAULT 0,
    reverse_deps INTEGER DEFAULT 0,
    installed BOOLEAN DEFAULT 0,
    install_status TEXT DEFAULT 'not_attempted',
    last_updated TEXT
  );

  CREATE TABLE IF NOT EXISTS functions (
    id TEXT PRIMARY KEY,
    package TEXT,
    name TEXT,
    title TEXT,
    description TEXT,
    safety_class TEXT DEFAULT 'unclassified',
    typical_return_class TEXT,
    has_formula_arg BOOLEAN DEFAULT 0,
    has_dots BOOLEAN DEFAULT 0,
    caveats TEXT DEFAULT '[]',
    schema_cached BOOLEAN DEFAULT 0,
    is_stub BOOLEAN DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS search_docs (
    function_id TEXT PRIMARY KEY REFERENCES functions(id),
    package TEXT,
    name TEXT,
    title TEXT,
    description TEXT,
    task_views TEXT DEFAULT '',
    search_keywords TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS safety_overrides (
    function_id TEXT PRIMARY KEY,
    safety_class TEXT,
    reason TEXT,
    reviewed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_functions_package ON functions(package);
  CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
`;

const CREATE_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts USING fts5(
    package, name, title, description, task_views, search_keywords,
    content=search_docs,
    content_rowid=rowid,
    tokenize='porter unicode61'
  );
`;

// ---- 1. CRAN PACKAGES.gz --------------------------------------------------

type CranPackage = {
  name: string;
  version: string;
  title: string;
  description: string;
  depends: string;
  imports: string;
};

const CRAN_METADATA_SCRIPT = resolve(PROJECT_ROOT, "r", "cran_metadata.R");

async function fetchCranPackages(): Promise<CranPackage[]> {
  // Use R's tools::CRAN_package_db() via streaming NDJSON script
  console.log("  Fetching full CRAN package database via R (streaming NDJSON)...");

  const proc = spawn("Rscript", ["--vanilla", CRAN_METADATA_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const packages: CranPackage[] = [];
  const rl = createInterface({ input: proc.stdout! });

  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line) as CranPackage;
      if (entry.name) packages.push(entry);
    } catch { /* skip */ }
  }

  await new Promise<void>((resolve) => proc.on("exit", () => resolve()));

  return packages;
}

// ---- 2. cranlogs download counts -------------------------------------------

async function fetchDownloadCounts(
  packageNames: string[],
): Promise<Map<string, number>> {
  console.log(`  Fetching download counts for ${packageNames.length} packages...`);
  const counts = new Map<string, number>();

  // cranlogs API supports batch queries: /downloads/total/last-month/pkg1,pkg2,...
  // But with a limit of ~100 per request
  const batchSize = 100;
  for (let i = 0; i < packageNames.length; i += batchSize) {
    const batch = packageNames.slice(i, i + batchSize);
    const url = `${CRANLOGS_API}/${batch.join(",")}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;

      const data = await resp.json();

      // Response is array for multi-package, object for single
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        if (entry.package && entry.downloads != null) {
          counts.set(entry.package, entry.downloads);
        }
      }
    } catch {
      // Skip batch on error
    }

    // Brief pause to be nice to the API
    if (i + batchSize < packageNames.length) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if ((i / batchSize) % 10 === 0 && i > 0) {
      console.log(`    ... ${i}/${packageNames.length} packages fetched`);
    }
  }

  return counts;
}

// ---- 3. CRAN Task Views ----------------------------------------------------

const TASK_VIEW_NAMES = [
  "Bayesian", "CausalInference", "ChemPhys", "ClinicalTrials", "Cluster",
  "Databases", "DifferentialEquations", "Distributions", "Econometrics",
  "Environmetrics", "ExperimentalDesign", "ExtremeValue", "Finance",
  "FunctionalData", "GraphicalModels", "HighPerformanceComputing", "Hydrology",
  "MachineLearning", "MedicalImaging", "MetaAnalysis", "MissingData",
  "MixedModels", "ModelDeployment", "NaturalLanguageProcessing",
  "NumericalMathematics", "OfficialStatistics", "Optimization",
  "Pharmacokinetics", "Phylogenetics", "Psychometrics", "ReproducibleResearch",
  "Robust", "Spatial", "SpatioTemporal", "SportsAnalytics", "Survival",
  "TeachingStatistics", "TimeSeries", "Tracking", "WebTechnologies",
];

async function fetchTaskViews(): Promise<Map<string, string[]>> {
  console.log("  Fetching CRAN Task Views...");
  const pkgToViews = new Map<string, string[]>();

  for (const viewName of TASK_VIEW_NAMES) {
    try {
      const url = `https://raw.githubusercontent.com/cran-task-views/${viewName}/HEAD/${viewName}.md`;
      const resp = await fetch(url);
      if (!resp.ok) continue;

      const text = await resp.text();
      // Extract package names from pkg("pkgname") calls in markdown
      const pkgPattern = /pkg\("([^"]+)"/g;
      let match;
      while ((match = pkgPattern.exec(text)) !== null) {
        const pkg = match[1];
        const existing = pkgToViews.get(pkg) || [];
        if (!existing.includes(viewName)) {
          existing.push(viewName);
          pkgToViews.set(pkg, existing);
        }
      }
    } catch {
      // Skip view on error
    }
  }

  return pkgToViews;
}

// ---- 4. Local function extraction ------------------------------------------

async function extractLocalFunctions(
  packages?: string[],
): Promise<
  Array<{
    package: string;
    function_name: string;
    title: string;
    description: string;
    has_formula: boolean;
    has_dots: boolean;
  }>
> {
  const args = ["--vanilla", EXTRACTOR_SCRIPT, ...(packages || [])];
  const proc = spawn("Rscript", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const results: Array<{
    package: string;
    function_name: string;
    title: string;
    description: string;
    has_formula: boolean;
    has_dots: boolean;
  }> = [];

  const rl = createInterface({ input: proc.stdout! });
  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.package && entry.function_name) {
        results.push(entry);
      }
    } catch { /* skip */ }
  }

  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
  });

  return results;
}

// ---- 5. Safety overrides ---------------------------------------------------

function loadSafetyOverrides(db: Database.Database): number {
  const csvPath = resolve(PROJECT_ROOT, "data", "safety_overrides.csv");
  if (!existsSync(csvPath)) return 0;

  const lines = readFileSync(csvPath, "utf-8").trim().split("\n");
  if (!lines[0]?.includes("function_id")) return 0;

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO safety_overrides (function_id, safety_class, reason, reviewed_at) VALUES (?, ?, ?, ?)",
  );

  let count = 0;
  for (const line of lines.slice(1)) {
    const [functionId, safetyClass, reason] = line.split(",").map((s) => s.trim());
    if (functionId && safetyClass) {
      stmt.run(functionId, safetyClass, reason || "", new Date().toISOString());
      count++;
    }
  }

  db.exec(`
    UPDATE functions SET safety_class = (
      SELECT safety_class FROM safety_overrides WHERE safety_overrides.function_id = functions.id
    ) WHERE id IN (SELECT function_id FROM safety_overrides)
  `);

  return count;
}

// ---- Search keywords -------------------------------------------------------

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

// ---- Main ------------------------------------------------------------------

async function main() {
  console.log("=== StatTools Index Builder (Phase 2) ===\n");
  mkdirSync(resolve(PROJECT_ROOT, "data"), { recursive: true });

  if (existsSync(DB_PATH)) {
    console.log(`Removing existing database`);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(DB_PATH);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = OFF"); // Some installed packages (Bioconductor) aren't in CRAN

  console.log("1. Creating tables...");
  db.exec(CREATE_TABLES);
  db.exec(CREATE_FTS);

  // ---- Step 2: Package metadata ----
  let allPackageNames: string[];

  if (localOnly) {
    console.log("2. Extracting package metadata from R (local-only mode)...");
    const output = execFileSync("Rscript", ["--vanilla", "-e", `
      pkgs <- installed.packages()
      for (i in seq_len(nrow(pkgs))) {
        p <- pkgs[i,]
        desc <- tryCatch(packageDescription(p["Package"]), error = function(e) list())
        cat(jsonlite::toJSON(list(
          name = unname(p["Package"]),
          version = unname(p["Version"]),
          title = desc$Title %||% "",
          description = desc$Description %||% ""
        ), auto_unbox = TRUE), "\\n")
      }
      \\\`%||%\\\` <- function(a, b) if (is.null(a)) b else a
    `], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 120000 });

    const localPkgs = output.trim().split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as Array<{ name: string; version: string; title: string; description: string }>;

    const insertPkg = db.prepare(
      "INSERT OR REPLACE INTO packages (name, version, title, description, installed, install_status) VALUES (?, ?, ?, ?, 1, 'installed')",
    );
    db.transaction(() => {
      for (const p of localPkgs) insertPkg.run(p.name, p.version, p.title || "", p.description || "");
    })();
    allPackageNames = localPkgs.map((p) => p.name);
    console.log(`   ${localPkgs.length} installed packages`);
  } else {
    console.log("2. Fetching all CRAN packages...");
    const cranPackages = await fetchCranPackages();
    console.log(`   ${cranPackages.length} packages from CRAN`);

    // Get installed packages to mark them
    const installedOutput = execFileSync("Rscript", ["--vanilla", "-e",
      'cat(paste(installed.packages()[,"Package"], collapse="\\n"))'],
      { encoding: "utf-8", timeout: 30000 });
    const installedSet = new Set(installedOutput.trim().split("\n"));
    console.log(`   ${installedSet.size} packages installed locally`);

    const insertPkg = db.prepare(
      "INSERT OR REPLACE INTO packages (name, version, title, description, installed, install_status) VALUES (?, ?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (const p of cranPackages) {
        const isInstalled = installedSet.has(p.name);
        insertPkg.run(
          p.name, p.version, p.title, p.description,
          isInstalled ? 1 : 0,
          isInstalled ? "installed" : "not_attempted",
        );
      }
      // Also insert installed packages not in CRAN (base R, Bioconductor, etc.)
      // Get their metadata in one batch R call
      const nonCranInstalled = [...installedSet].filter(
        (name) => !cranPackages.some((p) => p.name === name),
      );
      if (nonCranInstalled.length > 0) {
        try {
          const pkgList = nonCranInstalled.map((n) => `"${n}"`).join(",");
          const out = execFileSync("Rscript", ["--vanilla", "-e", `
            library(jsonlite)
            nco <- function(a, b) if (is.null(a) || is.na(a)) b else a
            for (pkg in c(${pkgList})) {
              d <- tryCatch(packageDescription(pkg), error=function(e) list())
              cat(toJSON(list(name=pkg, version=nco(d$Version,""), title=nco(d$Title,""), description=nco(d$Description,"")), auto_unbox=TRUE), "\\n")
            }
          `], { encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 });

          for (const line of out.trim().split("\n")) {
            if (!line.startsWith("{")) continue;
            try {
              const p = JSON.parse(line) as { name: string; version: string; title: string; description: string };
              insertPkg.run(p.name, p.version, p.title, p.description, 1, "installed");
            } catch { /* skip */ }
          }
        } catch {
          // Fallback: insert with empty metadata
          for (const name of nonCranInstalled) {
            insertPkg.run(name, "", "", "", 1, "installed");
          }
        }
      }
    })();
    allPackageNames = [...new Set([...cranPackages.map((p) => p.name), ...installedSet])];

    // ---- Step 2b: Download counts ----
    console.log("3. Fetching download counts from cranlogs...");
    const downloads = await fetchDownloadCounts(allPackageNames);
    console.log(`   Got counts for ${downloads.size} packages`);

    const updateDl = db.prepare("UPDATE packages SET downloads_monthly = ? WHERE name = ?");
    db.transaction(() => {
      for (const [name, count] of downloads) updateDl.run(count, name);
    })();

    // ---- Step 2c: Task Views ----
    console.log("4. Fetching CRAN Task Views...");
    const taskViews = await fetchTaskViews();
    console.log(`   ${taskViews.size} packages classified into Task Views`);

    const updateTv = db.prepare("UPDATE packages SET task_views = ? WHERE name = ?");
    db.transaction(() => {
      for (const [name, views] of taskViews) updateTv.run(JSON.stringify(views), name);
    })();

    // ---- Step 2d: Reverse deps ----
    console.log("5. Computing reverse dependencies...");
    const revDeps = new Map<string, number>();
    for (const p of cranPackages) {
      const deps = (p.depends + "," + p.imports)
        .split(",")
        .map((d) => d.trim().replace(/\s*\(.*\)/, ""))
        .filter((d) => d && d !== "R");
      for (const dep of deps) {
        revDeps.set(dep, (revDeps.get(dep) || 0) + 1);
      }
    }
    const updateRd = db.prepare("UPDATE packages SET reverse_deps = ? WHERE name = ?");
    db.transaction(() => {
      for (const [name, count] of revDeps) updateRd.run(count, name);
    })();
  }

  // ---- Step 3: Function extraction (installed packages only) ----
  const stepNum = localOnly ? 3 : 6;
  console.log(`${stepNum}. Extracting function metadata from installed packages...`);
  const functions = await extractLocalFunctions();
  console.log(`   ${functions.length} functions extracted`);

  const insertFn = db.prepare(
    "INSERT OR REPLACE INTO functions (id, package, name, title, description, has_formula_arg, has_dots) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSearchDoc = db.prepare(
    "INSERT OR REPLACE INTO search_docs (function_id, package, name, title, description, task_views, search_keywords) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  db.transaction(() => {
    for (const fn of functions) {
      const id = `${fn.package}::${fn.function_name}`;
      insertFn.run(id, fn.package, fn.function_name, fn.title, fn.description,
        fn.has_formula ? 1 : 0, fn.has_dots ? 1 : 0);

      const pkgRow = db.prepare("SELECT task_views FROM packages WHERE name = ?")
        .get(fn.package) as { task_views: string } | undefined;

      insertSearchDoc.run(id, fn.package, fn.function_name, fn.title, fn.description,
        pkgRow?.task_views || "", generateSearchKeywords(fn.package, fn.function_name));
    }
  })();

  // ---- Step: Python function extraction ----
  const pyStep = localOnly ? 4 : 7;
  const pythonPath = process.env.PYTHON_PATH || "python3";
  console.log(`${pyStep}. Extracting Python function metadata...`);
  console.log(`   Using Python: ${pythonPath}`);
  const pyExtractor = resolve(PROJECT_ROOT, "py", "schema_extractor.py");
  const pyFunctions = await (async () => {
    const proc = spawn(pythonPath, [pyExtractor], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const results: typeof functions = [];
    const rl = createInterface({ input: proc.stdout! });
    for await (const line of rl) {
      if (!line.startsWith("{")) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.package && entry.function_name) results.push(entry);
      } catch { /* skip */ }
    }
    await new Promise<void>((r) => proc.on("exit", () => r()));
    return results;
  })();
  console.log(`   ${pyFunctions.length} Python functions extracted`);
  if (pyFunctions.length === 0) {
    console.log(`   WARNING: 0 Python functions extracted. Ensure ${pythonPath} has sklearn, scipy, statsmodels, pandas installed.`);
    console.log(`   Set PYTHON_PATH to a Python with data science packages (e.g., PYTHON_PATH=/path/to/anaconda3/bin/python3)`);
  }

  // Insert Python functions with py:: prefix, classified as callable_with_caveats
  // (curated in schema_extractor.py — not arbitrary PyPI)
  const insertFnPy = db.prepare(
    "INSERT OR REPLACE INTO functions (id, package, name, title, description, has_formula_arg, has_dots, safety_class) VALUES (?, ?, ?, ?, ?, ?, ?, 'callable_with_caveats')",
  );
  db.transaction(() => {
    for (const fn of pyFunctions) {
      const id = `py::${fn.package}::${fn.function_name}`;
      insertFnPy.run(id, fn.package, fn.function_name, fn.title, fn.description,
        fn.has_formula ? 1 : 0, fn.has_dots ? 1 : 0);
      insertSearchDoc.run(id, fn.package, fn.function_name, fn.title, fn.description,
        "", generateSearchKeywords(fn.package, fn.function_name) + " python sklearn scipy pandas numpy statsmodels");
    }
  })();

  // ---- For non-installed CRAN packages: create stub functions from package title ----
  if (!localOnly) {
    console.log("8. Creating stub entries for non-installed packages...");
    // For packages not installed, we don't have function-level data yet.
    // Create one stub entry per package so it's at least searchable by package name/title.
    const nonInstalledPkgs = db.prepare(
      `SELECT name, title, description, task_views FROM packages
       WHERE installed = 0 AND name NOT IN (SELECT DISTINCT package FROM functions)`,
    ).all() as Array<{ name: string; title: string; description: string; task_views: string }>;

    const insertStub = db.prepare(
      "INSERT OR IGNORE INTO functions (id, package, name, title, description, is_stub) VALUES (?, ?, ?, ?, ?, 1)",
    );
    const insertStubDoc = db.prepare(
      "INSERT OR IGNORE INTO search_docs (function_id, package, name, title, description, task_views, search_keywords) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    db.transaction(() => {
      for (const pkg of nonInstalledPkgs) {
        // Use package name as a pseudo-function so it's searchable
        const id = `${pkg.name}::${pkg.name}`;
        insertStub.run(id, pkg.name, pkg.name, pkg.title, pkg.description);
        insertStubDoc.run(id, pkg.name, pkg.name, pkg.title, pkg.description,
          pkg.task_views || "", generateSearchKeywords(pkg.name, pkg.name));
      }
    })();
    console.log(`   ${nonInstalledPkgs.length} stub entries created`);
  }

  // ---- Safety overrides ----
  const safetyStep = localOnly ? 4 : 8;
  console.log(`${safetyStep}. Applying safety overrides...`);
  const overrideCount = loadSafetyOverrides(db);
  console.log(`   ${overrideCount} overrides applied`);

  // ---- Rebuild FTS ----
  const ftsStep = localOnly ? 5 : 9;
  console.log(`${ftsStep}. Rebuilding FTS5 index...`);
  db.exec("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')");

  // ---- Stats ----
  const pkgCount = (db.prepare("SELECT COUNT(*) as c FROM packages").get() as { c: number }).c;
  const fnCount = (db.prepare("SELECT COUNT(*) as c FROM functions").get() as { c: number }).c;
  const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM search_docs").get() as { c: number }).c;
  const installedCount = (db.prepare("SELECT COUNT(*) as c FROM packages WHERE installed = 1").get() as { c: number }).c;
  const dlCount = (db.prepare("SELECT COUNT(*) as c FROM packages WHERE downloads_monthly > 0").get() as { c: number }).c;
  const tvCount = (db.prepare("SELECT COUNT(*) as c FROM packages WHERE task_views != '[]' AND task_views != ''").get() as { c: number }).c;

  console.log(`\n=== Index Built ===`);
  console.log(`  Packages: ${pkgCount} (${installedCount} installed)`);
  console.log(`  Functions: ${fnCount}`);
  console.log(`  Search docs: ${ftsCount}`);
  console.log(`  With download counts: ${dlCount}`);
  console.log(`  With Task Views: ${tvCount}`);
  console.log(`  Database: ${DB_PATH}`);

  // Sanity check
  const testResult = db.prepare(
    `SELECT sd.function_id, bm25(search_docs_fts) as score
     FROM search_docs_fts fts
     JOIN search_docs sd ON sd.rowid = fts.rowid
     WHERE search_docs_fts MATCH 'linear regression'
     ORDER BY bm25(search_docs_fts) ASC LIMIT 5`,
  ).all() as Array<{ function_id: string; score: number }>;
  console.log(`\n  Sanity check: "linear regression" →`);
  for (const r of testResult) {
    console.log(`    ${r.function_id} (bm25: ${r.score.toFixed(4)})`);
  }

  db.close();
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
