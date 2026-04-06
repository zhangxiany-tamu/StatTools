// ============================================================================
// StatTools — Python Method Workflow Tests
// ============================================================================
// End-to-end sklearn/statsmodels/scipy workflows via stat_call + stat_method.
// Tests that require Python+sklearn use ctx.skip() at runtime when unavailable,
// so the report distinguishes "skipped" from "passed".

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  parseResult,
  TEST_CSV,
  type TestServer,
} from "../fixtures/common.js";

describe("Python Workflows", () => {
  let ts: TestServer;
  let pythonAvailable = false;

  beforeAll(async () => {
    ts = await createTestServer();

    // Probe Python+sklearn availability at runtime
    const probe = await callTool(ts.server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
    });
    pythonAvailable = !probe.isError;
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("LinearRegression: construct → fit → predict → score", async (ctx) => {
    if (!pythonAvailable) ctx.skip();

    const construct = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
      args: {},
      assign_to: "lr",
    }));
    expect(construct.objects_created).toBeDefined();

    const fit = expectSuccess(await callTool(ts.server, "stat_method", {
      object: "lr",
      method: "fit",
      positional_args: [[[1], [2], [3], [4], [5]], [2, 4, 6, 8, 10]],
    }));
    expect((fit.result as Record<string, unknown>).coefficients).toBeDefined();

    const pred = expectSuccess(await callTool(ts.server, "stat_method", {
      object: "lr",
      method: "predict",
      positional_args: [[[6], [7], [8]]],
      assign_to: "lr_preds",
    }));
    expect(pred.result).toBeDefined();

    const score = expectSuccess(await callTool(ts.server, "stat_method", {
      object: "lr",
      method: "score",
      positional_args: [[[1], [2], [3], [4], [5]], [2, 4, 6, 8, 10]],
    }));
    const scoreVal = (score.result as Record<string, unknown>).value;
    expect(scoreVal).toBeGreaterThan(0.99);
  }, 20000);

  it("StandardScaler: fit_transform → inverse_transform", async (ctx) => {
    if (!pythonAvailable) ctx.skip();

    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "sklearn.preprocessing",
      function: "StandardScaler",
    }));

    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "sklearn.preprocessing",
      function: "StandardScaler",
      args: {},
      assign_to: "scaler",
    }));

    const transform = expectSuccess(await callTool(ts.server, "stat_method", {
      object: "scaler",
      method: "fit_transform",
      positional_args: [[[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]]],
      assign_to: "scaled_data",
    }));
    expect(transform.result).toBeDefined();

    const inverse = expectSuccess(await callTool(ts.server, "stat_method", {
      object: "scaler",
      method: "inverse_transform",
      positional_args: ["scaled_data"],
      assign_to: "recovered",
    }));
    expect(inverse.result).toBeDefined();
  }, 20000);

  it("PCA: fit → transform → explained variance", async (ctx) => {
    if (!pythonAvailable) ctx.skip();

    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "sklearn.decomposition",
      function: "PCA",
    }));

    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "sklearn.decomposition",
      function: "PCA",
      args: { n_components: 2 },
      assign_to: "pca",
    }));

    const fit = expectSuccess(await callTool(ts.server, "stat_method", {
      object: "pca",
      method: "fit",
      positional_args: [[[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]],
    }));
    expect(fit.result).toBeDefined();

    const desc = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: "pca",
    }));
    expect(desc).toBeDefined();
  }, 20000);

  it("stat_load_data with runtime=python creates pandas DataFrame", async (ctx) => {
    if (!pythonAvailable) ctx.skip();

    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      runtime: "python",
      name: "py_mtcars",
    }));
    expect(load.class).toBe("DataFrame");
    expect((load.dimensions as Record<string, number>).rows).toBe(20);
    expect(load.object_id).toBe("py_mtcars");

    const session = expectSuccess(await callTool(ts.server, "stat_session", {
      handle: "py_mtcars",
    }));
    expect((session.handle as Record<string, unknown>).runtime).toBe("python");
  }, 15000);

  it("scipy.stats: t-test via stat_call", async (ctx) => {
    if (!pythonAvailable) ctx.skip();

    const resolve = await callTool(ts.server, "stat_resolve", {
      package: "scipy.stats",
      function: "ttest_ind",
    });
    expect(resolve.isError).toBeFalsy();

    const test = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "scipy.stats",
      function: "ttest_ind",
      args: { a: [1, 2, 3, 4, 5], b: [2, 4, 6, 8, 10] },
    }));
    expect(test.result).toBeDefined();
  }, 15000);

  // Error path — does NOT require Python
  it("stat_method rejects method on nonexistent object", async () => {
    const result = await callTool(ts.server, "stat_method", {
      object: "does_not_exist",
      method: "fit",
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.message).toContain("not found");
  });
});
