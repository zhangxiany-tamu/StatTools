// ============================================================================
// StatTools — Stage 2 Fixtures
// ============================================================================
// Loads a small library of canonical test inputs into the StatTools session
// once per harness run. Recipes reference these fixtures by name; the harness
// passes the corresponding handle ID to stat_call.
//
// Materialization paths:
//   - Built-in R datasets (mtcars, iris, AirPassengers, sleepstudy, lung):
//     loaded via stat_load_data's `dataset` slot, which calls R's data() and
//     registers a session handle.
//   - Numeric vectors / matrices: built via stat_call against base functions
//     that accept named arguments (seq, as.numeric, matrix, factor) so values
//     pass through `args` cleanly without quosure trickery.
//   - Fitted lm / glm: stat_call against stats::lm / stats::glm using a loaded
//     mtcars handle.
// ============================================================================

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type FixtureKind =
  | "data_frame"
  | "ts"
  | "numeric_vector"
  | "factor"
  | "matrix"
  | "table"
  | "model";

export type Fixture = {
  /** session handle ID (== assign_to / dataset name) */
  id: string;
  kind: FixtureKind;
  description: string;
};

export type FixtureLibrary = {
  byName: Map<string, Fixture>;
  dataFrames: { mtcars: string; iris: string; sleepstudy: string; lung: string };
  timeSeries: { AirPassengers: string };
  vectors: { x: string; y: string; xy_pair: [string, string]; char: string };
  groups: { factor3: string };
  matrices: { m5x5: string; cormat: string };
  tables: { twoByTwo: string };
  models: { lm_mtcars: string; glm_mtcars: string; aov_mtcars: string };
  draws: { posterior: string };
};

type ToolResponse = { content: Array<{ type: string; text: string }>; isError?: boolean };
type FixtureStepResult = { ok: true } | { ok: false; error: string };

async function callTool(server: Server, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const handler = (server as any)._requestHandlers?.get("tools/call");
  return (await handler({ method: "tools/call", params: { name, arguments: args } })) as ToolResponse;
}

function parseJson(r: ToolResponse): Record<string, unknown> {
  try {
    return JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorOf(r: ToolResponse): string | null {
  if (!r.isError) return null;
  const parsed = parseJson(r);
  return (parsed.message as string) ?? "unknown error";
}

async function ensureResolved(server: Server, pkg: string, fn: string): Promise<void> {
  await callTool(server, "stat_resolve", { package: pkg, function: fn });
}

async function loadDataset(
  server: Server,
  dataset: string,
  pkg: string | undefined,
  handleName: string,
): Promise<FixtureStepResult> {
  const args: Record<string, unknown> = { dataset, name: handleName };
  if (pkg) args.package = pkg;
  const resp = await callTool(server, "stat_load_data", args);
  const err = errorOf(resp);
  return err ? { ok: false, error: err } : { ok: true };
}

async function buildViaCall(
  server: Server,
  pkg: string,
  fn: string,
  callArgs: Record<string, unknown>,
  assignTo: string,
): Promise<FixtureStepResult> {
  const resp = await callTool(server, "stat_call", { package: pkg, function: fn, ...callArgs, assign_to: assignTo });
  const err = errorOf(resp);
  return err ? { ok: false, error: err } : { ok: true };
}

async function buildViaExtract(
  server: Server,
  handle: string,
  columns: string[],
  asMatrix: boolean,
  assignTo: string,
): Promise<FixtureStepResult> {
  const args: Record<string, unknown> = { handle, columns, assign_to: assignTo };
  if (asMatrix) args.as_matrix = true;
  const resp = await callTool(server, "stat_extract", args);
  const err = errorOf(resp);
  return err ? { ok: false, error: err } : { ok: true };
}

// Seeded normal sampler (LCG + Box-Muller) so the posterior_draws fixture is
// reproducible across runs without relying on R's RNG state. Statistical
// quality doesn't matter — recipes just need a 3-column numeric data frame.
function seededNormals(n: number, mean: number, sd: number, seed: number): number[] {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 1) / 0x100000001; // open interval (0, 1)
  };
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = rand();
    const u2 = rand();
    out[i] = mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return out;
}

/**
 * Build the standard fixture library. Throws if any fixture fails — recipes
 * reference these by name, and a missing fixture would silently break recipes
 * that depend on it.
 */
