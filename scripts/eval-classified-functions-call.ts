#!/usr/bin/env tsx
// ============================================================================
// StatTools — Classified-Function Eval · Stage 2 (stat_call)
// ============================================================================
// For every function that resolves cleanly in Stage 1, attempt a stat_call
// using the recipe table (exact recipes first, schema-pattern fallback). Per
// the original plan: do NOT blindly call all 2k functions; skip with a
// reason when no safe recipe exists.
//
// Output:
//   reports/classified-functions-call.jsonl   one record per function
//   reports/classified-functions-call.md      human-readable summary
//
// Buckets recorded:
//   call_pass                — recipe ran, no error
//   call_fail                — recipe ran, error returned
//   skipped_no_recipe        — neither exact nor pattern matched
//   skipped_missing_package  — meta.installed=0 or schema unavailable
//   skipped_external_state   — known external-state-required (ignored class)
//   skipped_too_slow         — exceeded per-call timeout
//
// Usage:
//   PYTHON_PATH=/path/to/python3 tsx scripts/eval-classified-functions-call.ts
// Optional flags:
//   --limit=N           cap the inventory (smoke testing)
//   --packages=a,b      restrict to listed packages
//   --timeout=ms        per-call timeout, default 15000
//   --restart-every=N   recycle the server every N calls (default 250)
// ============================================================================

import { createStatToolsServer, type ServerConfig } from "../src/server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, createWriteStream, type WriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { buildFixtures, type FixtureLibrary } from "./eval-stage2/fixtures.js";
import { makeRecipeLookup, type RecipeLookup, type ResolvedSchema } from "./eval-stage2/recipes.js";

// ----------------------------------------------------------------------------
// Paths & flags
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot(__dirname);
const DB_PATH = resolve(PROJECT_ROOT, "data", "stattools.db");
const REPORTS_DIR = resolve(PROJECT_ROOT, "reports");
const JSONL_PATH = resolve(REPORTS_DIR, "classified-functions-call.jsonl");
const MARKDOWN_PATH = resolve(REPORTS_DIR, "classified-functions-call.md");

const PYTHON_PATH = process.env.PYTHON_PATH || "python3";
const R_PATH = process.env.R_PATH || "Rscript";

type Flags = {
  limit: number | null;
  packages: Set<string> | null;
  timeoutMs: number;
  restartEvery: number;
};

function parseFlags(argv: string[]): Flags {
  const out: Flags = { limit: null, packages: null, timeoutMs: 15_000, restartEvery: 250 };
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq < 0) continue;
    const key = arg.slice(0, eq);
    const val = arg.slice(eq + 1);
    if (key === "--limit") out.limit = Number.parseInt(val, 10);
    else if (key === "--packages") out.packages = new Set(val.split(",").map((s) => s.trim()).filter(Boolean));
    else if (key === "--timeout") out.timeoutMs = Number.parseInt(val, 10);
    else if (key === "--restart-every") out.restartEvery = Number.parseInt(val, 10);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Inventory & tool plumbing
// ----------------------------------------------------------------------------

type InventoryRow = {
  id: string;
  package: string;
  name: string;
  safety_class: "safe" | "callable_with_caveats";
  installed: 0 | 1;
};

function loadInventory(dbPath: string, packages: Set<string> | null): InventoryRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const sql = `
      SELECT f.id AS id, f.package AS package, f.name AS name,
             f.safety_class AS safety_class,
             COALESCE(p.installed, 0) AS installed
      FROM functions f
      LEFT JOIN packages p ON p.name = f.package
      WHERE f.safety_class IN ('safe', 'callable_with_caveats')
        AND COALESCE(f.is_stub, 0) = 0
      ORDER BY f.package, f.name
    `;
    const rows = db.prepare(sql).all() as InventoryRow[];
    if (packages && packages.size > 0) return rows.filter((r) => packages.has(r.package));
    return rows;
  } finally {
    db.close();
  }
}

type ToolResponse = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function callToolRaw(server: Server, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const handler = (server as any)._requestHandlers?.get("tools/call");
  return (await handler({ method: "tools/call", params: { name, arguments: args } })) as ToolResponse;
}

