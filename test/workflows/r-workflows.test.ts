// ============================================================================
// StatTools — R Workflow Tests
// ============================================================================
// End-to-end multi-tool workflows exercising the full R analysis pipeline.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  TEST_CSV,
  TEST_CSV_NANF,
  type TestServer,
} from "../fixtures/common.js";

describe("R Workflows", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("OLS regression: load → resolve → fit → describe", async () => {
    // Load data
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars",
    }));
    expect(load.object_id).toBe("cars");

    // Resolve lm
    const resolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "lm",
    }));
    expect(resolve.resolved).toBe(true);

    // Fit model
    const fit = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt + hp", data: "cars" },
    }));
    expect(fit.result).toBeDefined();
    const result = fit.result as Record<string, unknown>;
    expect(result.r_squared).toBeDefined();
    expect(result.coefficients).toBeDefined();

    // Verify model handle
    expect(fit.objects_created).toBeDefined();
    const modelId = (fit.objects_created as Array<{ id: string }>)[0].id;

    // Describe the model
    const desc = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: modelId,
      action: "summary",
    }));
    expect(desc).toBeDefined();
  }, 15000);

  it("logistic regression: fit glm with binomial family", async () => {
    // Data already loaded as "cars" from previous test — create new server
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_logit",
    }));

    const resolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "glm",
    }));
    expect(resolve.resolved).toBe(true);

    const fit = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "glm",
      args: {
        formula: "vs ~ wt + hp",
        data: "cars_logit",
        family: "binomial",
      },
    }));
    const result = fit.result as Record<string, unknown>;
    expect(result.coefficients).toBeDefined();
    expect(result.aic).toBeDefined();
  }, 15000);

  it("t-test: two-sample test on grouped data", async () => {
    const resolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "t.test",
    }));
    expect(resolve.resolved).toBe(true);

    // Use formula interface: mpg by am (automatic vs manual)
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_ttest",
    }));

    const test = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "t.test",
      args: { formula: "mpg ~ am", data: "cars_ttest" },
    }));
    const result = test.result as Record<string, unknown>;
    expect(result.p_value).toBeDefined();
    expect(result.statistic).toBeDefined();
    expect(result.method).toBeDefined();
  }, 15000);

  it("correlation matrix: compute pairwise correlations", async () => {
    const resolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "cor",
    }));

    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_cor",
    }));

    const cor = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "cor",
      args: { x: "cars_cor" },
    }));
    expect(cor.result).toBeDefined();
  }, 15000);

  it("ANOVA: one-way analysis of variance", async () => {
    const resolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "aov",
    }));

    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_aov",
    }));

    const aov = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "aov",
      args: { formula: "mpg ~ factor(cyl)", data: "cars_aov" },
    }));
    expect(aov.result).toBeDefined();
  }, 15000);

  it("stat_describe: all 5 actions on a data handle", async () => {
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_desc",
    }));
    const handleId = load.object_id as string;

    // schema
    const schema = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: handleId, action: "schema",
    }));
    expect(schema).toBeDefined();

    // head
    const head = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: handleId, action: "head",
    }));
    expect(head).toBeDefined();

    // dimensions
    const dims = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: handleId, action: "dimensions",
    }));
    expect(dims).toBeDefined();

    // summary
    const summary = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: handleId, action: "summary",
    }));
    expect(summary).toBeDefined();

    // str
    const str = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: handleId, action: "str",
    }));
    expect(str).toBeDefined();
  }, 15000);

  it("robust SE: lm → sandwich::vcovHC", async () => {
    // Load
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_robust",
    }));

    // Fit model
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats", function: "lm",
    }));
    const fit = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt + hp", data: "cars_robust" },
    }));
    const modelId = (fit.objects_created as Array<{ id: string }>)[0].id;

    // Robust SE
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "sandwich", function: "vcovHC",
    }));
    const robust = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "sandwich",
      function: "vcovHC",
      args: { x: modelId },
    }));
    expect(robust.result).toBeDefined();
  }, 20000);

  it("session state tracks handles and resolved functions", async () => {
    const session = expectSuccess(await callTool(ts.server, "stat_session", {}));
    const handles = session.handles as Array<{ id: string }>;
    const resolved = session.resolved_functions as string[];

    // Should have multiple handles from previous tests
    expect(handles.length).toBeGreaterThan(0);
    // Should have resolved functions
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).toContain("stats::lm");
  }, 5000);
});
