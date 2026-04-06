// ============================================================================
// StatTools — stat_resolve Tool
// ============================================================================
// Validation gate: validates package::function exists, generates schema
// on-demand, returns safety class + caveats. Registers function as
// "resolved" in session — stat_call rejects unresolved functions.

import type { SearchEngine } from "../search/searchEngine.js";
import type { WorkerPool } from "../engine/workerPool.js";
import type { PythonWorker } from "../engine/PythonWorker.js";
import type { SessionStore } from "../engine/session.js";
import { markResolved } from "../engine/session.js";
import { logUsage, startTimer } from "../util/usageLogger.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";

export const STAT_RESOLVE_SCHEMA = {
  type: "object" as const,
  properties: {
    package: {
      type: "string",
      description:
        "Package/module name. R: 'stats', 'lme4'. Python: 'sklearn.linear_model'. Use stat_search to find it.",
    },
    function: {
      type: "string",
      description:
        "R function name (e.g. 'lm', 'lmer', 'coxph'). Use stat_search to find the right function.",
    },
  },
  required: ["package", "function"],
};

export type StatResolveInput = {
  package: string;
  function: string;
};

export async function executeStatResolve(
  input: StatResolveInput,
  searchEngine: SearchEngine,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  pythonWorker?: PythonWorker | null,
): Promise<StatToolResult> {
  const { package: pkg, function: fn } = input;
  const elapsed = startTimer();

  // Detect runtime: check both R-style and Python-style IDs
  const isPython = searchEngine.functionExists(`py::${pkg}`, fn) ||
    pkg.startsWith("sklearn") || pkg.startsWith("scipy") ||
    pkg.startsWith("statsmodels") || pkg.startsWith("pandas") ||
    pkg.startsWith("numpy");

  // 1. Check if function exists in index
  const lookupPkg = isPython ? `py::${pkg}` : pkg;
  const meta = searchEngine.getFunctionMeta(
    isPython ? lookupPkg : pkg,
    fn,
  );

  if (!meta) {
    logUsage({ type: "resolve", timestamp: new Date().toISOString(), package: pkg, function: fn, success: false, error_code: "not_found", latency_ms: elapsed() });
    return errorResult(
      `Function '${fn}' not found in package '${pkg}'. Use stat_search to find the correct function.`,
      {
        package: pkg,
        function: fn,
      },
    );
  }

  // 2. Check if this is a package stub (no function-level metadata)
  if (meta.isStub) {
    logUsage({ type: "resolve", timestamp: new Date().toISOString(), package: pkg, function: fn, success: false, error_code: "stub", is_stub: true, latency_ms: elapsed() });
    return errorResult(
      `'${pkg}::${fn}' is a package-level stub — function-level metadata is not available. ` +
      (meta.installed
        ? "Package is installed but not yet indexed. Call stat_install to trigger indexing — it will detect the package is already installed and index it without reinstalling."
        : `Package '${pkg}' is not installed. Use stat_install to install it — the package will be auto-indexed once installation completes.`),
      {
        package: pkg,
        function: fn,
        is_stub: true,
        installed: meta.installed,
        title: meta.title,
        description: meta.description,
      },
    );
  }

  // 3. Check safety class
  if (meta.safetyClass === "unsafe") {
    logUsage({ type: "resolve", timestamp: new Date().toISOString(), package: pkg, function: fn, success: false, error_code: "unsafe", safety_class: "unsafe", latency_ms: elapsed() });
    return errorResult(
      `Function '${pkg}::${fn}' is classified as unsafe (file I/O, network, or side effects). Blocked by default.`,
      {
        package: pkg,
        function: fn,
        safety_class: meta.safetyClass,
      },
    );
  }

  if (meta.safetyClass === "unclassified" && !isPython) {
    logUsage({ type: "resolve", timestamp: new Date().toISOString(), package: pkg, function: fn, success: false, error_code: "unclassified", safety_class: "unclassified", latency_ms: elapsed() });
    return errorResult(
      `Function '${pkg}::${fn}' has not been reviewed for agent use. Discoverable but not callable in this environment.`,
      {
        package: pkg,
        function: fn,
        safety_class: "unclassified",
        title: meta.title,
        description: meta.description,
      },
    );
  }
  // Python functions are callable by default (they're curated in schema_extractor.py)

  // 3. Check if package is installed
  if (!meta.installed) {
    return errorResult(
      `Package '${pkg}' is not installed. Use stat_install to install it first.`,
      {
        package: pkg,
        function: fn,
        installed: false,
      },
    );
  }

  // 4. Generate schema on-demand via appropriate worker
  let schema: unknown = null;
  const runtime = isPython ? "python" : "r";

  try {
    if (isPython && pythonWorker) {
      const schemaResp = await pythonWorker.call("schema", {
        module: pkg,
        function: fn,
      });
      if (schemaResp.error) {
        return errorResult(`Failed to extract schema: ${schemaResp.error.message}`);
      }
      schema = schemaResp.result;
    } else if (!isPython) {
      const schemaResp = await workerPool.call("schema", {
        package: pkg,
        function: fn,
      });
      if (schemaResp.error) {
        return errorResult(`Failed to extract schema: ${schemaResp.error.message}`);
      }
      schema = schemaResp.result;
    } else {
      // Python worker not available
      return errorResult(
        `Python runtime not available. Cannot resolve Python function '${pkg}::${fn}'.`,
      );
    }
  } catch (err) {
    return errorResult(`Schema extraction failed: ${(err as Error).message}`);
  }

  // 5. Register as resolved in session
  markResolved(sessionStore, pkg, fn);

  logUsage({
    type: "resolve",
    timestamp: new Date().toISOString(),
    package: pkg,
    function: fn,
    runtime,
    success: true,
    safety_class: meta.safetyClass,
    is_stub: meta.isStub,
    latency_ms: elapsed(),
  });

  // 6. Return full metadata
  const schemaResult = schema as Record<string, unknown>;
  return successResult({
    package: pkg,
    function: fn,
    runtime,
    resolved: true,
    safety_class: meta.safetyClass,
    title: meta.title,
    description: meta.description,
    has_formula: meta.hasFormula,
    has_dots: meta.hasDots,
    installed: meta.installed,
    schema: schemaResult?.schema ?? null,
    typical_return_class: schemaResult?.typical_return_class ?? null,
    docstring: isPython ? (schemaResult as any)?.docstring ?? null : undefined,
    caveats: [],
  });
}
