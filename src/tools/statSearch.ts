// ============================================================================
// StatTools — stat_search Tool
// ============================================================================
// Discovery: search 24k+ functions by natural language query.
// Returns ranked results with package, function, title, description,
// safety class, installed status.

import type { SearchEngine, SearchResult } from "../search/searchEngine.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";
import { logUsage, startTimer } from "../util/usageLogger.js";

export const STAT_SEARCH_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description:
        "Natural language search query. Examples: 'linear regression', 'mixed effects model', 'survival analysis', 'chi squared test'",
    },
    task_view: {
      type: "string",
      description:
        "Optional: filter by CRAN Task View category (e.g. 'Survival', 'Bayesian', 'Econometrics', 'MachineLearning')",
    },
    installed_only: {
      type: "boolean",
      description: "Only return functions from installed packages (default: false)",
    },
    safe_only: {
      type: "boolean",
      description:
        "Only return functions classified as 'safe' or 'callable_with_caveats' (default: false)",
    },
    max_results: {
      type: "number",
      description: "Maximum number of results to return (default: 10)",
    },
  },
  required: ["query"],
};

export type StatSearchInput = {
  query: string;
  task_view?: string;
  installed_only?: boolean;
  safe_only?: boolean;
  max_results?: number;
};

export function executeStatSearch(
  input: StatSearchInput,
  searchEngine: SearchEngine,
): StatToolResult {
  const { query, task_view, installed_only, safe_only, max_results } = input;

  if (!query || query.trim().length === 0) {
    return errorResult("Search query cannot be empty.");
  }

  const elapsed = startTimer();
  const results = searchEngine.search({
    query: query.trim(),
    taskView: task_view,
    installedOnly: installed_only,
    safeOnly: safe_only,
    maxResults: max_results ?? 10,
  });

  logUsage({
    type: "search",
    timestamp: new Date().toISOString(),
    query,
    result_count: results.length,
    top_results: results.slice(0, 5).map((r) => r.functionId),
    success: results.length > 0,
    is_stub: results.length > 0 ? results[0].isStub : undefined,
    latency_ms: elapsed(),
  });

  if (results.length === 0) {
    return successResult({
      query,
      results: [],
      message:
        "No matching functions found. Try different keywords or broaden your search.",
    });
  }

  const callableCount = results.filter(
    (r) => r.safetyClass === "safe" || r.safetyClass === "callable_with_caveats",
  ).length;

  return successResult({
    query,
    result_count: results.length,
    callable_count: callableCount,
    results: results.map(formatResult),
    next_step:
      "Use stat_resolve(package, function) to validate and get the full schema before calling.",
    ...(callableCount === 0 && {
      warning:
        "No callable results found. All results are unclassified and cannot be executed yet. Try a more specific query.",
    }),
  });
}

function formatResult(r: SearchResult): Record<string, unknown> {
  return {
    package: r.package,
    function: r.functionName,
    id: r.functionId,
    runtime: r.runtime,
    title: r.title,
    description: r.description.slice(0, 200),
    safety_class: r.safetyClass,
    installed: r.installed,
    install_status: r.installStatus,
    downloads_monthly: r.downloadsMonthly,
    has_formula: r.hasFormula,
    is_stub: r.isStub,
    ...(r.isStub && {
      stub_note: "Package-level entry only. Use stat_install to install — functions will be auto-indexed on completion.",
    }),
  };
}
