// ============================================================================
// StatTools — Tarball Extraction Pipeline Test
// ============================================================================
// Tests that tarball_extractor.R produces valid NDJSON from a real CRAN
// tarball, and that the extracted functions are searchable after DB insertion.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync, unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SearchEngine } from "../../src/search/searchEngine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const EXTRACTOR = resolve(PROJECT_ROOT, "r", "tarball_extractor.R");
const DB_PATH = resolve(PROJECT_ROOT, "data", "stattools.db");
const TEST_DB = resolve(PROJECT_ROOT, "data", "stattools_tarball_test.db");
const TEMP_DIR = resolve(PROJECT_ROOT, "data", "tarball_test_tmp");

// Use a small, well-known CRAN package for testing
const TEST_PKG = "crayon";

describe("Tarball Extraction Pipeline", () => {
  let pkgVersion: string;
  let pkgDir: string;

  beforeAll(async () => {
    mkdirSync(TEMP_DIR, { recursive: true });

    // Get the package version from the DB
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare("SELECT version FROM packages WHERE name = ?").get(TEST_PKG) as
      { version: string } | undefined;
    db.close();

    if (!row?.version) {
      throw new Error(`Package ${TEST_PKG} not found in DB`);
    }
    pkgVersion = row.version;

    // Download the tarball
    const tarName = `${TEST_PKG}_${pkgVersion}.tar.gz`;
    const tarPath = resolve(TEMP_DIR, tarName);

    const urls = [
      `https://cran.r-project.org/src/contrib/${tarName}`,
      `https://cran.r-project.org/src/contrib/Archive/${TEST_PKG}/${tarName}`,
    ];

    let downloaded = false;
    for (const url of urls) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          writeFileSync(tarPath, Buffer.from(await resp.arrayBuffer()));
          downloaded = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!downloaded) throw new Error(`Failed to download ${TEST_PKG} tarball`);

    // Extract
    execFileSync("tar", ["xzf", tarPath, "-C", TEMP_DIR], { timeout: 10000 });
    pkgDir = resolve(TEMP_DIR, TEST_PKG);
  }, 30000);

  afterAll(() => {
    try { rmSync(TEMP_DIR, { recursive: true }); } catch { /* ok */ }
    try { unlinkSync(TEST_DB); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + "-wal"); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + "-shm"); } catch { /* ok */ }
  });

  it("tarball_extractor.R produces valid NDJSON with titles and descriptions", async () => {
    const proc = spawn("Rscript", ["--vanilla", EXTRACTOR, pkgDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    type Entry = { package: string; function_name: string; title: string; description: string };
    const entries: Entry[] = [];
    const rl = createInterface({ input: proc.stdout! });
    for await (const line of rl) {
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.package && obj.function_name) entries.push(obj);
      } catch { /* skip */ }
    }
    await new Promise<void>((r) => proc.on("exit", () => r()));

    // Should extract multiple functions
    expect(entries.length).toBeGreaterThan(0);

    // All should be from the correct package
    for (const e of entries) {
      expect(e.package).toBe(TEST_PKG);
    }

    // Title coverage should be high
    const withTitle = entries.filter((e) => e.title.length > 0);
    const titleRate = withTitle.length / entries.length;
    expect(titleRate).toBeGreaterThanOrEqual(0.8);

    // Description coverage should be high
    const withDesc = entries.filter((e) => e.description.length > 0);
    const descRate = withDesc.length / entries.length;
    expect(descRate).toBeGreaterThanOrEqual(0.5);
  }, 20000);

  it("extracted functions are searchable after DB insertion", async () => {
    // Copy production DB
    copyFileSync(DB_PATH, TEST_DB);
    if (existsSync(DB_PATH + "-wal")) copyFileSync(DB_PATH + "-wal", TEST_DB + "-wal");
    if (existsSync(DB_PATH + "-shm")) copyFileSync(DB_PATH + "-shm", TEST_DB + "-shm");

    // Run extractor
    const proc = spawn("Rscript", ["--vanilla", EXTRACTOR, pkgDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    type Entry = { package: string; function_name: string; title: string; description: string; has_formula: boolean; has_dots: boolean };
    const entries: Entry[] = [];
    const rl = createInterface({ input: proc.stdout! });
    for await (const line of rl) {
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.package && obj.function_name) entries.push(obj);
      } catch { /* skip */ }
    }
    await new Promise<void>((r) => proc.on("exit", () => r()));

    // Insert into test DB (same merge logic as extract-tarballs.ts)
    const db = new Database(TEST_DB);
    db.pragma("journal_mode = WAL");

    const pkg = TEST_PKG;
    const escapedPkg = pkg.replace(/'/g, "''");
    db.exec(`DELETE FROM search_docs WHERE package = '${escapedPkg}'`);
    db.exec(`DELETE FROM functions WHERE package = '${escapedPkg}'`);

    const insertFn = db.prepare(
      "INSERT OR REPLACE INTO functions (id, package, name, title, description, safety_class, has_formula_arg, has_dots, is_stub) VALUES (?, ?, ?, ?, ?, 'unclassified', ?, ?, 0)",
    );
    const insertDoc = db.prepare(
      "INSERT OR REPLACE INTO search_docs (function_id, package, name, title, description, search_keywords) VALUES (?, ?, ?, ?, ?, ?)",
    );

    db.transaction(() => {
      for (const fn of entries) {
        const id = `${fn.package}::${fn.function_name}`;
        insertFn.run(id, fn.package, fn.function_name, fn.title, fn.description.slice(0, 500), fn.has_formula ? 1 : 0, fn.has_dots ? 1 : 0);
        insertDoc.run(id, fn.package, fn.function_name, fn.title, fn.description.slice(0, 500), `${fn.function_name} ${fn.package}`);
      }
    })();

    db.exec(`DELETE FROM search_docs_fts WHERE rowid IN (SELECT rowid FROM search_docs WHERE package = '${escapedPkg}')`);
    db.exec(`INSERT INTO search_docs_fts (rowid, package, name, title, description, task_views, search_keywords) SELECT rowid, package, name, title, description, '', search_keywords FROM search_docs WHERE package = '${escapedPkg}'`);
    db.close();

    // Verify searchability
    const engine = new SearchEngine(TEST_DB);
    const results = engine.search({ query: TEST_PKG, maxResults: 10 });
    const pkgResults = results.filter((r) => r.package === TEST_PKG);
    expect(pkgResults.length).toBeGreaterThan(0);
    expect(pkgResults[0].isStub).toBe(false);
    engine.close();
  }, 30000);
});
