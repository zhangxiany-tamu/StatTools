#!/usr/bin/env tsx
// ============================================================================
// StatTools — Usage Log Summarizer
// ============================================================================
// Reads data/usage_log.jsonl and outputs summary statistics.
//
// Usage: npx tsx scripts/summarize-usage.ts
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot(__dirname);
const LOG_PATH = resolve(PROJECT_ROOT, "data", "usage_log.jsonl");

type Event = {
  type: string;
  timestamp: string;
  query?: string;
  package?: string;
  function?: string;
  success: boolean;
  error_code?: string;
  is_stub?: boolean;
  safety_class?: string;
  result_count?: number;
  top_results?: string[];
  latency_ms: number;
};

function main() {
  if (!existsSync(LOG_PATH)) {
    console.log("No usage log found at", LOG_PATH);
    console.log("Enable with STATTOOLS_LOG_USAGE=1");
    return;
  }

  const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
  const events: Event[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* skip */ }
  }

  if (events.length === 0) {
    console.log("Usage log is empty.");
    return;
  }

  console.log(`=== StatTools Usage Summary (${events.length} events) ===\n`);

  // By type
  const byType = new Map<string, Event[]>();
  for (const e of events) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }

  console.log("Event counts:");
  for (const [type, evts] of [...byType.entries()].sort()) {
    const successes = evts.filter((e) => e.success).length;
    const failures = evts.length - successes;
    const avgLatency = Math.round(evts.reduce((s, e) => s + e.latency_ms, 0) / evts.length);
    console.log(`  ${type}: ${evts.length} (${successes} ok, ${failures} failed, avg ${avgLatency}ms)`);
  }

  // Search funnel
  const searches = byType.get("search") || [];
  const resolves = byType.get("resolve") || [];
  const calls = byType.get("call") || [];
  console.log(`\nFunnel: ${searches.length} searches → ${resolves.length} resolves → ${calls.length} calls`);

  // Top failed queries
  const failedSearches = searches.filter((e) => !e.success || e.result_count === 0);
  if (failedSearches.length > 0) {
    console.log("\nTop failed/empty search queries:");
    const qCounts = new Map<string, number>();
    for (const e of failedSearches) {
      const q = e.query || "?";
      qCounts.set(q, (qCounts.get(q) || 0) + 1);
    }
    const sorted = [...qCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [q, c] of sorted) {
      console.log(`  "${q}" (${c}x)`);
    }
  }

  // Top stub hits
  const stubHits = searches.filter((e) => e.is_stub);
  if (stubHits.length > 0) {
    console.log("\nSearches where top result was a stub:");
    const qCounts = new Map<string, number>();
    for (const e of stubHits) {
      qCounts.set(e.query || "?", (qCounts.get(e.query || "?") || 0) + 1);
    }
    const sorted = [...qCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [q, c] of sorted) {
      console.log(`  "${q}" (${c}x)`);
    }
  }

  // Top blocked functions (resolve failures)
  const blockedResolves = resolves.filter((e) => !e.success);
  if (blockedResolves.length > 0) {
    console.log("\nTop blocked function resolves:");
    const fnCounts = new Map<string, number>();
    for (const e of blockedResolves) {
      const key = `${e.package}::${e.function}`;
      fnCounts.set(key, (fnCounts.get(key) || 0) + 1);
    }
    const sorted = [...fnCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [fn, c] of sorted) {
      console.log(`  ${fn} (${c}x)`);
    }
  }

  // Most requested packages
  const pkgCounts = new Map<string, number>();
  for (const e of [...resolves, ...calls]) {
    if (e.package) {
      pkgCounts.set(e.package, (pkgCounts.get(e.package) || 0) + 1);
    }
  }
  if (pkgCounts.size > 0) {
    console.log("\nMost requested packages:");
    const sorted = [...pkgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [pkg, c] of sorted) {
      console.log(`  ${pkg} (${c}x)`);
    }
  }
}

main();
