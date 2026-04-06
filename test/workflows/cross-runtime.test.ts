// ============================================================================
// StatTools — Cross-Runtime Tests
// ============================================================================
// Tests for R + Python operating in the same session.
// Python-dependent tests use ctx.skip() at runtime when unavailable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  parseResult,
  TEST_CSV,
  type TestServer,
} from "../fixtures/common.js";

describe("Cross-Runtime", () => {
  let ts: TestServer;
  let pythonAvailable = false;

  beforeAll(async () => {
    ts = await createTestServer();
    const probe = await callTool(ts.server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
    });
    pythonAvailable = !probe.isError;
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("R and Python handles coexist in same session", async (ctx) => {
    // R part always runs
    const rLoad = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "r_data",
    }));
    expect(rLoad.object_id).toBe("r_data");

    if (!pythonAvailable) ctx.skip();

    const pyLoad = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "py_data",
      runtime: "python",
    }));
    expect(pyLoad.object_id).toBe("py_data");

    const session = expectSuccess(await callTool(ts.server, "stat_session", {}));
    const handles = session.handles as Array<{ id: string }>;
    expect(handles.find((h) => h.id === "r_data")).toBeDefined();
    expect(handles.find((h) => h.id === "py_data")).toBeDefined();
  }, 15000);

  it("R model and Python model in same session", async (ctx) => {
    // R part always runs
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats", function: "lm",
    }));
    expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cross_data",
    }));
    const rFit = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt", data: "cross_data" },
    }));
    const rModelId = (rFit.objects_created as Array<{ id: string }>)[0].id;

    if (!pythonAvailable) ctx.skip();

    // Python part
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
      args: {},
      assign_to: "py_lr",
    }));
    expectSuccess(await callTool(ts.server, "stat_method", {
      object: "py_lr",
      method: "fit",
      positional_args: [[[1], [2], [3]], [2, 4, 6]],
    }));

    const rDesc = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: rModelId,
      action: "summary",
    }));
    expect(rDesc).toBeDefined();

    const pyDesc = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: "py_lr",
    }));
    expect(pyDesc).toBeDefined();
  }, 20000);

  // Error path — does NOT require Python
  it("stat_method correctly rejects R handles", async () => {
    expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "r_only_data",
    }));

    const result = await callTool(ts.server, "stat_method", {
      object: "r_only_data",
      method: "head",
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.message).toContain("R object");
  }, 10000);
});
