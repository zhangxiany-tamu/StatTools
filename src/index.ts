#!/usr/bin/env node
// ============================================================================
// StatTools — Entry Point
// ============================================================================

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Find project root
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
const DB_PATH = resolve(PROJECT_ROOT, "data", "stattools.db");

if (!existsSync(DB_PATH)) {
  console.error(
    `Database not found: ${DB_PATH}\nRun 'npx tsx scripts/build-index.ts' first to build the search index.`,
  );
  process.exit(1);
}

// Parse environment config
const allowedRoots = process.env.STATTOOLS_DATA_ROOTS
  ? process.env.STATTOOLS_DATA_ROOTS.split(":")
  : [process.cwd()];

const rPath = process.env.R_PATH || "Rscript";

startServer({
  dbPath: DB_PATH,
  allowedDataRoots: allowedRoots,
  rPath,
}).catch((err) => {
  console.error("Failed to start StatTools server:", err);
  process.exit(1);
});
