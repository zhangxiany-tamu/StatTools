#!/usr/bin/env tsx
// ============================================================================
// StatTools — Install-State Verifier
// ============================================================================
// Reconciles the `packages.installed` flag (and optionally per-package function
// rows) with what `Rscript` can actually load right now. Catches the class of
// bug where the index was built against a different R environment, packages
// were uninstalled, or upstream removed/renamed functions.
//
// Phase 1 (always): for every package flagged installed=1, run
//   requireNamespace(pkg, quietly=TRUE)
// in a single Rscript subprocess. Any package that fails is updated to
// installed=0, install_status='broken'.
//
// Phase 2 (--verify-functions): for every package that loaded successfully,
// list its actually-exported symbols and DELETE function rows whose name is
// no longer in that set. Catches function-level index drift (e.g. effectsize
// `convert_*` family removed in 1.0.2).
//
// Usage:
//   tsx scripts/verify-install-state.ts                    # Phase 1 only
//   tsx scripts/verify-install-state.ts --verify-functions # Phases 1 + 2
//   tsx scripts/verify-install-state.ts --packages=a,b     # subset
//   tsx scripts/verify-install-state.ts --dry-run          # report only
// ============================================================================

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const CHUNK_SIZE = 50; // packages per Rscript invocation in chunked mode

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
const R_PATH = process.env.R_PATH || "Rscript";

type Flags = {
  verifyFunctions: boolean;
  dryRun: boolean;
  packages: Set<string> | null;
};

function parseFlags(argv: string[]): Flags {
  const out: Flags = { verifyFunctions: false, dryRun: false, packages: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--verify-functions") out.verifyFunctions = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--packages=")) {
      const list = arg.slice("--packages=".length).split(",").map((s) => s.trim()).filter(Boolean);
      out.packages = new Set(list);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Phase 1 — package load verification
// ----------------------------------------------------------------------------

// Some packages segfault during their .onLoad (Rcpp::loadModule "invalid
// permissions" on Homebrew R + GCC-15 + macOS arm64 — RcppAnnoy, rstan, etc.)
// A single segfault kills the whole R subprocess and we lose results for every
// later package in the chunk. Strategy: run in chunks; if a chunk crashes,
// fall back to per-package isolated subprocesses for that chunk only.

function runRequireNamespaceBatch(rPackages: string[]): { results: Map<string, boolean>; crashed: boolean } {
  if (rPackages.length === 0) return { results: new Map(), crashed: false };
  const rScript = `
    pkgs <- c(${rPackages.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(",")})
    for (p in pkgs) {
      ok <- tryCatch(requireNamespace(p, quietly=TRUE), error=function(e) FALSE)
      cat(p, "\t", if (isTRUE(ok)) "OK" else "FAIL", "\n", sep="")
      flush.console()
    }
  `;
  const proc = spawnSync(R_PATH, ["--vanilla", "-e", rScript], {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, R_MAX_VSIZE: process.env.R_MAX_VSIZE ?? "100Gb" },
  });

  const out = proc.stdout ?? "";
  const results = new Map<string, boolean>();
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    const status = line.slice(tab + 1).trim();
    results.set(name, status === "OK");
  }
  // A non-zero signal or missing output for any package indicates a crash.
  const crashed = (proc.signal != null) || (proc.status !== 0 && proc.status !== null) || results.size < rPackages.length;
  return { results, crashed };
}

function verifyPackageLoad(packageNames: string[]): Map<string, boolean> {
  // Skip Python packages (py:: prefix or known python prefixes); only verify
  // R packages that Rscript can attempt to load.
  const rPackages = packageNames.filter((p) =>
    !p.startsWith("py::") &&
    !p.startsWith("sklearn") &&
    !p.startsWith("scipy") &&
    !p.startsWith("statsmodels") &&
    !p.startsWith("pandas") &&
    !p.startsWith("numpy")
  );
  if (rPackages.length === 0) return new Map();

  const result = new Map<string, boolean>();
  const total = rPackages.length;
  let processed = 0;
  let chunksCrashed = 0;

  for (let i = 0; i < rPackages.length; i += CHUNK_SIZE) {
    const chunk = rPackages.slice(i, i + CHUNK_SIZE);
    const { results: chunkResults, crashed } = runRequireNamespaceBatch(chunk);

    if (!crashed) {
      for (const [k, v] of chunkResults) result.set(k, v);
    } else {
      chunksCrashed += 1;
      // Some packages in this chunk segfaulted. Re-run each in isolation so
      // that one crash doesn't poison the rest.
      for (const pkg of chunk) {
        if (chunkResults.has(pkg)) {
          result.set(pkg, chunkResults.get(pkg)!);
          continue;
        }
        const single = runRequireNamespaceBatch([pkg]);
        if (single.results.has(pkg)) {
          result.set(pkg, single.results.get(pkg)!);
        } else {
          // Crashed even alone → mark broken.
          result.set(pkg, false);
        }
      }
    }

    processed += chunk.length;
    if (processed % 200 === 0 || processed === total) {
      process.stdout.write(`\r  progress: ${processed}/${total} (${chunksCrashed} chunk crash${chunksCrashed === 1 ? "" : "es"} recovered)`);
    }
  }
  process.stdout.write("\n");
  return result;
}

// ----------------------------------------------------------------------------
// Phase 2 — function existence sweep (opt-in)
// ----------------------------------------------------------------------------

