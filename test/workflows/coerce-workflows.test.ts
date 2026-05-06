// ============================================================================
// StatTools — Coerce Field Workflow Tests
// ============================================================================
// stat_call's `coerce` field applies whitelisted R class coercions before the
// call. Pairs with stat_resolve's `class_hint` for ML APIs (randomForest,
// glmnet) and time-series functions (auto.arima, stl, HoltWinters) that
// dispatch on or require specific R classes.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  type TestServer,
} from "../fixtures/common.js";

async function isPackageInstalled(ts: TestServer, pkg: string, fn: string): Promise<boolean> {
  const res = await callTool(ts.server, "stat_resolve", { package: pkg, function: fn });
  if (res.isError) return false;
  const data = JSON.parse(res.content[0].text);
  return data.installed === true;
}

describe("stat_resolve class_hint", () => {
  let ts: TestServer;

  beforeAll(async () => { ts = await createTestServer(); });
  afterAll(async () => { await ts.cleanup(); });

  it("randomForest::randomForest hints at factor coercion for y", async (ctx) => {
    if (!(await isPackageInstalled(ts, "randomForest", "randomForest"))) {
      ctx.skip();
      return;
    }
    const out = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "randomForest",
      function: "randomForest",
    }));
    expect(out.class_hint).toBeDefined();
    const hints = out.class_hint as Array<Record<string, unknown>>;
    const yHint = hints.find((h) => h.arg === "y");
    expect(yHint).toBeDefined();
    expect(yHint!.expected_classes).toContain("factor");
    expect(yHint!.recommended_coerce).toBe("factor");
  }, 15000);

  it("forecast::auto.arima hints at ts coercion with frequency", async (ctx) => {
    if (!(await isPackageInstalled(ts, "forecast", "auto.arima"))) {
      ctx.skip();
      return;
    }
    const out = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "forecast",
      function: "auto.arima",
    }));
    expect(out.class_hint).toBeDefined();
    const hints = out.class_hint as Array<Record<string, unknown>>;
    const yHint = hints.find((h) => h.arg === "y");
    expect(yHint).toBeDefined();
    expect(yHint!.recommended_coerce).toMatch(/^ts\(/);
  }, 15000);

  it("stats::stl hints at ts coercion for x", async () => {
    const out = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "stl",
    }));
    expect(out.class_hint).toBeDefined();
  }, 15000);

  it("stats::lm has NO class_hint (no special class needed)", async () => {
    const out = expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "lm",
    }));
    expect(out.class_hint).toBeUndefined();
  }, 15000);
});

describe("stat_call coerce field", () => {
  let ts: TestServer;
  let irisLoaded = false;
  let apLoaded = false;
  let xyExtracted = false;

  beforeAll(async () => {
    ts = await createTestServer();
    // Load iris for the ML cases
    const iris = await callTool(ts.server, "stat_load_data", { dataset: "iris" });
    irisLoaded = !iris.isError;
    if (irisLoaded) {
      const xRes = await callTool(ts.server, "stat_extract", {
        object: "iris",
        columns: ["Sepal.Length", "Sepal.Width", "Petal.Length", "Petal.Width"],
        assign_to: "iris_x",
      });
      const yRes = await callTool(ts.server, "stat_extract", {
        object: "iris",
        columns: ["Species"],
        assign_to: "iris_y",
      });
      xyExtracted = !xRes.isError && !yRes.isError;
    }
    // Load AirPassengers for the ts cases
    const ap = await callTool(ts.server, "stat_load_data", {
      dataset: "AirPassengers",
      name: "ap",
    });
    apLoaded = !ap.isError;
  });

  afterAll(async () => { await ts.cleanup(); });

  it("randomForest classification: coerce={y:'factor'} unblocks the factor dispatch", async (ctx) => {
    if (!xyExtracted || !(await isPackageInstalled(ts, "randomForest", "randomForest"))) {
      ctx.skip();
      return;
    }
    const out = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "randomForest",
      function: "randomForest",
      args: { x: "iris_x", y: "iris_y" },
      coerce: { y: "factor" },
      assign_to: "rf_iris",
    }));
    expect(out.result).toBeDefined();
  }, 30000);

  it("forecast::auto.arima: coerce={y:'ts(frequency=12)'} enables seasonal detection", async (ctx) => {
    if (!apLoaded || !(await isPackageInstalled(ts, "forecast", "auto.arima"))) {
      ctx.skip();
      return;
    }
    const out = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "forecast",
      function: "auto.arima",
      args: { y: "ap" },
      coerce: { y: "ts(frequency=12)" },
      assign_to: "arima_ap",
    }));
    expect(out.result).toBeDefined();
  }, 30000);

  it("stats::stl: coerce={x:'ts(frequency=12)'} satisfies the ts requirement", async (ctx) => {
    if (!apLoaded) { ctx.skip(); return; }
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "stl",
    }));
    const out = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "stl",
      args: { x: "ap", "s.window": "periodic" },
      coerce: { x: "ts(frequency=12)" },
    }));
    expect(out.result).toBeDefined();
  }, 30000);

  it("rejects unknown coerce specs with a structured error", async (ctx) => {
    if (!irisLoaded) { ctx.skip(); return; }
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "lm",
    }));
    const out = await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "Sepal.Length ~ Sepal.Width", data: "iris" },
      coerce: { data: "purple" },
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/unknown coerce spec/i);
  }, 15000);

  it("rejects unsupported ts() parameters with a structured error", async (ctx) => {
    if (!apLoaded || !(await isPackageInstalled(ts, "forecast", "auto.arima"))) {
      ctx.skip();
      return;
    }
    const out = await callTool(ts.server, "stat_call", {
      package: "forecast",
      function: "auto.arima",
      args: { y: "ap" },
      coerce: { y: "ts(zorp=999)" },
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/unsupported ts.*zorp|zorp.*ts/i);
  }, 15000);

  it("rejects coerce on Python tools (R-only feature)", async () => {
    const resolved = await callTool(ts.server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
    });
    if (resolved.isError) return; // Python not available, skip silently

    const out = await callTool(ts.server, "stat_call", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
      args: {},
      coerce: { fit_intercept: "factor" },
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/R-only/i);
  }, 15000);
});
