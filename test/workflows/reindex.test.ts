// ============================================================================
// StatTools — Incremental Reindex Tests
// ============================================================================
// Tests that reindexPackage() inserts functions into the DB and
// SearchEngine.refresh() makes them findable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { reindexPackage } from "../../src/search/incrementalReindex.js";
import { SearchEngine } from "../../src/search/searchEngine.js";
import { createTestServer, callTool, expectSuccess, type TestServer } from "../fixtures/common.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, unlinkSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/stattools.db");
const TEST_DB = resolve(__dirname, "../../data/stattools_reindex_test.db");

describe("Incremental Reindex", () => {
  let engine: SearchEngine;

  beforeAll(() => {
    // Copy production DB to test copy (so we don't modify the real one)
    copyFileSync(DB_PATH, TEST_DB);
    // Also copy WAL files if they exist
    if (existsSync(DB_PATH + "-wal")) copyFileSync(DB_PATH + "-wal", TEST_DB + "-wal");
    if (existsSync(DB_PATH + "-shm")) copyFileSync(DB_PATH + "-shm", TEST_DB + "-shm");
    engine = new SearchEngine(TEST_DB);
  });

  afterAll(() => {
    engine.close();
    // Clean up test DB
    try { unlinkSync(TEST_DB); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + "-wal"); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + "-shm"); } catch { /* ok */ }
  });

  it("reindexPackage extracts functions and makes them searchable after refresh", async () => {
    // Pick an installed package that's likely a stub in the current index.
    // 'jsonlite' is installed (used by R bridge) and has well-known functions.
    // First verify it's currently a stub or has limited entries.
    const beforeResults = engine.search({ query: "jsonlite toJSON", maxResults: 5 });
    const beforeIds = beforeResults.map((r) => r.functionId);
    const hadToJSON = beforeIds.includes("jsonlite::toJSON");

    // Reindex jsonlite into the test DB
    const result = await reindexPackage(TEST_DB, "jsonlite", "Rscript");

    expect(result.packageName).toBe("jsonlite");
    expect(result.functionsInserted).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);

    // Refresh the search engine to pick up new data
    engine.refresh();

    // Now search should find jsonlite functions
    const afterResults = engine.search({ query: "jsonlite toJSON", maxResults: 10 });
    const afterIds = afterResults.map((r) => r.functionId);
    expect(afterIds).toContain("jsonlite::toJSON");

    // Verify the function exists in the index
    expect(engine.functionExists("jsonlite", "toJSON")).toBe(true);

    // Metadata should be real (not stub) with non-empty title
    const meta = engine.getFunctionMeta("jsonlite", "toJSON");
    expect(meta).not.toBeNull();
    expect(meta!.isStub).toBe(false);
    expect(meta!.title.length).toBeGreaterThan(0);
    expect(meta!.description.length).toBeGreaterThan(0);
  }, 30000);

  it("reindexPackage returns 0 functions for nonexistent package", async () => {
    const result = await reindexPackage(TEST_DB, "nonexistent_pkg_xyz_99", "Rscript");
    expect(result.functionsInserted).toBe(0);
  }, 15000);

  it("reindexPackage applies safety overrides when available", async () => {
    // Reindex a package that has safety overrides (e.g., stats is already indexed,
    // but re-indexing should re-apply overrides)
    const result = await reindexPackage(TEST_DB, "stats", "Rscript");
    expect(result.functionsInserted).toBeGreaterThan(0);

    engine.refresh();

    const meta = engine.getFunctionMeta("stats", "lm");
    expect(meta).not.toBeNull();
    expect(meta!.safetyClass).toBe("safe"); // From safety_overrides.csv
  }, 30000);
});

// ---- Full MCP path: stat_install → reindex → stat_resolve ----

const E2E_DB = resolve(__dirname, "../../data/stattools_e2e_reindex.db");

describe("Install → Reindex → Resolve (full MCP path)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    // Copy production DB and stub broom in it.
    // broom::tidy has a safety override (safe), so after reindex + resolve it should work.
    copyFileSync(DB_PATH, E2E_DB);
    if (existsSync(DB_PATH + "-wal")) copyFileSync(DB_PATH + "-wal", E2E_DB + "-wal");
    if (existsSync(DB_PATH + "-shm")) copyFileSync(DB_PATH + "-shm", E2E_DB + "-shm");

    const db = new Database(E2E_DB);
    // Remove all real broom function entries, replace with a stub
    db.exec("DELETE FROM search_docs WHERE package = 'broom'");
    db.exec("DELETE FROM functions WHERE package = 'broom'");
    db.exec(`
      INSERT OR REPLACE INTO functions (id, package, name, title, description, safety_class, is_stub)
      VALUES ('broom::broom', 'broom', 'broom', 'Tidy model output', '', 'unclassified', 1)
    `);
    db.exec(`
      INSERT OR REPLACE INTO search_docs (function_id, package, name, title, description, search_keywords)
      VALUES ('broom::broom', 'broom', 'broom', 'Tidy model output', '', 'broom tidy')
    `);
    db.exec("DELETE FROM search_docs_fts WHERE rowid IN (SELECT rowid FROM search_docs WHERE package = 'broom')");
    db.exec(`
      INSERT INTO search_docs_fts (rowid, package, name, title, description, task_views, search_keywords)
      SELECT rowid, package, name, title, description, '', search_keywords
      FROM search_docs WHERE package = 'broom'
    `);
    db.close();

    // Create server with the stubbed DB
    ts = await createTestServer({ dbPath: E2E_DB });
  }, 20000);

  afterAll(async () => {
    await ts.cleanup();
    try { unlinkSync(E2E_DB); } catch { /* ok */ }
    try { unlinkSync(E2E_DB + "-wal"); } catch { /* ok */ }
    try { unlinkSync(E2E_DB + "-shm"); } catch { /* ok */ }
  });

  it("stat_install on already-installed package triggers reindex and makes functions resolvable", async () => {
    // 1. Verify broom::tidy is NOT resolvable (we stubbed it in beforeAll)
    const beforeResolve = await callTool(ts.server, "stat_resolve", {
      package: "broom",
      function: "tidy",
    });
    expect(beforeResolve.isError).toBe(true);

    // 2. Call stat_install — broom IS installed on host, so it should:
    //    - detect "already installed"
    //    - fire onInstallComplete → reindexPackage → searchEngine.refresh()
    const installResult = await callTool(ts.server, "stat_install", {
      package: "broom",
    });
    expect(installResult.isError).toBeFalsy();
    const installData = JSON.parse(installResult.content[0].text);
    expect(installData.status).toBe("already_installed");

    // 3. Wait for async reindex to complete (reindex takes ~300-500ms)
    await new Promise((r) => setTimeout(r, 3000));

    // 4. Now stat_resolve should succeed — broom::tidy is indexed and classified as "safe"
    const afterResolve = await callTool(ts.server, "stat_resolve", {
      package: "broom",
      function: "tidy",
    });
    expect(afterResolve.isError).toBeFalsy();
    const resolveData = JSON.parse(afterResolve.content[0].text);
    expect(resolveData.resolved).toBe(true);
    expect(resolveData.safety_class).toBe("safe");

    // 5. stat_search should also find it (not as a stub)
    const searchResult = await callTool(ts.server, "stat_search", {
      query: "broom tidy model",
      maxResults: 10,
    });
    const searchData = JSON.parse(searchResult.content[0].text);
    const found = searchData.results.find(
      (r: { id: string }) => r.id === "broom::tidy",
    );
    expect(found).toBeDefined();
    expect(found.is_stub).toBeFalsy();
  }, 30000);
});
