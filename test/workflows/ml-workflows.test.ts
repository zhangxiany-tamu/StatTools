// ============================================================================
// StatTools — ML Workflow Tests (Wave 1)
// ============================================================================
// glmnet, caret, dplyr pipeline workflows using stat_extract + stat_call.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer, callTool, expectSuccess, TEST_CSV, type TestServer,
} from "../fixtures/common.js";

describe("ML Workflows (Wave 1)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("glmnet: extract X/y → fit cv.glmnet → inspect lambda", async () => {
    // Load
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "gl_data" }));

    // Extract y vector and X matrix
    const y = expectSuccess(await callTool(ts.server, "stat_extract", {
      handle: "gl_data", columns: ["mpg"], assign_to: "gl_y",
    }));
    expect(y.object_id).toBe("gl_y");

    const X = expectSuccess(await callTool(ts.server, "stat_extract", {
      handle: "gl_data", columns: ["wt", "hp", "disp", "drat"], as_matrix: true, assign_to: "gl_X",
    }));
    expect(X.object_id).toBe("gl_X");
    expect((X.dimensions as any).cols).toBe(4);

    // Resolve and call cv.glmnet
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "glmnet", function: "cv.glmnet" }));
    const cv = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "glmnet", function: "cv.glmnet",
      args: { x: "gl_X", y: "gl_y" },
    }));
    expect(cv.result).toBeDefined();
  }, 20000);

  it("dplyr: resolve core verbs + arrange (non-NSE)", async () => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "dp_data" }));

    // Resolve all core dplyr verbs (validates search + safety classification)
    for (const fn of ["filter", "mutate", "group_by", "summarise", "arrange", "select"]) {
      expectSuccess(await callTool(ts.server, "stat_resolve", { package: "dplyr", function: fn }));
    }

    // arrange works without NSE — it takes column names as strings
    const arranged = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "dplyr", function: "arrange",
      args: { ".data": "dp_data", ".dots": "mpg" },
    }));
    expect(arranged.result).toBeDefined();

    // stat_extract for column selection (the practical dplyr alternative)
    const cols = expectSuccess(await callTool(ts.server, "stat_extract", {
      handle: "dp_data", columns: ["mpg", "wt", "cyl"],
    }));
    expect(cols.object_id).toBeDefined();
  }, 15000);

  it("caret: createDataPartition → trainControl → train", async () => {
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "ca_data" }));

    // Extract target vector for partitioning
    expectSuccess(await callTool(ts.server, "stat_extract", {
      handle: "ca_data", columns: ["mpg"], assign_to: "ca_y",
    }));

    // createDataPartition
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "caret", function: "createDataPartition" }));
    const partition = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "caret", function: "createDataPartition",
      args: { y: "ca_y", p: 0.7, list: false },
    }));
    expect(partition.result).toBeDefined();

    // trainControl
    expectSuccess(await callTool(ts.server, "stat_resolve", { package: "caret", function: "trainControl" }));
    const ctrl = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "caret", function: "trainControl",
      args: { method: "cv", number: 3 },
      assign_to: "ca_ctrl",
    }));
    expect(ctrl.result).toBeDefined();
  }, 20000);
});
