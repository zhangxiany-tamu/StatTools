// ============================================================================
// StatTools — Phase 7 Coverage Tests
// ============================================================================
// Direct resolve/call coverage for newly classified package families.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import {
  createTestServer, callTool, expectSuccess, TEST_CSV, type TestServer,
} from "../fixtures/common.js";

const PANEL_CSV = "/tmp/stattools_phase7_panel.csv";
const GROUP_CSV = "/tmp/stattools_phase7_groups.csv";

describe("Phase 7 Coverage", () => {
  let ts: TestServer;

  beforeAll(async () => {
    writeFileSync(
      PANEL_CSV,
      "id,time,y,x\n1,1,10,1\n1,2,12,2\n1,3,13,3\n2,1,8,1\n2,2,9,2\n2,3,11,3\n3,1,7,1\n3,2,8,2\n3,3,10,3\n",
    );
    writeFileSync(
      GROUP_CSV,
      "grp,y,x\nA,10,1\nA,11,2\nA,9,3\nB,14,1\nB,15,2\nB,16,3\n",
    );
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("covers data helper families: readr/readxl/lubridate/stringr/forcats/janitor/data.table", async (ctx) => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "phase7_data" }));
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: GROUP_CSV, name: "phase7_groups" }));
    expectSuccess(await callTool(ts.server, "stat_extract", {
      handle: "phase7_groups", columns: ["grp"], assign_to: "phase7_grp",
    }));

    const readxlProbe = await callTool(ts.server, "stat_resolve", { package: "readxl", function: "format_from_ext" });
    const janitorProbe = await callTool(ts.server, "stat_resolve", { package: "janitor", function: "clean_names" });

    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "readr", function: "parse_number" }));
    expectSuccess(readxlProbe);
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "lubridate", function: "ymd" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "stringr", function: "str_detect" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "forcats", function: "as_factor" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "data.table", function: "between" }));

    let successes = 0;
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "readr", function: "parse_number",
      args: { x: "$1,234.50" },
    }));
    successes++;
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "readxl", function: "format_from_ext",
      args: { path: "report.xlsx" },
    }));
    successes++;
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "lubridate", function: "ymd",
      args: { "...": ["2020-01-01", "2020-02-03"] },
    }));
    successes++;
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stringr", function: "str_detect",
      args: { string: ["alpha", "beta"], pattern: "a" },
    }));
    successes++;
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "forcats", function: "as_factor",
      args: { x: "phase7_grp" },
    }));
    successes++;
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "data.table", function: "between",
      args: { x: 3, lower: 1, upper: 5 },
    }));
    successes++;

    if (!janitorProbe.isError) {
      expectSuccess(janitorProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "janitor", function: "clean_names",
        args: { dat: "phase7_data" },
      }));
      successes++;
    }

    expect(successes).toBeGreaterThanOrEqual(6);
  }, 20000);

  it("covers tree and boosting families: rpart/randomForest/e1071/xgboost", async (ctx) => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "tree_data" }));

    const xgboostProbe = await callTool(ts.server, "stat_resolve", { package: "xgboost", function: "xgb.DMatrix" });
    const rfProbe = await callTool(ts.server, "stat_resolve", { package: "randomForest", function: "randomForest" });
    const svmProbe = await callTool(ts.server, "stat_resolve", { package: "e1071", function: "naiveBayes" });
    const rpartProbe = await callTool(ts.server, "stat_resolve", { package: "rpart", function: "rpart" });
    let successes = 0;
    if (!rpartProbe.isError) {
      expectSuccess(rpartProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "rpart", function: "rpart",
        args: { formula: "am ~ wt + hp + disp", data: "tree_data" },
        assign_to: "tree_model",
      }));
      successes++;
    }

    if (!rfProbe.isError) {
      expectSuccess(rfProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "randomForest", function: "randomForest",
        args: { formula: "am ~ wt + hp + disp", data: "tree_data", ntree: 25 },
        assign_to: "rf_model",
      }));
      successes++;
    }

    if (!svmProbe.isError) {
      expectSuccess(svmProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "e1071", function: "naiveBayes",
        args: { formula: "am ~ wt + hp + disp", data: "tree_data" },
        assign_to: "nb_model",
      }));
      successes++;
    }

    if (!xgboostProbe.isError) {
      expectSuccess(xgboostProbe);
      expectSuccess(await callTool(ts.server, "stat_extract", {
        handle: "tree_data", columns: ["wt", "hp", "disp"], as_matrix: true, assign_to: "xgb_X",
      }));
      expectSuccess(await callTool(ts.server, "stat_extract", {
        handle: "tree_data", columns: ["am"], assign_to: "xgb_y",
      }));
      const dmatrix = expectSuccess(await callTool(ts.server, "stat_call", {
        package: "xgboost", function: "xgb.DMatrix",
        args: { data: "xgb_X", label: "xgb_y" },
        assign_to: "xgb_matrix",
      }));
      expect(dmatrix.object_id || dmatrix.result).toBeDefined();
      successes++;
    }

    if (successes === 0) ctx.skip();
    expect(successes).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("covers additive and panel model families: mgcv/nlme/plm", async (ctx) => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "gam_data" }));
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: PANEL_CSV, name: "panel_data" }));

    const mgcvProbe = await callTool(ts.server, "stat_resolve", { package: "mgcv", function: "gam" });
    const nlmeProbe = await callTool(ts.server, "stat_resolve", { package: "nlme", function: "lme" });
    const plmProbe = await callTool(ts.server, "stat_resolve", { package: "plm", function: "plm" });
    let successes = 0;
    if (!mgcvProbe.isError) {
      expectSuccess(mgcvProbe);
      const gam = expectSuccess(await callTool(ts.server, "stat_call", {
        package: "mgcv", function: "gam",
        args: { formula: "mpg ~ s(wt) + hp", data: "gam_data" },
        assign_to: "gam_model",
      }));
      expect(gam.object_id || gam.result).toBeDefined();
      successes++;
    }

    if (!nlmeProbe.isError) {
      expectSuccess(nlmeProbe);
      const lme = expectSuccess(await callTool(ts.server, "stat_call", {
        package: "nlme", function: "lme",
        args: { fixed: "mpg ~ wt + hp", random: "~ 1 | cyl", data: "gam_data" },
        assign_to: "lme_model",
      }));
      expect(lme.object_id || lme.result).toBeDefined();
      successes++;
    }

    if (!plmProbe.isError) {
      expectSuccess(plmProbe);
      const panel = expectSuccess(await callTool(ts.server, "stat_call", {
        package: "plm", function: "plm",
        args: { formula: "y ~ x", data: "panel_data", index: "id", model: "within" },
        assign_to: "plm_model",
      }));
      expect(panel.object_id || panel.result).toBeDefined();
      successes++;
    }

    if (successes === 0) ctx.skip();
    expect(successes).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("covers post-estimation families: emmeans/marginaleffects/performance/parameters/effectsize/bayestestR", async (ctx) => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: GROUP_CSV, name: "group_data" }));

    const emmeansProbe = await callTool(ts.server, "stat_resolve", { package: "emmeans", function: "emmeans" });
    const meProbe = await callTool(ts.server, "stat_resolve", { package: "marginaleffects", function: "avg_predictions" });
    const perfProbe = await callTool(ts.server, "stat_resolve", { package: "performance", function: "model_performance" });
    const paramsProbe = await callTool(ts.server, "stat_resolve", { package: "parameters", function: "model_parameters" });
    const esProbe = await callTool(ts.server, "stat_resolve", { package: "effectsize", function: "cohens_d" });
    const bayesProbe = await callTool(ts.server, "stat_resolve", { package: "bayestestR", function: "hdi" });
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "stats", function: "lm" }));
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "stats", function: "aov" }));

    const lm = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats", function: "lm",
      args: { formula: "y ~ x + grp", data: "group_data" },
      assign_to: "phase7_lm",
    }));
    expect(lm.object_id || lm.result).toBeDefined();

    const aov = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats", function: "aov",
      args: { formula: "y ~ grp", data: "group_data" },
      assign_to: "phase7_aov",
    }));
    expect(aov.object_id || aov.result).toBeDefined();

    let available = 0;
    let successes = 0;
    if (!perfProbe.isError) {
      available++;
      expectSuccess(perfProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "performance", function: "model_performance",
        args: { model: "phase7_lm" },
      }));
      successes++;
    }
    if (!paramsProbe.isError) {
      available++;
      expectSuccess(paramsProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "parameters", function: "model_parameters",
        args: { model: "phase7_lm" },
      }));
      successes++;
    }
    if (!meProbe.isError) {
      available++;
      expectSuccess(meProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "marginaleffects", function: "avg_predictions",
        args: { model: "phase7_lm" },
      }));
      successes++;
    }
    if (!emmeansProbe.isError) {
      available++;
      expectSuccess(emmeansProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "emmeans", function: "emmeans",
        args: { object: "phase7_aov", specs: "grp" },
      }));
      successes++;
    }
    if (!esProbe.isError) {
      available++;
      expectSuccess(esProbe);
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "effectsize", function: "cohens_d",
        args: { x: "y ~ grp", data: "group_data" },
      }));
      successes++;
    }
    if (!bayesProbe.isError) {
      available++;
      expectSuccess(bayesProbe);
      expectSuccess(await callTool(ts.server, "stat_extract", {
        handle: "group_data", columns: ["y"], assign_to: "phase7_y_for_hdi",
      }));
      expectSuccess(await callTool(ts.server, "stat_call", {
        package: "bayestestR", function: "hdi",
        args: { x: "phase7_y_for_hdi" },
      }));
      successes++;
    }

    if (available === 0) ctx.skip();
    expect(successes).toBe(available);
    expect(successes).toBeGreaterThanOrEqual(1);
  }, 30000);
});
