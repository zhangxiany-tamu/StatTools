#!/usr/bin/env tsx
// ============================================================================
// StatTools — Apply Safety Overrides In Place
// ============================================================================
// Syncs data/safety_overrides.csv into an existing stattools.db without running
// a full build-index reset. This preserves tarball-expanded metadata.

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
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
const DB_PATH = resolve(PROJECT_ROOT, "data", "stattools.db");
const CSV_PATH = resolve(PROJECT_ROOT, "data", "safety_overrides.csv");

type OverrideRow = {
  functionId: string;
  safetyClass: string;
};

function loadOverrides(): OverrideRow[] {
  const lines = readFileSync(CSV_PATH, "utf-8").trim().split("\n");
  const rows: OverrideRow[] = [];
  for (const line of lines.slice(1)) {
    const [functionId, safetyClass] = line.split(",").map((s) => s.trim());
    if (!functionId || !safetyClass) continue;
    rows.push({ functionId, safetyClass });
  }
  return rows;
}

function main() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Missing DB: ${DB_PATH}`);
  }
  if (!existsSync(CSV_PATH)) {
    throw new Error(`Missing CSV: ${CSV_PATH}`);
  }

  const overrides = loadOverrides();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const clearStmt = db.prepare(
    "UPDATE functions SET safety_class = 'unclassified' WHERE id NOT LIKE 'py::%'",
  );
  const applyStmt = db.prepare(
    "UPDATE functions SET safety_class = ? WHERE id = ?",
  );
  const existsStmt = db.prepare("SELECT 1 FROM functions WHERE id = ?");

  let matched = 0;
  const missing: string[] = [];

  const tx = db.transaction(() => {
    clearStmt.run();
    for (const row of overrides) {
      if (!existsStmt.get(row.functionId)) {
        missing.push(row.functionId);
        continue;
      }
      const result = applyStmt.run(row.safetyClass, row.functionId);
      matched += result.changes;
    }
  });
  tx();

  const counts = db.prepare(`
    SELECT safety_class, COUNT(*) AS c
    FROM functions
    WHERE safety_class != 'unclassified'
    GROUP BY safety_class
    ORDER BY safety_class
  `).all() as Array<{ safety_class: string; c: number }>;
  const total = db.prepare(
    "SELECT COUNT(*) AS c FROM functions WHERE safety_class != 'unclassified'",
  ).get() as { c: number };
  db.close();

  console.log(`Applied ${matched}/${overrides.length} safety overrides`);
  for (const row of counts) {
    console.log(`  ${row.safety_class}: ${row.c}`);
  }
  console.log(`  total classified: ${total.c}`);
  if (missing.length > 0) {
    console.log(`Missing functions (${missing.length}):`);
    for (const id of missing.slice(0, 20)) console.log(`  ${id}`);
    if (missing.length > 20) console.log("  ...");
    process.exitCode = 1;
  }
}

main();
