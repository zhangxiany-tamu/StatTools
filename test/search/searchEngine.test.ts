import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SearchEngine } from "../../src/search/searchEngine.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/stattools.db");
const BENCHMARK_PATH = resolve(__dirname, "benchmark.json");

type BenchmarkQuery = {
  query: string;
  expected_top3: string[];
  note: string;
  category?: string;
  requires_install?: boolean;
};

type Benchmark = {
  queries: BenchmarkQuery[];
};

type BenchmarkResult = {
  query: string;
  passed: boolean;
  expected: string[];
  gotTop3: string[];
  gotTop1: string | undefined;
  note: string;
  category: string;
  firstCallableRank: number; // 1-indexed, 0 = none found
  reciprocalRank: number;    // 1/rank of first expected hit, 0 if not found
};

describe("SearchEngine", () => {
  let engine: SearchEngine;

  beforeAll(() => {
    engine = new SearchEngine(DB_PATH);
  });

  afterAll(() => {
    engine.close();
  });

  it("returns results for basic queries", () => {
    const results = engine.search({ query: "linear regression" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].functionId).toBeDefined();
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns empty array for nonsense query", () => {
    const results = engine.search({ query: "qzxjvmkwplfnhgbtdy" });
    expect(results).toHaveLength(0);
  });

  it("respects maxResults", () => {
    const results = engine.search({
      query: "test",
      maxResults: 3,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("functionExists returns true for known function", () => {
    expect(engine.functionExists("stats", "lm")).toBe(true);
  });

  it("functionExists returns false for unknown function", () => {
    expect(engine.functionExists("stats", "nonexistent_fn")).toBe(false);
  });

  it("getFunctionMeta returns metadata for known function", () => {
    const meta = engine.getFunctionMeta("stats", "lm");
    expect(meta).not.toBeNull();
    expect(meta!.title).toContain("Linear");
    expect(meta!.hasFormula).toBe(true);
  });

  // ---- Benchmark Tests -----------------------------------------------------

  describe("benchmark", () => {
    let benchmark: Benchmark;
    let cachedResults: BenchmarkResult[] | null = null;

    beforeAll(() => {
      benchmark = JSON.parse(
        readFileSync(BENCHMARK_PATH, "utf-8"),
      ) as Benchmark;
    });

    const runBenchmark = (): BenchmarkResult[] => {
      if (cachedResults) return cachedResults;
      const results: BenchmarkResult[] = [];

      for (const q of benchmark.queries) {
        const searchResults = engine.search({
          query: q.query,
          maxResults: 10,
        });
        const topIds = searchResults.map((r) => r.functionId);
        const top3Ids = topIds.slice(0, 3);

        const passed = q.expected_top3.every((expected) =>
          top3Ids.includes(expected),
        );

        // First callable result rank (1-indexed)
        const firstCallable = searchResults.findIndex(
          (r) => r.safetyClass === "safe" || r.safetyClass === "callable_with_caveats",
        );

        // Reciprocal rank: 1/rank of first expected hit in full results
        let reciprocalRank = 0;
        for (const expected of q.expected_top3) {
          const idx = topIds.indexOf(expected);
          if (idx >= 0) {
            reciprocalRank = Math.max(reciprocalRank, 1 / (idx + 1));
          }
        }

        results.push({
          query: q.query,
          passed,
          expected: q.expected_top3,
          gotTop3: top3Ids,
          gotTop1: topIds[0],
          note: q.note,
          category: q.category || "uncategorized",
          firstCallableRank: firstCallable >= 0 ? firstCallable + 1 : 0,
          reciprocalRank,
        });
      }

      cachedResults = results;
      return results;
    };

    it("dev gate: ≥40% of installed-package queries pass (blocks CI)", { timeout: 120_000 }, () => {
      const allResults = runBenchmark();
      // Exclude queries that require packages not in the index
      const installable = allResults.filter(
        (r) => !benchmark.queries.find((q) => q.query === r.query)?.requires_install,
      );
      const passed = installable.filter((r) => r.passed).length;
      const total = installable.length;
      const passRate = passed / total;

      console.log(`\n=== Search Benchmark: ${passed}/${total} (${(passRate * 100).toFixed(0)}%) ===`);
      // Only print failures to avoid overwhelming vitest worker IPC
      const failures = allResults.filter(
        (r) => !r.passed && !benchmark.queries.find((q) => q.query === r.query)?.requires_install,
      );
      if (failures.length > 0) {
        console.log("Failures:");
        for (const r of failures) {
          console.log(`  ✗ "${r.query}" → [${r.gotTop3.join(", ")}] (expected: ${r.expected})`);
        }
      }

      // Dev gate: ≥40%. Current: 100% (95/95).
      expect(passRate).toBeGreaterThanOrEqual(0.4);
    });

    it("release gate: ≥70% of installed-package queries pass (blocks CI)", { timeout: 120_000 }, () => {
      const allResults = runBenchmark();
      const installable = allResults.filter(
        (r) => !benchmark.queries.find((q) => q.query === r.query)?.requires_install,
      );
      const passed = installable.filter((r) => r.passed).length;
      const total = installable.length;
      const passRate = passed / total;

      console.log(`\n  Release gate: ${passed}/${total} (${(passRate * 100).toFixed(0)}%) — target 70%`);

      // Release gate: 70%. Current: 14/20 (70%).
      expect(passRate).toBeGreaterThanOrEqual(0.7);
    });

    it("per-category metrics breakdown", { timeout: 120_000 }, () => {
      const allResults = runBenchmark();
      const installable = allResults.filter(
        (r) => !benchmark.queries.find((q) => q.query === r.query)?.requires_install,
      );

      // Group by category
      const categories = new Map<string, BenchmarkResult[]>();
      for (const r of installable) {
        const cat = r.category;
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat)!.push(r);
      }

      // Compute per-category metrics
      const mrr = installable.reduce((sum, r) => sum + r.reciprocalRank, 0) / installable.length;
      const top1 = installable.filter((r) => {
        return r.expected.some((e) => r.gotTop1 === e);
      }).length / installable.length;
      const top3 = installable.filter((r) => r.passed).length / installable.length;
      const avgFirstCallable = installable.filter((r) => r.firstCallableRank > 0)
        .reduce((sum, r) => sum + r.firstCallableRank, 0) /
        Math.max(1, installable.filter((r) => r.firstCallableRank > 0).length);

      console.log("\n=== Per-Category Benchmark Metrics ===");
      console.log(`  Overall: top-1=${(top1 * 100).toFixed(0)}% | top-3=${(top3 * 100).toFixed(0)}% | MRR=${mrr.toFixed(3)} | avg-first-callable=${avgFirstCallable.toFixed(1)}`);

      for (const [cat, results] of [...categories.entries()].sort()) {
        const catPassed = results.filter((r) => r.passed).length;
        const catMrr = results.reduce((s, r) => s + r.reciprocalRank, 0) / results.length;
        console.log(`  ${cat}: ${catPassed}/${results.length} (${((catPassed / results.length) * 100).toFixed(0)}%) MRR=${catMrr.toFixed(3)}`);
      }

      // Informational — no assertion (individual category gates are tracked, not enforced)
    });

    // Individual hard requirements
    it("finds stats::lm for 'linear regression'", () => {
      const results = engine.search({ query: "linear regression", maxResults: 5 });
      const ids = results.map((r) => r.functionId);
      expect(ids).toContain("stats::lm");
    });

    it("ranks dplyr::filter above stats::filter for 'filter rows'", () => {
      const results = engine.search({ query: "filter rows", maxResults: 10 });
      const dplyrIdx = results.findIndex((r) => r.functionId === "dplyr::filter");
      const statsIdx = results.findIndex((r) => r.functionId === "stats::filter");

      if (dplyrIdx >= 0 && statsIdx >= 0) {
        expect(dplyrIdx).toBeLessThan(statsIdx);
      } else {
        // At minimum, dplyr::filter should appear
        expect(dplyrIdx).toBeGreaterThanOrEqual(0);
      }
    });

    it("finds stats::t.test for 't test'", () => {
      const results = engine.search({ query: "t test", maxResults: 5 });
      const ids = results.map((r) => r.functionId);
      expect(ids).toContain("stats::t.test");
    });
  });
});
