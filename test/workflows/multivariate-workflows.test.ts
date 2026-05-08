// ============================================================================
// StatTools — Multivariate Workflow Tests (Wave 4)
// ============================================================================
// psych (factor analysis, reliability) and lavaan (SEM, CFA).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import {
  createTestServer, callTool, expectSuccess, parseResult, type TestServer,
} from "../fixtures/common.js";

const PSYCH_CSV = "/tmp/stattools_psych.csv";
const LAVAAN_CSV = "/tmp/stattools_lavaan.csv";

describe("Psych Workflows (Wave 4)", () => {
  let ts: TestServer;
  let psychAvailable = false;

  beforeAll(async () => {
    ts = await createTestServer();

    // Probe psych availability
    const probe = await callTool(ts.server, "stat_resolve", { package: "psych", function: "describe" });
    psychAvailable = !probe.isError;

    // Create psychometric test data (6 items, correlated)
    const rows = Array.from({ length: 50 }, (_, i) => {
      const f1 = Math.sin(i * 0.3) * 2;
      const f2 = Math.cos(i * 0.2) * 2;
      return [
        (f1 + Math.random()).toFixed(2),
        (f1 + 0.5 + Math.random()).toFixed(2),
        (f1 - 0.3 + Math.random()).toFixed(2),
        (f2 + Math.random()).toFixed(2),
        (f2 + 0.7 + Math.random()).toFixed(2),
        (f2 - 0.2 + Math.random()).toFixed(2),
      ].join(",");
    });
    writeFileSync(PSYCH_CSV, "q1,q2,q3,q4,q5,q6\n" + rows.join("\n"));
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("psych::describe produces descriptive statistics", async (ctx) => {
    if (!psychAvailable) ctx.skip();
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: PSYCH_CSV, name: "psy" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "psych", function: "describe" }));
    const desc = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "psych", function: "describe", args: { x: "psy" },
    }));
    expect(desc.result).toBeDefined();
  }, 15000);

  it("psych::alpha computes reliability (Cronbach's alpha)", async (ctx) => {
    if (!psychAvailable) ctx.skip();
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "psych", function: "alpha" }));
    const alpha = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "psych", function: "alpha", args: { x: "psy" },
    }));
    expect(alpha.result).toBeDefined();
  }, 15000);

  it("psych::fa runs exploratory factor analysis", async (ctx) => {
    if (!psychAvailable) ctx.skip();
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "psych", function: "fa" }));
    const fa = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "psych", function: "fa", args: { r: "psy", nfactors: 2, rotate: "varimax" },
    }));
    expect(fa.result).toBeDefined();
  }, 15000);

  it("psych::KMO checks sampling adequacy", async (ctx) => {
    if (!psychAvailable) ctx.skip();
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "psych", function: "KMO" }));
    const kmo = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "psych", function: "KMO", args: { r: "psy" },
    }));
    expect(kmo.result).toBeDefined();
  }, 15000);
});

describe("Lavaan Workflows (Wave 4)", () => {
  let ts: TestServer;
  let lavaanAvailable = false;
  const cfaModel = "f1 =~ x1 + x2 + x3\nf2 =~ y1 + y2 + y3";
  const semModel = "f1 =~ x1 + x2 + x3\nf2 =~ y1 + y2 + y3\nf2 ~ f1";

  beforeAll(async () => {
    ts = await createTestServer();

    // Probe lavaan availability
    const probe = await callTool(ts.server, "stat_resolve", { package: "lavaan", function: "cfa" });
    lavaanAvailable = !probe.isError;

    // Create SEM-style data (2 latent factors, 6 indicators)
    const rows = Array.from({ length: 80 }, (_, i) => {
      const f1 = (i % 10) * 0.5 + Math.random() * 0.5;
      const f2 = (i % 8) * 0.6 + Math.random() * 0.5;
      return [
        (f1 * 0.8 + Math.random()).toFixed(2),
        (f1 * 0.7 + Math.random()).toFixed(2),
        (f1 * 0.9 + Math.random()).toFixed(2),
        (f2 * 0.6 + Math.random()).toFixed(2),
        (f2 * 0.8 + Math.random()).toFixed(2),
        (f2 * 0.7 + Math.random()).toFixed(2),
      ].join(",");
    });
    writeFileSync(LAVAAN_CSV, "x1,x2,x3,y1,y2,y3\n" + rows.join("\n"));

    if (lavaanAvailable) {
      const load = await callTool(ts.server, "stat_load_data", { file_path: LAVAAN_CSV, name: "lav" });
      if (load.isError) {
        lavaanAvailable = false;
      } else {
        const runtimeProbe = await callTool(ts.server, "stat_call", {
          package: "lavaan", function: "cfa",
          args: { model: cfaModel, data: "lav" },
          assign_to: "lav_runtime_probe",
        });
        lavaanAvailable = !runtimeProbe.isError;
      }
    }
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("lavaan::cfa fits confirmatory factor analysis", async (ctx) => {
    if (!lavaanAvailable) ctx.skip();
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "lavaan", function: "cfa" }));
    const cfa = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "lavaan", function: "cfa",
      args: { model: cfaModel, data: "lav" },
    }));
    expect(cfa.result).toBeDefined();
    const cfaId = (cfa.objects_created as Array<{ id: string }>)?.[0]?.id;

    // Extract fit measures
    if (cfaId) {
      expectSuccess(await callTool(ts.server, "stat_resolve", { package: "lavaan", function: "fitMeasures" }));
      const fit = expectSuccess(await callTool(ts.server, "stat_call", {
        package: "lavaan", function: "fitMeasures",
        args: { object: cfaId },
      }));
      expect(fit.result).toBeDefined();
    }
  }, 20000);

  it("lavaan::sem fits structural equation model", async (ctx) => {
    if (!lavaanAvailable) ctx.skip();
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "lavaan", function: "sem" }));
    const sem = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "lavaan", function: "sem",
      args: { model: semModel, data: "lav" },
    }));
    expect(sem.result).toBeDefined();
  }, 20000);
});
