#!/usr/bin/env tsx
// ============================================================================
// StatTools — Reindex Packages
// ============================================================================
// Convenience wrapper around src/search/incrementalReindex#reindexPackage.
// For each package supplied, re-extracts the full function list, applies
// matching safety overrides, and refreshes the FTS5 index. Used after fresh
// installs so newly-installed packages appear in stat_search and stat_resolve.
//
// Usage:
//   tsx scripts/reindex-packages.ts pwr coin AER mirt ...
// ============================================================================

import { reindexPackage } from "../src/search/incrementalReindex.js";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

async function main(): Promise<void> {
  const pkgs = process.argv.slice(2);
  if (pkgs.length === 0) {
    console.error("Usage: tsx scripts/reindex-packages.ts pkg1 pkg2 ...");
    process.exit(1);
  }
  console.log(`Reindexing ${pkgs.length} packages: ${pkgs.join(", ")}`);
  for (const pkg of pkgs) {
    try {
      const result = await reindexPackage(DB_PATH, pkg);
      console.log(`  ✓ ${pkg}: ${result.functionsInserted} functions (overrides: ${result.overridesApplied}, ${result.durationMs}ms)`);
    } catch (err) {
      console.error(`  ✗ ${pkg}: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
