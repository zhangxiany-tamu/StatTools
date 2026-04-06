// ============================================================================
// StatTools — Usage Logger
// ============================================================================
// Opt-in JSONL logging for search, resolve, call, and install events.
// Enabled via STATTOOLS_LOG_USAGE=1 environment variable.
// Writes to data/usage_log.jsonl in the project root.

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
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
const ENABLED = process.env.STATTOOLS_LOG_USAGE === "1";

export type UsageEvent = {
  readonly type:
    | "search"
    | "resolve"
    | "call"
    | "method"
    | "load_data"
    | "install"
    | "describe";
  readonly timestamp: string;
  readonly query?: string;
  readonly package?: string;
  readonly function?: string;
  readonly method?: string;
  readonly object?: string;
  readonly runtime?: string;
  readonly result_count?: number;
  readonly top_results?: readonly string[];
  readonly success: boolean;
  readonly error_code?: string;
  readonly is_stub?: boolean;
  readonly safety_class?: string;
  readonly latency_ms: number;
};

/** Log a usage event to data/usage_log.jsonl. No-op if STATTOOLS_LOG_USAGE != "1". */
export function logUsage(event: UsageEvent): void {
  if (!ENABLED) return;

  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const line = JSON.stringify(event) + "\n";
    appendFileSync(LOG_PATH, line, "utf-8");
  } catch {
    // Never let logging failures affect tool execution
  }
}

/** Create a timer for measuring latency. Returns elapsed ms when called. */
export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

export { ENABLED as isLoggingEnabled };
