import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SearchEngine } from "../../src/search/searchEngine.js";
import { WorkerPool } from "../../src/engine/workerPool.js";
import { createSessionStore, type SessionStore } from "../../src/engine/session.js";
import { executeStatResolve } from "../../src/tools/statResolve.js";
import { executeStatSearch } from "../../src/tools/statSearch.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/stattools.db");

describe("stat_resolve", () => {
  let engine: SearchEngine;
  let pool: WorkerPool;
  let session: SessionStore;

  beforeAll(async () => {
    engine = new SearchEngine(DB_PATH);
    session = createSessionStore("resolve_test");
    pool = new WorkerPool(session);
    await pool.start();
  });

  afterAll(async () => {
    engine.close();
    await pool.stop();
  });

  it("resolves stats::lm with full schema", async () => {
    const result = await executeStatResolve(
      { package: "stats", function: "lm" },
      engine,
      pool,
      session,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.resolved).toBe(true);
    expect(data.safety_class).toBe("safe");
    expect(data.schema).toBeDefined();
    expect(data.schema.properties).toBeDefined();
    expect(data.has_formula).toBe(true);
  });

  it("rejects nonexistent function", async () => {
    const result = await executeStatResolve(
      { package: "stats", function: "nonexistent_fn" },
      engine,
      pool,
      session,
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("not found");
  });

  it("rejects unsafe function (utils::install.packages)", async () => {
    const result = await executeStatResolve(
      { package: "utils", function: "install.packages" },
      engine,
      pool,
      session,
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("unsafe");
  });

  it("rejects unclassified function", async () => {
    // Find an unclassified function
    const result = await executeStatResolve(
      { package: "stats", function: "asOneSidedFormula" },
      engine,
      pool,
      session,
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("not been reviewed");
  });

  it("registers resolved function in session", async () => {
    // Resolve t.test
    await executeStatResolve(
      { package: "stats", function: "t.test" },
      engine,
      pool,
      session,
    );

    // Check session state
    const state = session.getState();
    expect(state.resolvedFunctions.has("stats::t.test")).toBe(true);
  });
});

describe("stat_search", () => {
  let engine: SearchEngine;

  beforeAll(() => {
    engine = new SearchEngine(DB_PATH);
  });

  afterAll(() => {
    engine.close();
  });

  it("returns results with next_step guidance", () => {
    const result = executeStatSearch(
      { query: "linear regression" },
      engine,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.next_step).toContain("stat_resolve");
  });

  it("returns empty message for nonsense query", () => {
    const result = executeStatSearch(
      { query: "qzxjvmkwplfnhgbtdy" },
      engine,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(0);
    expect(data.message).toContain("No matching");
  });

  it("rejects empty query", () => {
    const result = executeStatSearch(
      { query: "" },
      engine,
    );

    expect(result.isError).toBe(true);
  });

  it("ranks callable functions above unclassified for 'linear regression'", () => {
    const result = executeStatSearch(
      { query: "linear regression", max_results: 10 },
      engine,
    );

    const data = JSON.parse(result.content[0].text);
    const results = data.results as Array<{ id: string; safety_class: string }>;

    // stats::lm (safe) must appear in top 5
    const lmIdx = results.findIndex((r) => r.id === "stats::lm");
    expect(lmIdx).toBeGreaterThanOrEqual(0);
    expect(lmIdx).toBeLessThan(5);

    // At least some callable results should appear
    const callableCount = results.filter(
      (r) => r.safety_class === "safe" || r.safety_class === "callable_with_caveats",
    ).length;
    expect(callableCount).toBeGreaterThan(0);

    // The first callable result should appear within the top 5
    const firstCallable = results.findIndex(
      (r) => r.safety_class === "safe" || r.safety_class === "callable_with_caveats",
    );
    expect(firstCallable).toBeLessThan(5);
  });

  it("reports callable_count in results", () => {
    const result = executeStatSearch(
      { query: "t test" },
      engine,
    );

    const data = JSON.parse(result.content[0].text);
    expect(typeof data.callable_count).toBe("number");
    expect(data.callable_count).toBeGreaterThan(0);
  });
});
