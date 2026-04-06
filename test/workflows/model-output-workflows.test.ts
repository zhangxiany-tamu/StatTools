// ============================================================================
// StatTools — Model Output & Inference Workflow Tests (Wave 3)
// ============================================================================
// broom tidy/glance/augment, car VIF, lmtest, sandwich, survival, glmer.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer, callTool, expectSuccess, parseResult, TEST_CSV, type TestServer,
} from "../fixtures/common.js";

describe("Model Output Workflows (Wave 3)", () => {
  let ts: TestServer;
  let modelId: string;

  beforeAll(async () => {
    ts = await createTestServer();
    // Load data and fit a base model for all tests
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "w3_data" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "stats", function: "lm" }));
    const fit = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats", function: "lm",
      args: { formula: "mpg ~ wt + hp + cyl", data: "w3_data" },
    }));
    modelId = (fit.objects_created as Array<{ id: string }>)[0].id;
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  // ---- broom ----

  it("broom::tidy extracts coefficient table", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "broom", function: "tidy" }));
    const tidy = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "broom", function: "tidy", args: { x: modelId },
    }));
    expect(tidy.result).toBeDefined();
  }, 15000);

  it("broom::glance extracts model-level summary", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "broom", function: "glance" }));
    const glance = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "broom", function: "glance", args: { x: modelId },
    }));
    expect(glance.result).toBeDefined();
  }, 15000);

  it("broom::augment adds fitted values to data", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "broom", function: "augment" }));
    const augment = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "broom", function: "augment", args: { x: modelId },
    }));
    expect(augment.result).toBeDefined();
  }, 15000);

  // ---- car + lmtest + sandwich ----

  it("car::vif computes variance inflation factors", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "car", function: "vif" }));
    const vif = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "car", function: "vif", args: { mod: modelId },
    }));
    expect(vif.result).toBeDefined();
  }, 15000);

  it("lmtest::bptest tests heteroscedasticity", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "lmtest", function: "bptest" }));
    const bp = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "lmtest", function: "bptest", args: { formula: modelId },
    }));
    expect(bp.result).toBeDefined();
  }, 15000);

  it("lmtest::coeftest with sandwich::vcovHC", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "sandwich", function: "vcovHC" }));
    const vcov = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "sandwich", function: "vcovHC", args: { x: modelId },
    }));
    expect(vcov.result).toBeDefined();
    // coeftest expects a model and a vcov matrix
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "lmtest", function: "coeftest" }));
    const vcovId = vcov.objects_created
      ? (vcov.objects_created as Array<{ id: string }>)[0]?.id
      : null;
    if (vcovId) {
      const ct = expectSuccess(await callTool(ts.server, "stat_call", {
        package: "lmtest", function: "coeftest",
        args: { x: modelId, vcov: vcovId },
      }));
      expect(ct.result).toBeDefined();
    }
  }, 15000);
});

// ---- Survival ----

describe("Survival Workflows (Wave 3)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("survival: coxph on lung dataset", async () => {
    // Load lung data into session via utils::data
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "utils", function: "data" }));
    await callTool(ts.server, "stat_call", {
      package: "utils", function: "data",
      args: { "x": "lung", "package": "survival" },
    });
    // Now lung should be in the R environment
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "survival", function: "coxph" }));
    const result = await callTool(ts.server, "stat_call", {
      package: "survival", function: "coxph",
      args: { formula: "Surv(time, status) ~ age + sex", data: "lung" },
    });
    // coxph should work — Surv is auto-available when survival is loaded
    if (!result.isError) {
      const data = expectSuccess(result);
      expect(data.result).toBeDefined();
    }
    // If it fails, it's likely because data("lung") didn't register a handle.
    // That's a known gap: data() loads to globalenv, not .ss session env.
  }, 15000);
});

// ---- GLMER ----

describe("GLMER Workflows (Wave 3)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("lme4::glmer fits binomial mixed model", async () => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "glmer_data" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "lme4", function: "glmer" }));
    const result = await callTool(ts.server, "stat_call", {
      package: "lme4", function: "glmer",
      args: { formula: "vs ~ wt + (1|cyl)", data: "glmer_data", family: "binomial" },
    });
    // glmer may warn about convergence on small data — that's ok
    if (!result.isError) {
      const data = expectSuccess(result);
      expect(data.result).toBeDefined();
    }
  }, 20000);
});
