#!/usr/bin/env tsx
// ============================================================================
// StatTools — Safety Override Integrity Check
// ============================================================================
// Verifies that data/safety_overrides.csv has no orphan or duplicate function
// IDs relative to the current stattools.db.

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSafetyOverrides } from "../src/util/safetyOverrideCheck.js";

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
const DB_PATH = resolve(PROJECT_ROOT, "data", "stattools.db");
const CSV_PATH = resolve(PROJECT_ROOT, "data", "safety_overrides.csv");

function main() {
  const result = checkSafetyOverrides(DB_PATH, CSV_PATH);

  console.log("=== Safety Override Integrity Check ===");
  console.log(`CSV rows: ${result.csvRows}`);
  console.log(`Unique IDs: ${result.uniqueIds}`);
  console.log(`Duplicate IDs: ${result.duplicateIds.length}`);
  console.log(`Missing IDs: ${result.missingIds.length}`);

  if (result.duplicateIds.length > 0) {
    console.log("\nDuplicate IDs:");
    for (const id of result.duplicateIds.slice(0, 20)) console.log(`  ${id}`);
    if (result.duplicateIds.length > 20) console.log("  ...");
  }

  if (result.missingIds.length > 0) {
    console.log("\nMissing IDs:");
    for (const id of result.missingIds.slice(0, 20)) console.log(`  ${id}`);
    if (result.missingIds.length > 20) console.log("  ...");
  }

  if (result.duplicateIds.length > 0 || result.missingIds.length > 0) {
    process.exitCode = 1;
  }
}

main();