function listExportedFunctions(packageName: string): Set<string> | null {
  // Returns the set of currently-callable symbols, or null on load failure.
  // Includes both getNamespaceExports() and S3 method registrations
  // (e.g. clean_names.sf in janitor) — the indexer captures both, so the
  // existence check must too, otherwise valid S3 method rows look stale.
  const escaped = packageName.replace(/"/g, '\\"');
  const rScript = `
    ok <- suppressWarnings(requireNamespace("${escaped}", quietly=TRUE))
    if (!isTRUE(ok)) {
      cat("__LOAD_FAIL__\\n")
    } else {
      ns <- asNamespace("${escaped}")
      exports <- getNamespaceExports(ns)
      s3 <- if (exists(".__S3MethodsTable__.", envir=ns, inherits=FALSE))
              ls(get(".__S3MethodsTable__.", envir=ns)) else character(0)
      cat(paste(unique(c(exports, s3)), collapse="\\n"))
    }
  `;
  // spawnSync — never throws on non-zero exit; we get { status, signal, stdout }.
  const proc = spawnSync(R_PATH, ["--vanilla", "-e", rScript], {
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = proc.stdout ?? "";
  if (proc.signal != null) return null; // segfault / killed
  if (out.includes("__LOAD_FAIL__")) return null;
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) set.add(trimmed);
  }
  return set.size > 0 ? set : null;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

function main(): void {
  const flags = parseFlags(process.argv);
  if (!existsSync(DB_PATH)) {
    console.error(`stattools.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  try {
    // ----- Load candidate packages -----
    const sql = flags.packages
      ? `SELECT name, installed FROM packages WHERE installed = 1 AND name IN (${[...flags.packages].map(() => "?").join(",")})`
      : `SELECT name, installed FROM packages WHERE installed = 1`;
    const params = flags.packages ? [...flags.packages] : [];
    const rows = db.prepare(sql).all(...params) as Array<{ name: string; installed: number }>;
    console.log(`Phase 1 — verifying ${rows.length} packages flagged installed=1...`);

    // ----- Phase 1 -----
    const loadResult = verifyPackageLoad(rows.map((r) => r.name));
    const broken: string[] = [];
    const loadable: string[] = [];
    const skippedPython: string[] = [];

    for (const r of rows) {
      const status = loadResult.get(r.name);
      if (status === undefined) {
        skippedPython.push(r.name);
        continue;
      }
      if (status) loadable.push(r.name);
      else broken.push(r.name);
    }

    console.log(`  loadable: ${loadable.length}`);
    console.log(`  broken:   ${broken.length}${broken.length > 0 ? ` (${broken.slice(0, 12).join(", ")}${broken.length > 12 ? ", ..." : ""})` : ""}`);
    if (skippedPython.length > 0) {
      console.log(`  skipped (python/non-R): ${skippedPython.length}`);
    }

    if (broken.length > 0 && !flags.dryRun) {
      const upd = db.prepare(`
        UPDATE packages SET installed = 0, install_status = 'broken'
        WHERE name = ?
      `);
      const tx = db.transaction((names: string[]) => {
        for (const n of names) upd.run(n);
      });
      tx(broken);
      console.log(`  ✓ updated ${broken.length} package rows to installed=0, install_status='broken'`);
    } else if (broken.length > 0) {
      console.log(`  (dry-run: no DB writes)`);
    }

    // ----- Phase 2 -----
    if (!flags.verifyFunctions) {
      console.log("\nDone (Phase 1 only). Pass --verify-functions to also sweep stale function rows.");
      return;
    }

    console.log(`\nPhase 2 — function existence sweep across ${loadable.length} loadable packages...`);
    const deleteFn = db.prepare(`DELETE FROM functions WHERE package = ? AND name = ?`);
    const deleteDoc = db.prepare(`DELETE FROM search_docs WHERE function_id = ?`);
    const deleteFts = db.prepare(`DELETE FROM search_docs_fts WHERE rowid IN (SELECT rowid FROM search_docs WHERE function_id = ?)`);
    const selectIndexed = db.prepare(`SELECT name FROM functions WHERE package = ? AND COALESCE(is_stub, 0) = 0`);

    let totalDead = 0;
    const deadByPkg = new Map<string, string[]>();
    for (const pkg of loadable) {
      const exported = listExportedFunctions(pkg);
      if (!exported) continue; // unexpected — can't list, skip
      const indexed = (selectIndexed.all(pkg) as Array<{ name: string }>).map((r) => r.name);
      const dead = indexed.filter((n) => !exported.has(n));
      if (dead.length === 0) continue;
      deadByPkg.set(pkg, dead);
      totalDead += dead.length;
      if (!flags.dryRun) {
        const tx = db.transaction((names: string[]) => {
          for (const name of names) {
            const id = `${pkg}::${name}`;
            deleteFts.run(id);
            deleteDoc.run(id);
            deleteFn.run(pkg, name);
          }
        });
        tx(dead);
      }
    }

    console.log(`  packages with stale functions: ${deadByPkg.size}`);
    console.log(`  total stale function rows: ${totalDead}`);
    if (totalDead > 0) {
      const top = [...deadByPkg.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
      for (const [pkg, names] of top) {
        const preview = names.slice(0, 5).join(", ");
        const more = names.length > 5 ? `, +${names.length - 5} more` : "";
        console.log(`    ${pkg}: ${names.length} stale (${preview}${more})`);
      }
      if (!flags.dryRun) console.log(`  ✓ deleted ${totalDead} stale function rows + matching search_docs/FTS5 entries`);
      else console.log(`  (dry-run: no DB writes)`);
    }

    console.log("\nDone.");
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
}
