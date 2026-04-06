// ============================================================================
// StatTools — Large Result Persistence
// ============================================================================
// When R output exceeds MAX_INLINE_SIZE, save to disk and return a preview.
// Pattern from Claude Code's toolResultStorage.ts.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const MAX_INLINE_SIZE = 100_000; // 100KB
const PREVIEW_SIZE = 2_000; // 2KB preview

let resultDir: string | null = null;

function getResultDir(): string {
  if (!resultDir) {
    resultDir = join(tmpdir(), "stattools", "results");
    mkdirSync(resultDir, { recursive: true });
  }
  return resultDir;
}

export type FormattedResult = {
  content: string;
  persisted?: {
    filepath: string;
    originalSize: number;
    preview: string;
  };
};

/**
 * Format a result for MCP response. If the JSON exceeds MAX_INLINE_SIZE,
 * persist to disk and return a preview with file path.
 */
export function formatResult(data: unknown): FormattedResult {
  const json = JSON.stringify(data, null, 2);

  if (json.length <= MAX_INLINE_SIZE) {
    return { content: json };
  }

  // Persist to disk
  const id = randomBytes(6).toString("hex");
  const filepath = join(getResultDir(), `result_${id}.json`);
  writeFileSync(filepath, json, "utf-8");

  // Preview: take first N chars but don't try to JSON.parse truncated JSON
  const preview = json.slice(0, PREVIEW_SIZE);
  const hasMore = json.length > PREVIEW_SIZE;

  const persisted = {
    filepath,
    originalSize: json.length,
    preview,
  };

  const summary = {
    _persisted: true,
    message: `Result too large (${formatSize(json.length)}). Full output saved to: ${filepath}`,
    preview_text: preview + (hasMore ? "\n... (truncated)" : ""),
    original_size: formatSize(json.length),
    filepath,
  };

  return {
    content: JSON.stringify(summary, null, 2),
    persisted,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