export async function buildFixtures(server: Server, log: (s: string) => void = () => {}): Promise<FixtureLibrary> {
  // Resolve everything we'll call.
  await ensureResolved(server, "stats", "lm");
  await ensureResolved(server, "stats", "glm");
  await ensureResolved(server, "stats", "aov");
  await ensureResolved(server, "stats", "cor");
  await ensureResolved(server, "base", "as.character");
  await ensureResolved(server, "base", "matrix");
  await ensureResolved(server, "base", "data.frame");

  const fx: Fixture[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  type Step =
    | { kind: "dataset"; name: string; pkg?: string; handle: string; type: FixtureKind; description: string }
    | { kind: "call";    pkg: string; fn: string; args: Record<string, unknown>; handle: string; type: FixtureKind; description: string }
    | { kind: "extract"; from: string; columns: string[]; asMatrix: boolean; handle: string; type: FixtureKind; description: string };

  const steps: Step[] = [
    // ----- built-in datasets (stat_load_data with `dataset` slot) -----
    { kind: "dataset", name: "mtcars",        handle: "mtcars",        type: "data_frame", description: "32 cars × 11 vars" },
    { kind: "dataset", name: "iris",          handle: "iris",          type: "data_frame", description: "150 flowers × 5 vars (Species)" },
    { kind: "dataset", name: "AirPassengers", handle: "AirPassengers", type: "ts",         description: "monthly airline passengers ts (frequency=12)" },
    { kind: "dataset", name: "sleepstudy",    pkg: "lme4",             handle: "sleepstudy", type: "data_frame", description: "180 obs × 3 vars (Reaction, Days, Subject)" },
    // survival's "lung" dataset is loaded under the `cancer` name
    { kind: "dataset", name: "cancer",        pkg: "survival",         handle: "lung",      type: "data_frame", description: "228 NCCTG lung-cancer obs × 10 vars" },

    // ----- vectors / factor / matrix derived via stat_extract from loaded frames -----
    { kind: "extract", from: "mtcars", columns: ["mpg"],     asMatrix: false, handle: "vec_x",    type: "numeric_vector", description: "mtcars$mpg (32-vector)" },
    { kind: "extract", from: "mtcars", columns: ["wt"],      asMatrix: false, handle: "vec_y",    type: "numeric_vector", description: "mtcars$wt (32-vector)" },
    { kind: "extract", from: "iris",   columns: ["Species"], asMatrix: false, handle: "factor3",  type: "factor",         description: "iris$Species (3-level factor)" },
    { kind: "extract", from: "mtcars", columns: ["mpg", "cyl", "disp", "hp", "wt"], asMatrix: true, handle: "matrix5x5", type: "matrix", description: "mtcars[, 1:5] as numeric matrix" },

    // ----- character vector + correlation matrix derived -----
    { kind: "call", pkg: "base", fn: "as.character",
      args: { args: { x: "factor3" } },
      handle: "char_vec", type: "numeric_vector", description: "as.character(iris$Species) (150-char vector)" },
    { kind: "call", pkg: "stats", fn: "cor",
      args: { args: { x: "matrix5x5" } },
      handle: "cormat5x5", type: "matrix", description: "5×5 correlation matrix from matrix5x5" },
    // 2×2 contingency-shaped matrix. Despite the `table2x2` handle name
    // (kept for backwards compatibility with existing recipes), this is an R
    // matrix, not a `table` object — base::as.table is unclassified in the
    // safety registry and effectsize::Yule* functions accept a matrix anyway.
    { kind: "call", pkg: "base", fn: "matrix",
      args: { args: { data: [12, 5, 7, 20], nrow: 2 }, coerce: { data: "numeric" } },
      handle: "table2x2", type: "matrix", description: "2×2 contingency matrix (numeric)" },

    // ----- simulated posterior draws (3 cols × 1000 rows, seeded JS-side) -----
    { kind: "call", pkg: "base", fn: "data.frame",
      args: {
        args: {
          b0:    seededNormals(1000, 0,   1,   42),
          b1:    seededNormals(1000, 0.5, 0.4, 43),
          sigma: seededNormals(1000, 1,   0.3, 44).map(Math.abs),
        },
        coerce: { b0: "numeric", b1: "numeric", sigma: "numeric" },
      },
      handle: "posterior_draws", type: "data_frame",
      description: "1000 × 3 simulated posterior draws (b0, b1, sigma)" },

    // ----- fitted models -----
    { kind: "call", pkg: "stats", fn: "lm",
      args: { args: { formula: "mpg ~ wt + hp", data: "mtcars" } },
      handle: "lm_mtcars", type: "model", description: "lm(mpg ~ wt + hp) on mtcars" },
    { kind: "call", pkg: "stats", fn: "glm",
      args: { args: { formula: "I(am == 1) ~ mpg + wt", data: "mtcars", family: "binomial" } },
      handle: "glm_mtcars", type: "model", description: "logistic glm(am ~ mpg + wt)" },
    { kind: "call", pkg: "stats", fn: "aov",
      args: { args: { formula: "mpg ~ factor(cyl)", data: "mtcars" } },
      handle: "aov_mtcars", type: "model", description: "aov(mpg ~ factor(cyl)) on mtcars" },
  ];

  for (const step of steps) {
    log(`  loading fixture ${step.handle} (${step.description})...`);
    let result: FixtureStepResult;
    if (step.kind === "dataset") {
      result = await loadDataset(server, step.name, step.pkg, step.handle);
    } else if (step.kind === "extract") {
      result = await buildViaExtract(server, step.from, step.columns, step.asMatrix, step.handle);
    } else {
      result = await buildViaCall(server, step.pkg, step.fn, step.args, step.handle);
    }
    if (result.ok === false) {
      failures.push({ id: step.handle, error: result.error });
      continue;
    }
    fx.push({ id: step.handle, kind: step.type, description: step.description });
  }

  if (failures.length > 0) {
    const lines = failures.map((f) => `  ${f.id}: ${f.error}`).join("\n");
    throw new Error(`Fixture build failed:\n${lines}`);
  }

  const byName = new Map<string, Fixture>(fx.map((f) => [f.id, f]));
  return {
    byName,
    dataFrames: { mtcars: "mtcars", iris: "iris", sleepstudy: "sleepstudy", lung: "lung" },
    timeSeries: { AirPassengers: "AirPassengers" },
    vectors: { x: "vec_x", y: "vec_y", xy_pair: ["vec_x", "vec_y"], char: "char_vec" },
    groups: { factor3: "factor3" },
    matrices: { m5x5: "matrix5x5", cormat: "cormat5x5" },
    tables: { twoByTwo: "table2x2" },
    models: { lm_mtcars: "lm_mtcars", glm_mtcars: "glm_mtcars", aov_mtcars: "aov_mtcars" },
    draws: { posterior: "posterior_draws" },
  };
}
