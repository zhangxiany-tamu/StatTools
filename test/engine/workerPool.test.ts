import { describe, it, expect, afterEach } from "vitest";
import { WorkerPool } from "../../src/engine/workerPool.js";
import {
  createSessionStore,
  registerHandle,
} from "../../src/engine/session.js";
import { writeFileSync, unlinkSync } from "node:fs";

const TEST_CSV = "/tmp/stattools_test_mtcars.csv";

// Create test CSV before tests
function ensureTestCsv() {
  try {
    writeFileSync(
      TEST_CSV,
      "mpg,wt,hp\n21,2.62,110\n22.8,2.32,93\n21.4,3.215,110\n18.7,3.44,175\n",
    );
  } catch {
    // ignore
  }
}

describe("WorkerPool", () => {
  let pool: WorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.stop();
      pool = null;
    }
  });

  it("starts with active + standby workers", async () => {
    ensureTestCsv();
    const session = createSessionStore("test_001");
    pool = new WorkerPool(session);
    await pool.start();

    const status = pool.getStatus();
    expect(status.activeWorkerId).toBeTruthy();
    expect(status.standbyReady).toBe(true);
    expect(status.activeCallCount).toBe(0);
  });

  it("executes list_objects on fresh session", async () => {
    const session = createSessionStore("test_002");
    pool = new WorkerPool(session);
    await pool.start();

    const resp = await pool.call("list_objects", {});
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();

    const result = resp.result as Record<string, unknown>;
    expect(result.r_version).toBeTruthy();
  });

  it("loads CSV data and creates handle", async () => {
    ensureTestCsv();
    const session = createSessionStore("test_003");
    pool = new WorkerPool(session);
    await pool.start();

    const resp = await pool.call("load_data", {
      file_path: TEST_CSV,
      name: "data_1",
    });

    expect(resp.error).toBeUndefined();
    expect(resp.objectsCreated).toBeDefined();
    expect(resp.objectsCreated!.length).toBe(1);
    expect(resp.objectsCreated![0].id).toBe("data_1");

    const result = resp.result as Record<string, unknown>;
    const dims = result.dimensions as Record<string, number>;
    expect(dims.rows).toBe(4);
    expect(dims.cols).toBe(3);
  });

  it("runs lm() end-to-end: load → fit → structured output", async () => {
    ensureTestCsv();
    const session = createSessionStore("test_004");
    pool = new WorkerPool(session);
    await pool.start();

    // Load data
    const loadResp = await pool.call("load_data", {
      file_path: TEST_CSV,
      name: "data_1",
    });
    expect(loadResp.error).toBeUndefined();

    if (loadResp.objectsCreated) {
      for (const obj of loadResp.objectsCreated) {
        registerHandle(
          session,
          obj,
          pool.getStatus().activeWorkerId!,
          "stat_load_data",
        );
      }
    }

    // Fit model
    const lmResp = await pool.call("call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt + hp", data: "data_1" },
    });

    expect(lmResp.error).toBeUndefined();
    expect(lmResp.objectsCreated).toBeDefined();

    const lmResult = lmResp.result as Record<string, unknown>;
    expect(lmResult.class).toBe("lm");
    expect(typeof lmResult.r_squared).toBe("number");
    expect(lmResult.coefficients).toBeDefined();
  });

  it("returns structured error for missing object reference", async () => {
    const session = createSessionStore("test_005");
    pool = new WorkerPool(session);
    await pool.start();

    const resp = await pool.call("call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt", data: "nonexistent_data" },
    });

    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(4);
    expect(resp.error!.message).toContain("not found");
  });

  it("returns structured error for nonexistent function", async () => {
    const session = createSessionStore("test_006");
    pool = new WorkerPool(session);
    await pool.start();

    const resp = await pool.call("call", {
      package: "stats",
      function: "nonexistent_function",
      args: {},
    });

    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(2);
  });

  it("extracts schema with required as array", async () => {
    const session = createSessionStore("test_007");
    pool = new WorkerPool(session);
    await pool.start();

    const resp = await pool.call("schema", {
      package: "stats",
      function: "t.test",
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as Record<string, unknown>;
    const schema = result.schema as Record<string, unknown>;
    // required should always be an array, even with 1 element
    expect(Array.isArray(schema.required)).toBe(true);
  });

  it("loads data with custom name and resolves it in lm()", async () => {
    ensureTestCsv();
    const session = createSessionStore("test_008");
    pool = new WorkerPool(session);
    await pool.start();

    // Load with custom name (not data_1 pattern)
    const loadResp = await pool.call("load_data", {
      file_path: TEST_CSV,
      name: "my_cars",
    });
    expect(loadResp.error).toBeUndefined();

    // Use custom name in lm — this was the bug: only data_# was resolved
    const lmResp = await pool.call("call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt", data: "my_cars" },
    });

    expect(lmResp.error).toBeUndefined();
    const lmResult = lmResp.result as Record<string, unknown>;
    expect(lmResult.class).toBe("lm");
  });

  it("recycles worker and preserves serializable handles", async () => {
    ensureTestCsv();
    const session = createSessionStore("test_recycle");
    // Set recycleAfterCalls very low to trigger recycle
    pool = new WorkerPool(session, { recycleAfterCalls: 3 });
    await pool.start();

    const initialWorkerId = pool.getStatus().activeWorkerId;

    // Call 1: load data
    const loadResp = await pool.call("load_data", {
      file_path: TEST_CSV,
      name: "data_1",
    });
    expect(loadResp.error).toBeUndefined();
    if (loadResp.objectsCreated) {
      for (const obj of loadResp.objectsCreated) {
        registerHandle(session, obj, pool.getStatus().activeWorkerId!, "load");
      }
    }

    // Call 2: fit model
    const lmResp = await pool.call("call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt", data: "data_1" },
    });
    expect(lmResp.error).toBeUndefined();
    if (lmResp.objectsCreated) {
      for (const obj of lmResp.objectsCreated) {
        registerHandle(session, obj, pool.getStatus().activeWorkerId!, "lm");
      }
    }

    // Verify handles exist before recycle
    expect(session.getState().handles.size).toBe(2);

    // Call 3: callCount now at 3, recycle triggers on next call
    await pool.call("list_objects", {});

    // Call 4: this triggers recycle (shouldRecycle sees callCount >= 3)
    const listResp = await pool.call("list_objects", {});
    expect(listResp.error).toBeUndefined();

    // After recycle: worker ID should have changed
    const newWorkerId = pool.getStatus().activeWorkerId;
    expect(newWorkerId).not.toBe(initialWorkerId);

    // Serializable handles should survive
    const handles = session.getState().handles;
    expect(handles.has("data_1")).toBe(true);

    // data_1 should be usable in the new worker
    const verifyResp = await pool.call("call", {
      package: "base",
      function: "nrow",
      args: { x: "data_1" },
    });
    expect(verifyResp.error).toBeUndefined();
  }, 15000);

  it("does not log crash on clean stop()", async () => {
    const session = createSessionStore("test_clean_stop");
    pool = new WorkerPool(session);

    const crashMessages: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      crashMessages.push(args.join(" "));
    };

    try {
      await pool.start();
      await pool.call("list_objects", {});
      await pool.stop();
      pool = null; // Prevent afterEach from double-stopping

      // No crash messages should have been logged
      const workerCrashMessages = crashMessages.filter((m) =>
        m.includes("crashed"),
      );
      expect(workerCrashMessages).toHaveLength(0);
    } finally {
      console.error = origConsoleError;
    }
  });

  it("serializes column_types as object not array", async () => {
    ensureTestCsv();
    const session = createSessionStore("test_009");
    pool = new WorkerPool(session);
    await pool.start();

    const resp = await pool.call("load_data", {
      file_path: TEST_CSV,
      name: "data_1",
    });

    const result = resp.result as Record<string, unknown>;
    const colTypes = result.column_types as Record<string, string>;

    // Should be an object with column names as keys, not an array
    expect(typeof colTypes).toBe("object");
    expect(Array.isArray(colTypes)).toBe(false);
    expect(colTypes.mpg).toBeDefined();
  });

  it("successResult persists oversized payloads to disk", async () => {
    const { successResult } = await import("../../src/types.js");
    const { existsSync } = await import("node:fs");

    // Create a payload > 100KB
    const bigData = {
      values: Array.from({ length: 20000 }, (_, i) => ({
        index: i,
        value: Math.random(),
      })),
    };
    const result = successResult(bigData);

    // Should be persisted
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed._persisted).toBe(true);
    expect(parsed.filepath).toBeDefined();
    expect(parsed.preview_text).toBeDefined();
    expect(parsed.original_size_kb).toBeGreaterThan(90);

    // File should exist on disk
    expect(existsSync(parsed.filepath)).toBe(true);
  });
});
