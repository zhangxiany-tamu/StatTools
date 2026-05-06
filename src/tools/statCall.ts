// ============================================================================
// StatTools — stat_call Tool
// ============================================================================
// Execute a resolved R function. Precondition: function must have been
// resolved via stat_resolve in the current session.

import type { WorkerPool } from "../engine/workerPool.js";
import type { PythonWorker } from "../engine/PythonWorker.js";
import {
  type SessionStore,
  isResolved,
  registerHandle,
} from "../engine/session.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";
import { logUsage, startTimer } from "../util/usageLogger.js";

export const STAT_CALL_SCHEMA = {
  type: "object" as const,
  properties: {
    package: {
      type: "string",
      description: "R package name (must have been resolved via stat_resolve first)",
    },
    function: {
      type: "string",
      description: "R function name (must have been resolved via stat_resolve first)",
    },
    args: {
      type: "object",
      description:
        "Named arguments as JSON. Object references (e.g. 'data_1', 'model_1') are resolved automatically. Formula strings (e.g. 'mpg ~ wt + hp') are converted to R formulas.",
      additionalProperties: true,
    },
    expressions: {
      type: "object",
      description:
        "NSE escape hatch (R only). Named map of arg name → R expression string, parsed via rlang::parse_expr and forwarded as a language object. Use for functions that capture arguments via NSE — e.g. tidyr::pivot_longer with cols='-Species' or 'everything()', dplyr::mutate with new_col='mpg * 0.425', ggplot2::aes with x='mpg'. Example: { cols: '-Species', mpg_kpl: 'mpg * 0.425' }.",
      additionalProperties: { type: "string" },
    },
    dot_expressions: {
      type: "array",
      items: { type: "string" },
      description:
        "NSE escape hatch (R only). Array of R expression strings appended as unnamed positional args (consumed by `...`). Use for functions like dplyr::filter that take unnamed predicates: dot_expressions=['cyl > 4', 'mpg > 20']. For named expressions inside `...` (e.g. dplyr::mutate's `new_col = expr`), use `expressions` instead.",
    },
    dot_args: {
      type: "array",
      items: { type: "string" },
      description:
        "R only. Array of session handle IDs or literal values appended as unnamed positional args (consumed by `...`). Unlike dot_expressions, values are resolved as session handles (or passed as-is if not a handle), NOT parsed as R expressions. Use for functions like stats::anova(m1, m2) that take a sequence of objects: dot_args=['model_1', 'model_2'].",
    },
    coerce: {
      type: "object",
      description:
        "R only. Map of arg name → coercion spec applied before the call. Whitelisted specs: 'factor' / 'character' / 'numeric' / 'integer' / 'matrix' / 'data.frame', and 'ts' / 'ts(frequency=N)' / 'ts(frequency=N,start=Y)'. Use this when stat_resolve's class_hint says an arg needs a specific class — e.g. randomForest needs y as factor for classification: coerce={y:'factor'}; auto.arima/stl need ts: coerce={y:'ts(frequency=12)'}.",
      additionalProperties: { type: "string" },
    },
    assign_to: {
      type: "string",
      description:
        "Optional: name for the result handle (e.g. 'model_1'). Auto-generated for model/test results if omitted.",
    },
  },
  required: ["package", "function", "args"],
};

export type StatCallInput = {
  package: string;
  function: string;
  args: Record<string, unknown>;
  expressions?: Record<string, string>;
  dot_expressions?: string[];
  dot_args?: string[];
  coerce?: Record<string, string>;
  assign_to?: string;
};

export async function executeStatCall(
  input: StatCallInput,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  pythonWorker?: PythonWorker | null,
): Promise<StatToolResult> {
  const { package: pkg, function: fn, args, expressions, dot_expressions, dot_args, coerce, assign_to } = input;
  const elapsed = startTimer();

  // Detect runtime
  const isPython = pkg.startsWith("sklearn") || pkg.startsWith("scipy") ||
    pkg.startsWith("statsmodels") || pkg.startsWith("pandas") ||
    pkg.startsWith("numpy");

  // NSE/coerce slots are R-only (Python uses keyword args + DataFrame methods)
  if (isPython && (expressions || dot_expressions || dot_args || coerce)) {
    return errorResult(
      "expressions/dot_expressions/dot_args/coerce are R-only. Python uses keyword args via stat_call and stat_method.",
      { package: pkg, function: fn },
    );
  }

  // 1. Check function was resolved in this session
  if (!isResolved(sessionStore, pkg, fn)) {
    return errorResult(
      `Function '${pkg}::${fn}' has not been resolved in this session. Call stat_resolve first.`,
      {
        package: pkg,
        function: fn,
        hint: "Use stat_search to find functions, then stat_resolve to validate before calling.",
      },
    );
  }

  // 2. Call appropriate worker
  let response;
  try {
    if (isPython) {
      if (!pythonWorker) {
        return errorResult("Python runtime not available.");
      }
      response = await pythonWorker.call("call", {
        module: pkg,
        function: fn,
        args,
        assign_to: assign_to || null,
      });
    } else {
      response = await workerPool.call("call", {
        package: pkg,
        function: fn,
        args,
        ...(expressions ? { expressions } : {}),
        ...(dot_expressions ? { dot_expressions } : {}),
        ...(dot_args ? { dot_args } : {}),
        ...(coerce ? { coerce } : {}),
        assign_to: assign_to || null,
      });
    }
  } catch (err) {
    return errorResult(
      `${isPython ? "Python" : "R"} execution failed: ${(err as Error).message}`,
      { package: pkg, function: fn },
    );
  }

  // 3. Handle R errors
  if (response.error) {
    logUsage({ type: "call", timestamp: new Date().toISOString(), package: pkg, function: fn, runtime: isPython ? "python" : "r", success: false, error_code: String(response.error.code), latency_ms: elapsed() });
    return errorResult(response.error.message, {
      package: pkg,
      function: fn,
      code: response.error.code,
      suggestion: response.error.suggestion,
      traceback: response.error.traceback,
    });
  }

  // 4. Register created handles with correct runtime
  if (response.objectsCreated) {
    for (const obj of response.objectsCreated) {
      registerHandle(
        sessionStore,
        obj,
        isPython ? "python" : workerPool.getStatus().activeWorkerId!,
        `stat_call:${pkg}::${fn}`,
        isPython ? "python" : "r",
      );
    }
  }

  logUsage({ type: "call", timestamp: new Date().toISOString(), package: pkg, function: fn, runtime: isPython ? "python" : "r", success: true, latency_ms: elapsed() });

  // 5. Build result
  const result: Record<string, unknown> = {
    result: response.result,
  };

  if (response.warnings && response.warnings.length > 0) {
    result.warnings = response.warnings;
  }

  if (response.stdout && response.stdout.length > 0) {
    result.stdout = response.stdout;
  }

  if (response.objectsCreated && response.objectsCreated.length > 0) {
    result.objects_created = response.objectsCreated.map((o) => ({
      id: o.id,
      type: o.type,
      summary: o.summary,
    }));
  }

  return successResult(result);
}
