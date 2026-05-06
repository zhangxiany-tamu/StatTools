// ============================================================================
// StatTools — Dataset Loader + dot_args Workflow Tests
// ============================================================================
// Round 4 quick wins: stat_load_data accepts `dataset` for built-in R
// datasets (no CSV detour), and stat_call accepts `dot_args` for
// multi-object dispatch like anova(m1, m2) where the unnamed positional
// args should be resolved as session handles, not parsed as expressions.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestServer,
  callTool,
  expectSuccess,
  type TestServer,
} from "../fixtures/common.js";

describe("stat_load_data with dataset (built-in R datasets)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("loads mtcars from base R datasets package", async () => {
    const out = expectSuccess(await callTool(ts.server, "stat_load_data", {
      dataset: "mtcars",
    }));
    expect(out.object_id).toBe("mtcars");
    const dims = out.dimensions as Record<string, number>;
    expect(dims.rows).toBe(32);
    expect(dims.cols).toBe(11);
    expect(out.source).toEqual({ dataset: "mtcars", package: "datasets" });
  }, 15000);

  it("loads sleepstudy from lme4 package via explicit package arg", async () => {
    const out = expectSuccess(await callTool(ts.server, "stat_load_data", {
      dataset: "sleepstudy",
      package: "lme4",
    }));
    expect(out.object_id).toBe("sleepstudy");
    expect((out.source as Record<string, string>).package).toBe("lme4");
  }, 15000);

  it("loads iris and lets stats::prcomp resolve it", async () => {
    expectSuccess(await callTool(ts.server, "stat_load_data", {
      dataset: "iris",
    }));
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "prcomp",
    }));
    // prcomp accepts a data frame via x; we can verify the handle is reachable
    const session = expectSuccess(await callTool(ts.server, "stat_session", {}));
    const handles = session.handles as Array<{ id: string }>;
    expect(handles.find((h) => h.id === "iris")).toBeDefined();
  }, 15000);

  it("renames the handle when name is provided", async () => {
    const out = expectSuccess(await callTool(ts.server, "stat_load_data", {
      dataset: "AirPassengers",
      name: "ap",
    }));
    expect(out.object_id).toBe("ap");
  }, 15000);

  it("returns a clear error when neither file_path nor dataset is given", async () => {
    const out = await callTool(ts.server, "stat_load_data", {});
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/file_path.*dataset|dataset.*file_path/i);
  });

  it("returns a clear error when both file_path and dataset are given", async () => {
    const out = await callTool(ts.server, "stat_load_data", {
      file_path: "/tmp/x.csv",
      dataset: "mtcars",
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/not both|either/i);
  });

  it("returns a clear error for an unknown dataset name", async () => {
    const out = await callTool(ts.server, "stat_load_data", {
      dataset: "no_such_dataset_xyz",
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/no_such_dataset_xyz|not found|materialized/i);
  }, 15000);
});

describe("stat_call with dot_args (multi-object dispatch)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
    // Load data + fit two models we can compare via anova
    expectSuccess(await callTool(ts.server, "stat_load_data", {
      dataset: "mtcars",
    }));
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "lm",
    }));
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt", data: "mtcars" },
      assign_to: "m1",
    }));
    expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt + hp", data: "mtcars" },
      assign_to: "m2",
    }));
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("anova(m1, m2) via dot_args resolves both handles and runs the F test", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "anova",
    }));
    const out = expectSuccess(await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "anova",
      args: { object: "m1" },
      dot_args: ["m2"],
    }));
    expect(out.result).toBeDefined();
  }, 15000);

  it("returns a clear error when a dot_args entry is not a registered handle", async () => {
    expectSuccess(await callTool(ts.server, "stat_resolve", {
      package: "stats",
      function: "anova",
    }));
    const out = await callTool(ts.server, "stat_call", {
      package: "stats",
      function: "anova",
      args: { object: "m1" },
      dot_args: ["nonexistent_handle_xyz"],
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content[0].text);
    expect(err.message).toMatch(/not found in session/i);
  }, 15000);
});
