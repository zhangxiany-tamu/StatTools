#!/usr/bin/env tsx
// ============================================================================
// StatTools — Classified-Function Eval Harness · Stage 1 (resolve only)
// ============================================================================
// Inventories every safe/callable non-stub function from data/stattools.db,
// starts an in-process StatTools server, calls stat_resolve for each, and
// writes:
//   - reports/classified-functions-resolve.jsonl  (one record per function)
//   - reports/classified-functions-resolve.md     (human-readable summary)
//
// No stat_call attempted in this stage — the goal is to confirm that every
// classified function can be discovered, schema-extracted, and registered as
// resolved.
//
// Usage:
//   PYTHON_PATH=/path/to/python3 tsx scripts/eval-classified-functions.ts
// Optional flags:
//   --limit=N        only resolve the first N inventory rows (smoke test)
//   --packages=a,b   only resolve rows whose package is in the list
//   --timeout=ms     per-call timeout (default 20000)
// ============================================================================

import { createStatToolsServer, type ServerConfig } from "../src/server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------

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
const JSONL_PATH = resolve(REPORTS_DIR, "classified-functions-resolve.jsonl");
const MARKDOWN_PATH = resolve(REPORTS_DIR, "classified-functions-resolve.md");

const PYTHON_PATH = process.env.PYTHON_PATH || "python3";
const R_PATH = process.env.R_PATH || "Rscript";

// ---------------------------------------------------------------------------
// CLI flag parsing (no external dep)
// ---------------------------------------------------------------------------

type Flags = {
  limit: number | null;
  packages: Set<string> | null;
  timeoutMs: number;
};

