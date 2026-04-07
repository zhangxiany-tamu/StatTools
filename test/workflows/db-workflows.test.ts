// ============================================================================
// StatTools — Database Workflow Tests (Wave 4)
// ============================================================================
// DBI + RSQLite: connect, write, query, list tables, disconnect.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { unlinkSync } from "node:fs";
import {
  createTestServer, callTool, expectSuccess, parseResult, type TestServer,
} from "../fixtures/common.js";

const TEST_DB_PATH = "/tmp/stattools_test_workflow.sqlite";

describe("Database Workflows (Wave 4)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer({ allowedDataRoots: ["/tmp"] });
    // Write test CSV to /tmp (within allowed roots)
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/stattools_db_test.csv", "mpg,wt,hp,cyl\n21,2.62,110,6\n22.8,2.32,93,4\n21.4,3.215,110,6\n");
    try { unlinkSync(TEST_DB_PATH); } catch { /* ok */ }
  });

  afterAll(async () => {
    await ts.cleanup();
    try { unlinkSync(TEST_DB_PATH); } catch { /* ok */ }
  });

  it("DBI: connect → resolve query/list → safety-block write → disconnect", async (ctx) => {
    // 1. Load data to write
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: "/tmp/stattools_db_test.csv", name: "db_data" }));

    // 2. Resolve RSQLite::SQLite — skip if not installed
    const sqliteResolve = await callTool(ts.server, "stat_resolve", { package: "RSQLite", function: "SQLite" });
    if (sqliteResolve.isError) ctx.skip(); // RSQLite not installed
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "DBI", function: "dbConnect" }));

    // 3. Create SQLite driver
    const driver = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "RSQLite", function: "SQLite", args: {},
      assign_to: "drv",
    }));
    expect(driver.result).toBeDefined();

    // 4. Connect to database file
    const conn = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "DBI", function: "dbConnect",
      args: { drv: "drv", dbname: TEST_DB_PATH },
      assign_to: "con",
    }));
    expect(conn.result).toBeDefined();

    // 5. Write table — blocked by safety model (unsafe)
    const writeResolve = await callTool(ts.server, "stat_resolve", { package: "DBI", function: "dbWriteTable" });
    expect(writeResolve.isError).toBe(true);
    expect(parseResult(writeResolve).message).toContain("unsafe");

    // 6. Query — resolve succeeds (safe), then execute on the connection
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "DBI", function: "dbGetQuery" }));
    const query = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "DBI", function: "dbGetQuery",
      args: { conn: "con", statement: "SELECT 1 AS test_col" },
    }));
    expect(query.result).toBeDefined();

    // 7. List tables
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "DBI", function: "dbListTables" }));
    const tables = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "DBI", function: "dbListTables",
      args: { conn: "con" },
    }));
    expect(tables.result).toBeDefined();

    // 8. Disconnect
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "DBI", function: "dbDisconnect" }));
    const disc = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "DBI", function: "dbDisconnect",
      args: { conn: "con" },
    }));
    expect(disc.result).toBeDefined();
  }, 20000);
});
