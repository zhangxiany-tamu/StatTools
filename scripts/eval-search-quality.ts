#!/usr/bin/env tsx
// ============================================================================
// StatTools — Search-Quality Eval Harness
// ============================================================================
// Runs `stat_search` for every benchmark query and computes top-K hit rate
// against curated accepted answer sets. Targets per the 90-day plan:
//   - common queries:    >=80% top_5 hit rate
//   - long-tail queries: >=60% top_5 hit rate
//
// Output:
//   reports/search-quality.jsonl   per-query record
//   reports/search-quality.md      summary
//
// Usage:
//   tsx scripts/eval-search-quality.ts                # both sets
//   tsx scripts/eval-search-quality.ts --set=common   # just one bucket
//   tsx scripts/eval-search-quality.ts --k=10         # top-10 instead
// ============================================================================

import { createStatToolsServer, type ServerConfig } from "../src/server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMON_QUERIES, LONG_TAIL_QUERIES, type BenchmarkQuery } from "./eval-search-quality/benchmark.js";

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
const JSONL_PATH = resolve(REPORTS_DIR, "search-quality.jsonl");
const MARKDOWN_PATH = resolve(REPORTS_DIR, "search-quality.md");

const PYTHON_PATH = process.env.PYTHON_PATH || "python3";
const R_PATH = process.env.R_PATH || "Rscript";

type Flags = { set: "common" | "long_tail" | "all"; k: number };

function parseFlags(argv: string[]): Flags {
  const out: Flags = { set: "all", k: 5 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--set=")) {
      const v = arg.slice("--set=".length);
      if (v === "common" || v === "long_tail" || v === "all") out.set = v;
    } else if (arg.startsWith("--k=")) {
      out.k = Number.parseInt(arg.slice("--k=".length), 10);
    }
  }
  return out;
}

type ToolResponse = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function callTool(server: Server, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const handler = (server as any)._requestHandlers?.get("tools/call");
  return (await handler({ method: "tools/call", params: { name, arguments: args } })) as ToolResponse;
}

type SearchHit = { id: string; rank: number };
type QueryRecord = {
  bucket: "common" | "long_tail";
  query: string;
  accepted: string[];
  hits: SearchHit[];
  topK_hit: boolean;
  hit_rank: number | null;
  result_count: number;
};

async function searchOne(server: Server, q: BenchmarkQuery, k: number, bucket: "common" | "long_tail"): Promise<QueryRecord> {
  const args: Record<string, unknown> = { query: q.query, max_results: Math.max(k, 10) };
  if (q.task_view) args.task_view = q.task_view;
  const resp = await callTool(server, "stat_search", args);
  let hits: SearchHit[] = [];
  let totalCount = 0;
  try {
    const parsed = JSON.parse(resp.content?.[0]?.text ?? "{}") as { results?: Array<{ id: string }>; result_count?: number };
    totalCount = parsed.result_count ?? (parsed.results?.length ?? 0);
    hits = (parsed.results ?? []).slice(0, k).map((r, i) => ({ id: r.id, rank: i + 1 }));
  } catch { /* leave hits empty on parse error */ }

  const acceptedSet = new Set(q.accepted);
  const matched = hits.find((h) => acceptedSet.has(h.id));
  return {
    bucket,
    query: q.query,
    accepted: q.accepted,
    hits,
    topK_hit: matched != null,
    hit_rank: matched ? matched.rank : null,
    result_count: totalCount,
  };
}

function summarize(records: QueryRecord[]): { byBucket: Record<string, { total: number; hits: number; rate: number; mrr: number }> } {
  const byBucket: Record<string, { total: number; hits: number; rate: number; mrr: number }> = {};
  for (const r of records) {
    const b = byBucket[r.bucket] ?? { total: 0, hits: 0, rate: 0, mrr: 0 };
    b.total += 1;
    if (r.topK_hit) b.hits += 1;
    if (r.hit_rank != null) b.mrr += 1 / r.hit_rank;
    byBucket[r.bucket] = b;
  }
  for (const k of Object.keys(byBucket)) {
    const b = byBucket[k];
    b.rate = b.total === 0 ? 0 : b.hits / b.total;
    b.mrr = b.total === 0 ? 0 : b.mrr / b.total;
  }
  return { byBucket };
}

