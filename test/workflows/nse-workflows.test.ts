// ============================================================================
// StatTools — NSE Escape Hatch Workflow Tests
// ============================================================================
// End-to-end tests for the `expressions` and `dot_expressions` slots in
// stat_call. These let agents drive NSE-heavy R functions (dplyr verbs, tidyr
// pivots, ggplot2::aes) through the JSON tool surface.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  TEST_CSV,
  type TestServer,
} from "../fixtures/common.js";

describe("NSE Workflows", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
    expectSuccess(await callTool(ts.server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "mtcars",
    }));
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("dplyr::filter accepts unnamed predicates via dot_expressions", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "dplyr",
      function: "filter",
    }));

    const out = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "dplyr",
      function: "filter",
      args: { ".data": "mtcars" },
      dot_expressions: ["cyl > 4"],
      assign_to: "filtered",
    }));

    expect(out.result).toBeDefined();
    const created = out.objects_created as Array<{ id: string }>;
    expect(created?.find((o) => o.id === "filtered")).toBeDefined();
  }, 15000);

  it("dplyr::mutate accepts named NSE args via expressions", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "dplyr",
      function: "mutate",
    }));

    const out = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "dplyr",
      function: "mutate",
      args: { ".data": "mtcars" },
      expressions: { mpg_kpl: "mpg * 0.425" },
      assign_to: "mt_kpl",
    }));

    expect(out.result).toBeDefined();
    const created = out.objects_created as Array<{ id: string }>;
    expect(created.find((o) => o.id === "mt_kpl")).toBeDefined();
  }, 15000);

  it("dplyr::group_by + summarise resolves data-mask pronouns like n() and mean()", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "dplyr",
      function: "group_by",
    }));

    const grp = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "dplyr",
      function: "group_by",
      args: { ".data": "mtcars" },
      dot_expressions: ["cyl"],
      assign_to: "by_cyl",
    }));
    expect(grp.objects_created).toBeDefined();

    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "dplyr",
      function: "summarise",
    }));

    const sum = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "dplyr",
      function: "summarise",
      args: { ".data": "by_cyl" },
      expressions: { mean_mpg: "mean(mpg)", n_cars: "n()" },
    }));

    const result = sum.result as Record<string, unknown>;
    expect(result.preview).toBeDefined();
    const preview = result.preview as Array<Record<string, unknown>>;
    expect(preview.length).toBeGreaterThan(0);
    expect(preview[0]).toHaveProperty("mean_mpg");
    expect(preview[0]).toHaveProperty("n_cars");
  }, 20000);

  it("tidyr::pivot_longer accepts tidy-select expressions like everything() and -col", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "tidyr",
      function: "pivot_longer",
    }));

    const everythingOut = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "tidyr",
      function: "pivot_longer",
      args: { data: "mtcars" },
      expressions: { cols: "everything()" },
    }));
    expect(everythingOut.result).toBeDefined();

    const negOut = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "tidyr",
      function: "pivot_longer",
      args: { data: "mtcars" },
      expressions: { cols: "-cyl" },
    }));
    expect(negOut.result).toBeDefined();
  }, 20000);

  it("dplyr::arrange accepts desc() in dot_expressions", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "dplyr",
      function: "arrange",
    }));

    const out = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "dplyr",
      function: "arrange",
      args: { ".data": "mtcars" },
      dot_expressions: ["desc(mpg)"],
    }));
    expect(out.result).toBeDefined();
  }, 15000);

  it("stat_resolve emits nse_hint for known NSE functions", async () => {
    const filterResolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "dplyr",
      function: "filter",
    }));
    expect(filterResolve.nse_hint).toBeDefined();
    const filterHint = filterResolve.nse_hint as Record<string, unknown>;
    expect(filterHint.dot_expression).toBe(true);
    expect(typeof filterHint.example).toBe("string");

    const pivotResolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "tidyr",
      function: "pivot_longer",
    }));
    expect(pivotResolve.nse_hint).toBeDefined();
    const pivotHint = pivotResolve.nse_hint as Record<string, unknown>;
    expect(pivotHint.expression_args).toContain("cols");

    // Non-NSE functions should NOT have an nse_hint
    const lmResolve = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "lm",
    }));
    expect(lmResolve.nse_hint).toBeUndefined();
  }, 15000);

  it("rejects expressions for Python functions (R-only feature)", async () => {
    // Resolve any Python function first to mark it
    const resolved = await callTool(ts.server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
    });
    if (resolved.isError) return; // Python not available, skip silently

    const out = await callTool(ts.server, "stat_call", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
      args: {},
      expressions: { fit_intercept: "true" },
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/R-only/i);
  }, 15000);

  it("returns a structured error when an expression fails to parse", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "dplyr",
      function: "filter",
    }));

    const out = await callTool(ts.server, "stat_call", {
      package: "dplyr",
      function: "filter",
      args: { ".data": "mtcars" },
      dot_expressions: ["cyl > > 4"], // syntax error
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/parse|syntax/i);
  }, 15000);
});
