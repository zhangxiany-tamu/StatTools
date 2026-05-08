// ============================================================================
// StatTools — Phase 7 Agent-Loop Ergonomics
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  parseResult,
  type TestServer,
} from "../fixtures/common.js";

describe("Phase 7 agent-loop ergonomics", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("stat_resolve returns did_you_mean and stat_session records the failure", async () => {
    const badResolve = await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "lmm",
    });

    expect(badResolve.isError).toBe(true);
    const error = parseResult(badResolve);
    const didYouMean = error.did_you_mean as {
      same_package?: Array<{ function: string }>;
    };
    expect(didYouMean.same_package?.some((item) => item.function === "lm")).toBe(true);

    const session = expectSuccess(await callTool(ts.server, "stat_session", {}));
    expect(session.recent_failure_count).toBeGreaterThan(0);

    const recentFailures = session.recent_failures as Array<Record<string, unknown>>;
    expect(recentFailures[0].tool).toBe("stat_resolve");
    expect(recentFailures[0].package).toBe("stats");
    expect(recentFailures[0].function).toBe("lmm");
    expect(recentFailures[0].did_you_mean).toBeDefined();
  }, 15000);

  it("stat_resolve returns did_you_mean for Python function and module typos", async () => {
    const badFunction = await callTool(ts.server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegresion",
    });

    expect(badFunction.isError).toBe(true);
    const functionError = parseResult(badFunction);
    const functionSuggestions = functionError.did_you_mean as {
      same_package?: Array<{ function: string }>;
    };
    expect(
      functionSuggestions.same_package?.some((item) => item.function === "LinearRegression"),
    ).toBe(true);

    const badPackage = await callTool(ts.server, "stat_resolve", {
      package: "sklearn.linear_modl",
      function: "LinearRegression",
    });

    expect(badPackage.isError).toBe(true);
    const packageError = parseResult(badPackage);
    const packageSuggestions = packageError.did_you_mean as {
      packages?: Array<{ package: string }>;
    };
    expect(packageSuggestions.packages?.[0]?.package).toBe("sklearn.linear_model");
    expect(
      packageSuggestions.packages?.some((item) => item.package === "sklearn.linear_model"),
    ).toBe(true);
  }, 15000);

  it("stat_call returns a retry_with_coerce hint for class-sensitive calls", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "stl",
    }));

    const badCall = await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "stl",
      args: {
        x: Array.from({ length: 24 }, (_, index) => index + 1),
        "s.window": "periodic",
      },
    });

    expect(badCall.isError).toBe(true);
    const error = parseResult(badCall);
    const retryHint = error.retry_hint as {
      strategy?: string;
      coerce?: Record<string, string>;
      retry_call?: { coerce?: Record<string, string> };
    };

    expect(retryHint.strategy).toBe("retry_with_coerce");
    expect(retryHint.coerce?.x).toMatch(/^ts\(/);
    expect(retryHint.retry_call?.coerce?.x).toBe(retryHint.coerce?.x);

    const session = expectSuccess(await callTool(ts.server, "stat_session", {}));
    const recentFailures = session.recent_failures as Array<Record<string, unknown>>;
    const input = recentFailures[0].input as {
      args?: { x?: unknown[] };
    };
    expect(recentFailures[0].tool).toBe("stat_call");
    expect(input.args?.x).toHaveLength(21);
    expect(input.args?.x?.[20]).toMatch(/more items/);
  }, 15000);
});