function renderMarkdown(records: QueryRecord[], k: number, startedAt: Date, endedAt: Date): string {
  const { byBucket } = summarize(records);
  const lines: string[] = [];
  lines.push("# StatTools — Search-Quality Benchmark\n");
  lines.push(`- **Run started**: ${startedAt.toISOString()}`);
  lines.push(`- **Run ended**: ${endedAt.toISOString()}`);
  lines.push(`- **k (top-K cutoff)**: ${k}`);
  lines.push(`- **Database**: \`data/stattools.db\`\n`);

  lines.push("## Headline numbers\n");
  lines.push(`| bucket | total | top_${k} hits | hit rate | MRR | target |`);
  lines.push("|---|---:|---:|---:|---:|---:|");
  const targets: Record<string, number> = { common: 0.80, long_tail: 0.60 };
  for (const bucket of ["common", "long_tail"]) {
    const b = byBucket[bucket];
    if (!b) continue;
    const tgt = targets[bucket] ?? 0;
    const status = b.rate >= tgt ? "✓" : "✗";
    lines.push(`| ${bucket} | ${b.total} | ${b.hits} | ${(b.rate * 100).toFixed(2)}% | ${b.mrr.toFixed(3)} | >=${(tgt * 100).toFixed(0)}% ${status} |`);
  }
  lines.push("");

  lines.push("## Misses (queries that did NOT hit top-K)\n");
  const misses = records.filter((r) => !r.topK_hit);
  if (misses.length === 0) {
    lines.push("_All queries hit top-K._");
  } else {
    lines.push(`| bucket | query | accepted | top hit (id, rank) | result_count |`);
    lines.push("|---|---|---|---|---:|");
    for (const r of misses) {
      const top = r.hits[0];
      const acc = r.accepted.slice(0, 2).join(", ") + (r.accepted.length > 2 ? `, +${r.accepted.length - 2}` : "");
      lines.push(`| ${r.bucket} | ${r.query.replace(/\|/g, "\\|")} | ${acc.replace(/\|/g, "\\|")} | ${top ? `${top.id} (${top.rank})` : "_no results_"} | ${r.result_count} |`);
    }
  }
  lines.push("");

  lines.push("## All hits (rank position when matched)\n");
  lines.push(`| bucket | query | matched_id | rank |`);
  lines.push("|---|---|---|---:|");
  for (const r of records.filter((r) => r.topK_hit)) {
    const matched = r.hits.find((h) => r.accepted.includes(h.id));
    if (!matched) continue;
    lines.push(`| ${r.bucket} | ${r.query.replace(/\|/g, "\\|")} | ${matched.id} | ${matched.rank} |`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  if (!existsSync(DB_PATH)) {
    console.error(`stattools.db not found at ${DB_PATH}`);
    process.exit(1);
  }
  mkdirSync(REPORTS_DIR, { recursive: true });

  const queries: Array<{ q: BenchmarkQuery; bucket: "common" | "long_tail" }> = [];
  if (flags.set !== "long_tail") for (const q of COMMON_QUERIES)    queries.push({ q, bucket: "common" });
  if (flags.set !== "common")    for (const q of LONG_TAIL_QUERIES) queries.push({ q, bucket: "long_tail" });

  console.log(`Running ${queries.length} queries (k=${flags.k}, set=${flags.set})...`);

  const config: ServerConfig = { dbPath: DB_PATH, allowedDataRoots: [PROJECT_ROOT, "/tmp"], rPath: R_PATH, pythonPath: PYTHON_PATH };
  const { server, cleanup } = await createStatToolsServer(config);

  const startedAt = new Date();
  const records: QueryRecord[] = [];
  const jsonl = createWriteStream(JSONL_PATH, { flags: "w" });
  try {
    for (let i = 0; i < queries.length; i++) {
      const { q, bucket } = queries[i];
      const rec = await searchOne(server, q, flags.k, bucket);
      records.push(rec);
      jsonl.write(JSON.stringify(rec) + "\n");
      const status = rec.topK_hit ? `hit@${rec.hit_rank}` : "miss";
      console.log(`  [${i + 1}/${queries.length}] [${bucket}] ${status}  "${q.query}"`);
    }
  } finally {
    jsonl.end();
    await cleanup();
  }

  const endedAt = new Date();
  writeFileSync(MARKDOWN_PATH, renderMarkdown(records, flags.k, startedAt, endedAt), "utf-8");

  const { byBucket } = summarize(records);
  console.log("");
  console.log("=== Search-quality benchmark complete ===");
  for (const bucket of Object.keys(byBucket)) {
    const b = byBucket[bucket];
    console.log(`${bucket.padEnd(10)} hits ${b.hits}/${b.total}  rate ${(b.rate * 100).toFixed(2)}%  MRR ${b.mrr.toFixed(3)}`);
  }
  console.log(`JSONL: ${JSONL_PATH}`);
  console.log(`MD:    ${MARKDOWN_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