async function callToolWithTimeout(
  server: Server,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolResponse> {
  let timer: NodeJS.Timeout | null = null;
  const callP = callToolRaw(server, name, args);
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return (await Promise.race([callP, timeoutP])) as ToolResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJson(r: ToolResponse): Record<string, unknown> {
  try {
    return JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------
// Result records
// ----------------------------------------------------------------------------

type Outcome =
  | "call_pass"
  | "call_fail"
  | "skipped_no_recipe"
  | "skipped_missing_package"
  | "skipped_unresolvable"
  | "skipped_too_slow";

type CallRecord = {
  id: string;
  package: string;
  function: string;
  safety_class: "safe" | "callable_with_caveats";
  outcome: Outcome;
  recipe: string | null;
  duration_ms: number;
  error_message: string | null;
};

// ----------------------------------------------------------------------------
// Server lifecycle
// ----------------------------------------------------------------------------

async function startServer(): Promise<{ server: Server; cleanup: () => Promise<void>; fixtures: FixtureLibrary }> {
  const config: ServerConfig = {
    dbPath: DB_PATH,
    allowedDataRoots: [PROJECT_ROOT, "/tmp"],
    rPath: R_PATH,
    pythonPath: PYTHON_PATH,
  };
  const { server, cleanup } = await createStatToolsServer(config);
  const fixtures = await buildFixtures(server, (m) => process.stdout.write(m + "\n"));
  return { server, cleanup, fixtures };
}

// ----------------------------------------------------------------------------
// Per-row execution
// ----------------------------------------------------------------------------

async function runOne(
  server: Server,
  row: InventoryRow,
  lookup: RecipeLookup,
  timeoutMs: number,
): Promise<CallRecord> {
  const t0 = Date.now();

  // 1. Resolve to get schema (also reactivates session if server was restarted)
  let schema: ResolvedSchema | undefined;
  try {
    const resp = await callToolWithTimeout(server, "stat_resolve", { package: row.package, function: row.name }, timeoutMs);
    const parsed = parseJson(resp);
    if (resp.isError || parsed.error === true) {
      const lower = ((parsed.message as string) ?? "").toLowerCase();
      const outcome: Outcome = lower.includes("not installed") ? "skipped_missing_package" : "skipped_unresolvable";
      return {
        id: row.id, package: row.package, function: row.name, safety_class: row.safety_class,
        outcome, recipe: null, duration_ms: Date.now() - t0,
        error_message: (parsed.message as string) ?? "resolve failed",
      };
    }
    schema = parsed.schema as ResolvedSchema | undefined;
  } catch (err) {
    return {
      id: row.id, package: row.package, function: row.name, safety_class: row.safety_class,
      outcome: "skipped_unresolvable", recipe: null, duration_ms: Date.now() - t0,
      error_message: (err as Error).message,
    };
  }

  // 2. Recipe lookup
  const lk = lookup(row.package, row.name, schema);
  if ("skip" in lk) {
    return {
      id: row.id, package: row.package, function: row.name, safety_class: row.safety_class,
      outcome: "skipped_no_recipe", recipe: null, duration_ms: Date.now() - t0,
      error_message: lk.reason,
    };
  }

  // 3. stat_call with the recipe
  const callArgs: Record<string, unknown> = { package: row.package, function: row.name };
  if (lk.args) callArgs.args = lk.args;
  if (lk.expressions) callArgs.expressions = lk.expressions;
  if (lk.dot_expressions) callArgs.dot_expressions = lk.dot_expressions;
  if (lk.dot_args) callArgs.dot_args = lk.dot_args;
  if (lk.coerce) callArgs.coerce = lk.coerce;

  try {
    const resp = await callToolWithTimeout(server, "stat_call", callArgs, timeoutMs);
    const parsed = parseJson(resp);
    if (resp.isError || parsed.error === true) {
      return {
        id: row.id, package: row.package, function: row.name, safety_class: row.safety_class,
        outcome: "call_fail", recipe: lk.recipe, duration_ms: Date.now() - t0,
        error_message: (parsed.message as string) ?? "call failed",
      };
    }
    return {
      id: row.id, package: row.package, function: row.name, safety_class: row.safety_class,
      outcome: "call_pass", recipe: lk.recipe, duration_ms: Date.now() - t0,
      error_message: null,
    };
  } catch (err) {
    const message = (err as Error).message;
    return {
      id: row.id, package: row.package, function: row.name, safety_class: row.safety_class,
      outcome: message.includes("timed out") ? "skipped_too_slow" : "call_fail",
      recipe: lk.recipe, duration_ms: Date.now() - t0,
      error_message: message,
    };
  }
}

// ----------------------------------------------------------------------------
// Markdown summary
// ----------------------------------------------------------------------------

function topN<K>(map: Map<K, number>, n: number): Array<[K, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function renderMarkdown(records: CallRecord[], startedAt: Date, endedAt: Date): string {
  const total = records.length;
  const counts = new Map<Outcome, number>();
  const failByPkg = new Map<string, number>();
  const failMsgs = new Map<string, number>();

  for (const r of records) {
    counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
    if (r.outcome === "call_fail") {
      failByPkg.set(r.package, (failByPkg.get(r.package) ?? 0) + 1);
      const key = (r.error_message ?? "").split("\n")[0].slice(0, 160);
      if (key) failMsgs.set(key, (failMsgs.get(key) ?? 0) + 1);
    }
  }

  const attempted = (counts.get("call_pass") ?? 0) + (counts.get("call_fail") ?? 0);
  const passRate = attempted === 0 ? 0 : ((counts.get("call_pass") ?? 0) / attempted) * 100;
  const durationS = ((endedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);

  const lines: string[] = [];
  lines.push("# StatTools — Classified-Function Eval (Stage 2: stat_call)\n");
  lines.push(`- **Run started**: ${startedAt.toISOString()}`);
  lines.push(`- **Run ended**: ${endedAt.toISOString()}`);
  lines.push(`- **Wall time**: ${durationS}s`);
  lines.push(`- **Database**: \`data/stattools.db\`\n`);

  lines.push("## Headline numbers\n");
  lines.push("| Metric | Count |");
  lines.push("|---|---:|");
  lines.push(`| Total inventory | ${total} |`);
  lines.push(`| Attempted (pass + fail) | ${attempted} |`);
  lines.push(`| call_pass | ${counts.get("call_pass") ?? 0} |`);
  lines.push(`| call_fail | ${counts.get("call_fail") ?? 0} |`);
  lines.push(`| Pass rate (of attempted) | ${passRate.toFixed(2)}% |\n`);

  lines.push("## All buckets\n");
  lines.push("| outcome | count |");
  lines.push("|---|---:|");
  for (const k of ["call_pass", "call_fail", "skipped_no_recipe", "skipped_missing_package", "skipped_unresolvable", "skipped_too_slow"] as Outcome[]) {
    lines.push(`| ${k} | ${counts.get(k) ?? 0} |`);
  }
  lines.push("");

  lines.push("## Top 20 packages by call_fail count\n");
  if (failByPkg.size === 0) {
    lines.push("_No call_fail records._");
  } else {
    lines.push("| package | failures |");
    lines.push("|---|---:|");
    for (const [pkg, n] of topN(failByPkg, 20)) lines.push(`| ${pkg} | ${n} |`);
  }
  lines.push("");

  lines.push("## Top 20 call_fail messages\n");
  if (failMsgs.size === 0) {
    lines.push("_No call_fail records._");
  } else {
    lines.push("| count | message |");
    lines.push("|---:|---|");
    for (const [msg, n] of topN(failMsgs, 20)) {
      const escaped = msg.replace(/\|/g, "\\|");
      lines.push(`| ${n} | ${escaped} |`);
    }
  }
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  if (!existsSync(DB_PATH)) {
    console.error(`stattools.db not found at ${DB_PATH}`);
    process.exit(1);
  }
  mkdirSync(REPORTS_DIR, { recursive: true });

  const inventory = loadInventory(DB_PATH, flags.packages);
  const target = flags.limit != null ? inventory.slice(0, flags.limit) : inventory;
  console.log(`Inventory: ${inventory.length} non-stub safe/callable functions; running on ${target.length}.`);
  console.log(`Output: ${JSONL_PATH}`);

  let { server, cleanup, fixtures } = await startServer();
  let lookup = makeRecipeLookup(fixtures);

  const jsonl: WriteStream = createWriteStream(JSONL_PATH, { flags: "w" });
  const records: CallRecord[] = [];
  const startedAt = new Date();
  let lastLog = 0;
  const total = target.length;

  try {
    for (let i = 0; i < total; i++) {
      const row = target[i];
      const rec = await runOne(server, row, lookup, flags.timeoutMs);
      records.push(rec);
      jsonl.write(JSON.stringify(rec) + "\n");

      const now = Date.now();
      if (i + 1 === total || (i + 1) % 100 === 0 || now - lastLog > 10_000) {
        const pass = records.filter((r) => r.outcome === "call_pass").length;
        const fail = records.filter((r) => r.outcome === "call_fail").length;
        const skipped = records.length - pass - fail;
        console.log(`  [${i + 1}/${total}] pass=${pass} fail=${fail} skipped=${skipped} elapsed=${((now - startedAt.getTime()) / 1000).toFixed(0)}s`);
        lastLog = now;
      }

      // Worker recycling — restart server every N calls to limit pollution
      if ((i + 1) % flags.restartEvery === 0 && i + 1 < total) {
        process.stdout.write(`  -- recycling server after ${i + 1} calls --\n`);
        await cleanup();
        ({ server, cleanup, fixtures } = await startServer());
        lookup = makeRecipeLookup(fixtures);
      }
    }
  } finally {
    jsonl.end();
    await cleanup();
  }

  const endedAt = new Date();
  writeFileSync(MARKDOWN_PATH, renderMarkdown(records, startedAt, endedAt), "utf-8");

  const counts = new Map<Outcome, number>();
  for (const r of records) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const attempted = (counts.get("call_pass") ?? 0) + (counts.get("call_fail") ?? 0);
  const passRate = attempted === 0 ? 0 : ((counts.get("call_pass") ?? 0) / attempted) * 100;
  console.log("");
  console.log("=== Stage 2 complete ===");
  console.log(`Inventory: ${total}`);
  console.log(`Attempted: ${attempted}`);
  console.log(`call_pass: ${counts.get("call_pass") ?? 0}`);
  console.log(`call_fail: ${counts.get("call_fail") ?? 0}`);
  console.log(`Pass rate of attempted: ${passRate.toFixed(2)}%`);
  console.log(`Skipped (no recipe): ${counts.get("skipped_no_recipe") ?? 0}`);
  console.log(`Skipped (missing pkg): ${counts.get("skipped_missing_package") ?? 0}`);
  console.log(`Skipped (unresolvable): ${counts.get("skipped_unresolvable") ?? 0}`);
  console.log(`Skipped (too slow): ${counts.get("skipped_too_slow") ?? 0}`);
  console.log(`JSONL: ${JSONL_PATH}`);
  console.log(`MD:    ${MARKDOWN_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