function parseFlags(argv: string[]): Flags {
  const out: Flags = { limit: null, packages: null, timeoutMs: 20_000 };
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq < 0) continue;
    const key = arg.slice(0, eq);
    const val = arg.slice(eq + 1);
    if (key === "--limit") out.limit = Number.parseInt(val, 10);
    else if (key === "--packages") {
      out.packages = new Set(val.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (key === "--timeout") out.timeoutMs = Number.parseInt(val, 10);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inventory query
// ---------------------------------------------------------------------------

type InventoryRow = {
  id: string;
  package: string;
  name: string;
  safety_class: "safe" | "callable_with_caveats";
  installed: 0 | 1;
  has_formula_arg: 0 | 1;
  has_dots: 0 | 1;
  title: string | null;
};

function loadInventory(dbPath: string, packages: Set<string> | null): InventoryRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const sql = `
      SELECT
        f.id              AS id,
        f.package         AS package,
        f.name            AS name,
        f.safety_class    AS safety_class,
        COALESCE(p.installed, 0) AS installed,
        f.has_formula_arg AS has_formula_arg,
        f.has_dots        AS has_dots,
        f.title           AS title
      FROM functions f
      LEFT JOIN packages p ON p.name = f.package
      WHERE f.safety_class IN ('safe', 'callable_with_caveats')
        AND COALESCE(f.is_stub, 0) = 0
      ORDER BY f.package, f.name
    `;
    const rows = db.prepare(sql).all() as InventoryRow[];
    if (packages && packages.size > 0) {
      return rows.filter((r) => packages.has(r.package));
    }
    return rows;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Tool invocation
// ---------------------------------------------------------------------------

type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolResponse> {
  const handler = (server as any)._requestHandlers?.get("tools/call");
  if (!handler) throw new Error("MCP server has no tools/call handler");
  const callP = handler({ method: "tools/call", params: { name, arguments: args } });
  let timer: NodeJS.Timeout | null = null;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return (await Promise.race([callP, timeoutP])) as ToolResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseToolJson(r: ToolResponse): Record<string, unknown> {
  const text = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: true, message: `non-JSON response: ${text.slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Result classification
// ---------------------------------------------------------------------------

type ResolveStatus = "pass" | "fail";
type ErrorCode =
  | "missing_package"
  | "schema_extract_fail"
  | "unsafe_regression"
  | "unclassified_regression"
  | "stub_regression"
  | "not_found"
  | "python_runtime_unavailable"
  | "timeout"
  | "exception"
  | "other";

type ResolveRecord = {
  id: string;
  package: string;
  function: string;
  safety_class: "safe" | "callable_with_caveats";
  installed: boolean;
  resolve: ResolveStatus;
  error_code: ErrorCode | null;
  error_message: string | null;
  duration_ms: number;
};

function classifyError(parsed: Record<string, unknown>): { code: ErrorCode; message: string } {
  const msg = (parsed.message as string) ?? "unknown error";
  const lower = msg.toLowerCase();

  // Order matters: be specific before generic. The phrases come from
  // src/tools/statResolve.ts and src/server.ts.
  if (parsed.is_stub === true) return { code: "stub_regression", message: msg };
  if (parsed.safety_class === "unsafe") return { code: "unsafe_regression", message: msg };
  if (parsed.safety_class === "unclassified") return { code: "unclassified_regression", message: msg };
  if (lower.includes("not installed")) return { code: "missing_package", message: msg };
  if (lower.includes("python runtime not available")) {
    return { code: "python_runtime_unavailable", message: msg };
  }
  if (lower.includes("schema extraction failed") || lower.includes("failed to extract schema")) {
    return { code: "schema_extract_fail", message: msg };
  }
  if (lower.includes("not found in package") || (parsed.did_you_mean != null)) {
    return { code: "not_found", message: msg };
  }
  return { code: "other", message: msg };
}

// ---------------------------------------------------------------------------
// Markdown summary
// ---------------------------------------------------------------------------

function topN<K>(map: Map<K, number>, n: number): Array<[K, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function renderMarkdown(records: ResolveRecord[], startedAt: Date, endedAt: Date): string {
  const total = records.length;
  const pass = records.filter((r) => r.resolve === "pass").length;
  const fail = total - pass;
  const passRate = total === 0 ? 0 : (pass / total) * 100;

  const byCode = new Map<ErrorCode, number>();
  const failByPackage = new Map<string, number>();
  const failMessages = new Map<string, number>();
  const bySafetyClass = new Map<string, { total: number; pass: number }>();

  for (const r of records) {
    const sc = r.safety_class;
    const cur = bySafetyClass.get(sc) ?? { total: 0, pass: 0 };
    cur.total += 1;
    if (r.resolve === "pass") cur.pass += 1;
    bySafetyClass.set(sc, cur);

    if (r.resolve === "fail") {
      const code = r.error_code ?? "other";
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      failByPackage.set(r.package, (failByPackage.get(r.package) ?? 0) + 1);
      const key = (r.error_message ?? "").split("\n")[0].slice(0, 160);
      if (key) failMessages.set(key, (failMessages.get(key) ?? 0) + 1);
    }
  }

  const durationS = ((endedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
  const lines: string[] = [];
  lines.push("# StatTools — Classified-Function Eval (Stage 1: resolve)\n");
  lines.push(`- **Run started**: ${startedAt.toISOString()}`);
  lines.push(`- **Run ended**: ${endedAt.toISOString()}`);
  lines.push(`- **Wall time**: ${durationS}s`);
  lines.push(`- **Database**: \`data/stattools.db\`\n`);

  lines.push("## Headline numbers");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---:|`);
  lines.push(`| Total classified non-stub functions | ${total} |`);
  lines.push(`| stat_resolve pass | ${pass} |`);
  lines.push(`| stat_resolve fail | ${fail} |`);
  lines.push(`| Pass rate | ${passRate.toFixed(2)}% |`);
  lines.push("");

  lines.push("## By safety_class");
  lines.push("");
  lines.push(`| safety_class | total | pass | pass rate |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const [sc, agg] of bySafetyClass) {
    const r = agg.total === 0 ? 0 : (agg.pass / agg.total) * 100;
    lines.push(`| ${sc} | ${agg.total} | ${agg.pass} | ${r.toFixed(2)}% |`);
  }
  lines.push("");

  lines.push("## Failures by error_code");
  lines.push("");
  if (byCode.size === 0) {
    lines.push("_No failures._");
  } else {
    lines.push(`| error_code | count |`);
    lines.push(`|---|---:|`);
    for (const [code, n] of topN(byCode, 50)) lines.push(`| ${code} | ${n} |`);
  }
  lines.push("");

  lines.push("## Top 20 packages by failure count");
  lines.push("");
  if (failByPackage.size === 0) {
    lines.push("_No failures._");
  } else {
    lines.push(`| package | failures |`);
    lines.push(`|---|---:|`);
    for (const [pkg, n] of topN(failByPackage, 20)) lines.push(`| ${pkg} | ${n} |`);
  }
  lines.push("");

  lines.push("## Top 20 failure messages");
  lines.push("");
  if (failMessages.size === 0) {
    lines.push("_No failures._");
  } else {
    lines.push(`| count | message |`);
    lines.push(`|---:|---|`);
    for (const [msg, n] of topN(failMessages, 20)) {
      const escaped = msg.replace(/\|/g, "\\|");
      lines.push(`| ${n} | ${escaped} |`);
    }
  }
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  lines.push("- `unsafe_regression` / `unclassified_regression` / `stub_regression` flag");
  lines.push("  inventory rows that the resolver disagrees with — these are the highest-");
  lines.push("  signal bugs because the inventory selected only safe/callable non-stubs.");
  lines.push("- `missing_package` means either resolver metadata reported the package as");
  lines.push("  uninstalled, or schema extraction reached the worker and the runtime could");
  lines.push("  not load the package. Compare the record's `installed` field to identify");
  lines.push("  stale `packages.installed` metadata.");
  lines.push("- `schema_extract_fail` covers other worker-side schema errors (R or Python).");
  lines.push("- Stage 2 (stat_call) is not run by this script.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  if (!existsSync(DB_PATH)) {
    console.error(`stattools.db not found at ${DB_PATH}. Run: npm run build-index`);
    process.exit(1);
  }
  mkdirSync(REPORTS_DIR, { recursive: true });

  const inventory = loadInventory(DB_PATH, flags.packages);
  const target = flags.limit != null ? inventory.slice(0, flags.limit) : inventory;
  console.log(`Inventory: ${inventory.length} classified non-stub functions; running on ${target.length}.`);
  console.log(`Output: ${JSONL_PATH}`);

  // ----- start in-process server -----
  const config: ServerConfig = {
    dbPath: DB_PATH,
    allowedDataRoots: [PROJECT_ROOT, "/tmp"],
    rPath: R_PATH,
    pythonPath: PYTHON_PATH,
  };
  console.log(`Starting StatTools server (R=${R_PATH}, PYTHON=${PYTHON_PATH})...`);
  const { server, cleanup } = await createStatToolsServer(config);

  // ----- iterate -----
  const startedAt = new Date();
  const records: ResolveRecord[] = [];
  const jsonlStream = createWriteStream(JSONL_PATH, { flags: "w" });
  const total = target.length;
  let lastLog = 0;

  try {
    for (let i = 0; i < total; i++) {
      const row = target[i];
      const t0 = Date.now();
      let record: ResolveRecord;
      try {
        const resp = await callTool(
          server,
          "stat_resolve",
          { package: row.package, function: row.name },
          flags.timeoutMs,
        );
        const parsed = parseToolJson(resp);
        const ms = Date.now() - t0;
        if (resp.isError || parsed.error === true) {
          const { code, message } = classifyError(parsed);
          record = {
            id: row.id,
            package: row.package,
            function: row.name,
            safety_class: row.safety_class,
            installed: row.installed === 1,
            resolve: "fail",
            error_code: code,
            error_message: message,
            duration_ms: ms,
          };
        } else {
          record = {
            id: row.id,
            package: row.package,
            function: row.name,
            safety_class: row.safety_class,
            installed: row.installed === 1,
            resolve: "pass",
            error_code: null,
            error_message: null,
            duration_ms: ms,
          };
        }
      } catch (err) {
        const ms = Date.now() - t0;
        const message = (err as Error).message ?? String(err);
        const code: ErrorCode = message.includes("timed out") ? "timeout" : "exception";
        record = {
          id: row.id,
          package: row.package,
          function: row.name,
          safety_class: row.safety_class,
          installed: row.installed === 1,
          resolve: "fail",
          error_code: code,
          error_message: message,
          duration_ms: ms,
        };
      }

      records.push(record);
      jsonlStream.write(JSON.stringify(record) + "\n");

      // Heartbeat — every 100 functions, or every 10s
      const now = Date.now();
      if (i + 1 === total || (i + 1) % 100 === 0 || now - lastLog > 10_000) {
        const passSoFar = records.filter((r) => r.resolve === "pass").length;
        const elapsed = ((now - startedAt.getTime()) / 1000).toFixed(0);
        console.log(
          `  [${i + 1}/${total}] pass=${passSoFar} fail=${records.length - passSoFar} elapsed=${elapsed}s`,
        );
        lastLog = now;
      }
    }
  } finally {
    jsonlStream.end();
    await cleanup();
  }

  const endedAt = new Date();
  const md = renderMarkdown(records, startedAt, endedAt);
  writeFileSync(MARKDOWN_PATH, md, "utf-8");

  const pass = records.filter((r) => r.resolve === "pass").length;
  const fail = records.length - pass;
  console.log("");
  console.log(`=== Stage 1 complete ===`);
  console.log(`Total: ${records.length}`);
  console.log(`Pass:  ${pass}`);
  console.log(`Fail:  ${fail}`);
  console.log(`JSONL: ${JSONL_PATH}`);
  console.log(`MD:    ${MARKDOWN_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
