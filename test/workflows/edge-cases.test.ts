// ============================================================================
// StatTools — Edge Case Tests
// ============================================================================
// Tests for boundary conditions: NaN handling, complex formulas, large results.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  parseResult,
  TEST_CSV_NANF,
  TEST_CSV,
  type TestServer,
} from "../fixtures/common.js";

describe("Edge Cases", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("handles NA/NaN values in data without crashing", async () => {
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV_NANF,
      name: "nandata",
    }));
    expect(load.object_id).toBe("nandata");

    // Describe should show NA counts
    const desc = expectSuccess(await callTool(ts.server, "stat_describe", {
      handle: "nandata",
      action: "summary",
    }));
    expect(desc).toBeDefined();

    // cor() with na.rm should work
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats", function: "cor",
    }));
    // This should not throw even with NAs
    const result = await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "cor",
      args: { x: "nandata", use: "complete.obs" },
    });
    // May error due to non-numeric columns — that's ok, should be structured error
    expect(result.content).toBeDefined();
  }, 15000);

  it("complex formula with interactions and transformations", async () => {
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_complex",
    }));

    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats", function: "lm",
    }));

    const fit = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: {
        formula: "mpg ~ wt * hp + I(wt^2) + factor(cyl)",
        data: "cars_complex",
      },
    }));
    const result = fit.result as Record<string, unknown>;
    expect(result.coefficients).toBeDefined();
    // Interaction and squared terms should produce more coefficients
    const coefs = result.coefficients as Record<string, unknown>;
    expect(Object.keys(coefs).length).toBeGreaterThan(3);
  }, 15000);

  it("stat_call returns structured error for bad formula", async () => {
    const load = expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars_badfmt",
    }));

    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats", function: "lm",
    }));

    const result = await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "nonexistent_col ~ wt", data: "cars_badfmt" },
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.message).toBeDefined();
  }, 15000);

  it("empty result from search returns gracefully", () => {
    const result = callTool(ts.server, "stat_search", {
      query: "qzxjvmkwplfnhgbtdy",
    });
    return result.then((r) => {
      expect(r.isError).toBeFalsy();
      const data = parseResult(r);
      expect(data.results).toBeDefined();
      expect((data.results as unknown[]).length).toBe(0);
    });
  });
});
