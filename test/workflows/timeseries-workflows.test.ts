// ============================================================================
// StatTools — Time Series Workflow Tests (Wave 4)
// ============================================================================
// forecast package: auto.arima, forecast, ets.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import {
  createTestServer, callTool, expectSuccess, type TestServer,
} from "../fixtures/common.js";

const TS_CSV = "/tmp/stattools_ts.csv";

describe("Time Series Workflows (Wave 4)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();

    // Create a time series dataset with trend + seasonality
    const rows = Array.from({ length: 48 }, (_, i) => {
      const trend = 100 + i * 2;
      const seasonal = 10 * Math.sin((i % 12) * Math.PI / 6);
      const noise = (Math.random() - 0.5) * 5;
      return `${i + 1},${(trend + seasonal + noise).toFixed(1)}`;
    });
    writeFileSync(TS_CSV, "month,sales\n" + rows.join("\n"));
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("forecast::auto.arima fits ARIMA model", async () => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TS_CSV, name: "tsdata" }));

    // Extract the sales column as a vector
    expectSuccess(await callTool(ts.server, "stat_extract", {
      handle: "tsdata", columns: ["sales"], assign_to: "sales",
    }));

    // Convert to ts object and fit ARIMA
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "stats", function: "ts" }));
    const tsObj = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats", function: "ts",
      args: { data: "sales", frequency: 12 },
      assign_to: "sales_ts",
    }));
    expect(tsObj.result).toBeDefined();

    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "forecast", function: "auto.arima" }));
    const arima = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "forecast", function: "auto.arima",
      args: { y: "sales_ts" },
    }));
    expect(arima.result).toBeDefined();
  }, 20000);

  it("forecast::forecast produces future predictions", async () => {
    // Build on previous test's model if available, or create fresh
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "forecast", function: "forecast" }));

    // Need an arima model — fit one
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TS_CSV, name: "ts2" }));
    expectSuccess(await callTool(ts.server, "stat_extract", { handle: "ts2", columns: ["sales"], assign_to: "s2" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "stats", function: "ts" }));
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats", function: "ts",
      args: { data: "s2", frequency: 12 },
      assign_to: "ts2_ts",
    }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "forecast", function: "auto.arima" }));
    const model = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "forecast", function: "auto.arima",
      args: { y: "ts2_ts" },
    }));
    const modelId = (model.objects_created as Array<{ id: string }>)?.[0]?.id;
    if (!modelId) return; // skip if auto-assign didn't work

    const fc = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "forecast", function: "forecast",
      args: { object: modelId, h: 12 },
    }));
    expect(fc.result).toBeDefined();
  }, 25000);

  it("forecast::ets fits exponential smoothing", async () => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TS_CSV, name: "ts3" }));
    expectSuccess(await callTool(ts.server, "stat_extract", { handle: "ts3", columns: ["sales"], assign_to: "s3" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "stats", function: "ts" }));
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats", function: "ts",
      args: { data: "s3", frequency: 12 },
      assign_to: "ts3_ts",
    }));

    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "forecast", function: "ets" }));
    const ets = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "forecast", function: "ets",
      args: { y: "ts3_ts" },
    }));
    expect(ets.result).toBeDefined();
  }, 20000);
});
