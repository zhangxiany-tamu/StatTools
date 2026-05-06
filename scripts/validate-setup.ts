#!/usr/bin/env tsx
// ============================================================================
// StatTools — Setup Validator
// ============================================================================
// Verifies the full setup path works: Node, R, build, index, server, workflow.
// Run after: npm install && npm run build && npm run build-index
//
// Usage: npm run validate
// ============================================================================

import { createStatToolsServer, type ServerConfig } from "../src/server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { checkSafetyOverrides } from "../src/util/safetyOverrideCheck.js";
import { resolve, dirname } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
const SAFETY_CSV_PATH = resolve(PROJECT_ROOT, "data", "safety_overrides.csv");
const PYTHON_PATH = process.env.PYTHON_PATH || "python3";

async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = (server as any)._requestHandlers?.get("tools/call");
  return (await handler({ method: "tools/call", params: { name, arguments: args } })) as any;
}

function parse(r: { content: Array<{ text: string }> }): any {
  return JSON.parse(r.content[0].text);
}

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail: string = "") {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  console.log("=== StatTools Setup Validation ===\n");

  // 1. Node version
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  check("Node 22.x", nodeMajor === 22, `got ${process.version}`);

  // 2. R available
  let rVersion = "";
  try {
    rVersion = execFileSync("Rscript", ["--version"], { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    try {
      // Rscript --version writes to stderr on some systems
      rVersion = execFileSync("Rscript", ["-e", "cat(R.version.string)"], { encoding: "utf-8", timeout: 5000 }).trim();
    } catch { /* */ }
  }
  check("R available", rVersion.length > 0, rVersion || "Rscript not found");

  // 3. R jsonlite installed
  let jsonliteOk = false;
  try {
    const result = execFileSync("Rscript", ["-e", 'cat(requireNamespace("jsonlite", quietly=TRUE))'], { encoding: "utf-8", timeout: 5000 });
    jsonliteOk = result.trim() === "TRUE";
  } catch { /* */ }
  check("R jsonlite package", jsonliteOk, jsonliteOk ? "installed" : "MISSING — run: Rscript -e 'install.packages(\"jsonlite\")'");

  // 4. TypeScript compiled
  const distExists = existsSync(resolve(PROJECT_ROOT, "dist", "index.js"));
  check("TypeScript compiled (dist/)", distExists, distExists ? "dist/index.js exists" : "run: npm run build");

  // 5. Database exists
  const dbExists = existsSync(DB_PATH);
  check("Search index (stattools.db)", dbExists, dbExists ? "exists" : "run: npm run build-index");

  if (!distExists || !dbExists) {
    console.log("\n  Cannot continue — build or index missing. Run:");
    if (!distExists) console.log("    npm run build");
    if (!dbExists) console.log("    npm run build-index");
    process.exit(1);
  }

  // 6. Database has functions
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH, { readonly: true });
  const fnCount = (db.prepare("SELECT COUNT(*) as c FROM functions").get() as { c: number }).c;
  const stubCount = (db.prepare("SELECT COUNT(*) as c FROM functions WHERE is_stub = 1").get() as { c: number }).c;
  const overrideCount = (db.prepare("SELECT COUNT(*) as c FROM functions WHERE safety_class != 'unclassified'").get() as { c: number }).c;
  db.close();
  check("Functions indexed", fnCount > 10000, `${fnCount} functions (${stubCount} stubs, ${overrideCount} classified)`);

  // 7. Safety overrides match DB
  const safetyCheck = checkSafetyOverrides(DB_PATH, SAFETY_CSV_PATH);
  const safetyOk = safetyCheck.duplicateIds.length === 0 && safetyCheck.missingIds.length === 0;
  check(
    "Safety overrides match DB",
    safetyOk,
    `${safetyCheck.csvRows} CSV rows, ${safetyCheck.missingIds.length} missing, ${safetyCheck.duplicateIds.length} duplicates`,
  );

  // 8. Start server and run a workflow
  console.log("\n  Starting MCP server...");
  const csvPath = "/tmp/stattools_validate.csv";
  writeFileSync(csvPath, "x,y,group\n1,2,a\n2,4,a\n3,6,b\n4,8,b\n5,10,a\n");

  let server: Server | null = null;
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const config: ServerConfig = {
      dbPath: DB_PATH,
      allowedDataRoots: ["/tmp"],
      rPath: "Rscript",
      pythonPath: PYTHON_PATH,
    };
    const result = await createStatToolsServer(config);
    server = result.server;
    cleanup = result.cleanup;
    check("Server starts", true);
  } catch (err) {
    check("Server starts", false, (err as Error).message);
    process.exit(1);
  }

  // 9. stat_search
  try {
    const r = await callTool(server!, "stat_search", { query: "linear regression" });
    const data = parse(r);
    const hasLm = data.results?.some((r: any) => r.id === "stats::lm");
    check("stat_search finds stats::lm", hasLm, `${data.result_count} results`);
  } catch (err) {
    check("stat_search", false, (err as Error).message);
  }

  // 10. stat_resolve
  try {
    const r = await callTool(server!, "stat_resolve", { package: "stats", function: "lm" });
    const data = parse(r);
    check("stat_resolve validates stats::lm", data.resolved === true, `safety: ${data.safety_class}`);
  } catch (err) {
    check("stat_resolve", false, (err as Error).message);
  }

  // 11. stat_load_data
  try {
    const r = await callTool(server!, "stat_load_data", { file_path: csvPath, name: "test_data" });
    const data = parse(r);
    check("stat_load_data loads CSV", data.object_id === "test_data", `${data.dimensions?.rows} rows`);
  } catch (err) {
    check("stat_load_data", false, (err as Error).message);
  }

  // 12. stat_call (lm)
  try {
    const r = await callTool(server!, "stat_call", { package: "stats", function: "lm", args: { formula: "y ~ x", data: "test_data" } });
    const data = parse(r);
    const hasCoefs = data.result?.coefficients != null;
    check("stat_call executes lm()", hasCoefs, hasCoefs ? "coefficients returned" : "no coefficients");
  } catch (err) {
    check("stat_call", false, (err as Error).message);
  }

  // 13. stat_session + Python runtime diagnostics
  try {
    const r = await callTool(server!, "stat_session", {});
    const data = parse(r);
    check("stat_session shows state", data.handle_count > 0, `${data.handle_count} handles, ${data.resolved_count} resolved`);

    const python = data.python;
    const pythonConfigured = Boolean(process.env.PYTHON_PATH);
    if (python) {
      const version = python.pythonVersion ? ` ${python.pythonVersion}` : "";
      const missing = python.missingModules?.length > 0
        ? `missing: ${python.missingModules.join(", ")}`
        : "all core modules available";
      const pass = pythonConfigured ? python.state === "healthy" : true;
      check("Python runtime status", pass, `${python.path}${version} — state=${python.state} — ${missing}${pythonConfigured && !pass ? " (configured via PYTHON_PATH)" : ""}`);
    } else {
      check("Python runtime status", !pythonConfigured, pythonConfigured
        ? `no status returned for configured PYTHON_PATH=${PYTHON_PATH}`
        : `not configured (using default ${PYTHON_PATH})`);
    }
  } catch (err) {
    check("stat_session", false, (err as Error).message);
  }

  await cleanup?.();

  // Summary
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass);

  console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const f of failed) {
      console.log(`  ✗ ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  } else {
    console.log("\nSetup is ready. You can now connect to Claude Code or run workflows.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
