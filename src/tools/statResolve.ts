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

// NSE-heavy R functions that capture arguments via rlang::enquos / substitute.
// Use stat_call's `expressions` (named NSE args) or `dot_expressions` (unnamed
// `...` slot) instead of `args` for the NSE slots. The hint surfaced from
// stat_resolve tells the agent which slot to use and gives an example.
type NseHint = {
  use_expressions: boolean;
  expression_args: string[];      // named NSE args (use `expressions` field)
  dot_expression: boolean;          // function takes unnamed expressions in `...`
  example: string;
};

const NSE_HINTS: Record<string, NseHint> = {
  "dplyr::filter": {
    use_expressions: true,
    expression_args: [],
    dot_expression: true,
    example: "args={'.data':'mtcars'}, dot_expressions=['cyl > 4', 'mpg > 20']",
  },
  "dplyr::mutate": {
    use_expressions: true,
    expression_args: ["..."],
    dot_expression: false,
    example: "args={'.data':'mtcars'}, expressions={'mpg_kpl':'mpg * 0.425'}",
  },
  "dplyr::transmute": {
    use_expressions: true,
    expression_args: ["..."],
    dot_expression: false,
    example: "args={'.data':'mtcars'}, expressions={'mpg_kpl':'mpg * 0.425'}",
  },
  "dplyr::summarize": {
    use_expressions: true,
    expression_args: ["..."],
    dot_expression: false,
    example: "args={'.data':'mtcars'}, expressions={'mean_mpg':'mean(mpg)', 'n':'n()'}",
  },
  "dplyr::summarise": {
    use_expressions: true,
    expression_args: ["..."],
    dot_expression: false,
    example: "args={'.data':'mtcars'}, expressions={'mean_mpg':'mean(mpg)', 'n':'n()'}",
  },
  "dplyr::group_by": {
    use_expressions: true,
    expression_args: [],
    dot_expression: true,
    example: "args={'.data':'mtcars'}, dot_expressions=['cyl', 'gear']",
  },
  "dplyr::arrange": {
    use_expressions: true,
    expression_args: [],
    dot_expression: true,
    example: "args={'.data':'mtcars'}, dot_expressions=['desc(mpg)', 'cyl']",
  },
  "dplyr::select": {
    use_expressions: true,
    expression_args: [],
    dot_expression: true,
    example: "args={'.data':'mtcars'}, dot_expressions=['mpg', 'cyl', '-disp']",
  },
  "dplyr::count": {
    use_expressions: true,
    expression_args: [],
    dot_expression: true,
    example: "args={'.data':'mtcars'}, dot_expressions=['cyl', 'gear']",
  },
  "dplyr::distinct": {
    use_expressions: true,
    expression_args: [],
    dot_expression: true,
    example: "args={'.data':'mtcars'}, dot_expressions=['cyl', 'gear']",
  },
  "tidyr::pivot_longer": {
    use_expressions: true,
    expression_args: ["cols"],
    dot_expression: false,
    example: "args={'data':'iris'}, expressions={'cols':'-Species'}  # or 'everything()' or 'starts_with(\"Sepal\")'",
  },
  "tidyr::pivot_wider": {
    use_expressions: true,
    expression_args: ["names_from", "values_from", "id_cols"],
    dot_expression: false,
    example: "args={'data':'sleepstudy'}, expressions={'names_from':'Days', 'values_from':'Reaction'}",
  },
  "tidyr::nest": {
    use_expressions: true,
    expression_args: [],
    dot_expression: true,
    example: "args={'.data':'iris'}, dot_expressions=['data = -Species']",
  },
  "tidyr::unnest": {
    use_expressions: true,
    expression_args: ["cols"],
    dot_expression: false,
    example: "args={'data':'nested_df'}, expressions={'cols':'data'}",
  },
  "ggplot2::aes": {
    use_expressions: true,
    expression_args: ["x", "y", "color", "colour", "fill", "shape", "size", "group", "alpha"],
    dot_expression: false,
    example: "expressions={'x':'mpg', 'y':'wt', 'color':'factor(cyl)'}",
  },
};

function getNseHint(pkg: string, fn: string): NseHint | null {
  return NSE_HINTS[`${pkg}::${fn}`] ?? null;
}

// Functions that dispatch on or require a specific R class for one of their
// arguments. The agent reads class_hint and either pre-coerces (via a separate
// stat_call to base::factor / stats::ts) or uses stat_call's `coerce` field.
export type ClassHint = {
  arg: string;
  expected_classes: string[];
  recommended_coerce: string;        // value to pass in stat_call's `coerce` map
  reason: string;
};

const CLASS_HINTS: Record<string, ClassHint[]> = {
  "randomForest::randomForest": [{
    arg: "y",
    expected_classes: ["factor"],
    recommended_coerce: "factor",
    reason: "Classification dispatch keys off factor; character/numeric y is treated as regression or fails on type check.",
  }],
  "glmnet::glmnet": [{
    arg: "y",
    expected_classes: ["factor", "numeric", "matrix"],
    recommended_coerce: "factor",
    reason: "Pass family='binomial'/'multinomial' with a factor y for classification; numeric y for regression. Use coerce={y:'factor'} when y starts as character.",
  }],
  "glmnet::cv.glmnet": [{
    arg: "y",
    expected_classes: ["factor", "numeric", "matrix"],
    recommended_coerce: "factor",
    reason: "Same dispatch as glmnet::glmnet.",
  }],
  "forecast::auto.arima": [{
    arg: "y",
    expected_classes: ["ts", "msts", "numeric"],
    recommended_coerce: "ts(frequency=12)",
    reason: "Seasonal ARIMA detection requires a ts class with explicit frequency. For monthly data use frequency=12, weekly=7, quarterly=4, daily=365.25.",
  }],
  "forecast::Arima": [{
    arg: "y",
    expected_classes: ["ts", "msts", "numeric"],
    recommended_coerce: "ts(frequency=12)",
    reason: "Pass a ts object; specify frequency for seasonal models.",
  }],
  "forecast::ets": [{
    arg: "y",
    expected_classes: ["ts", "msts"],
    recommended_coerce: "ts(frequency=12)",
    reason: "ETS state-space model requires a ts class. Use coerce={y:'ts(frequency=12)'} for monthly data.",
  }],
  "stats::stl": [{
    arg: "x",
    expected_classes: ["ts"],
    recommended_coerce: "ts(frequency=12)",
    reason: "STL decomposition requires a ts class with explicit frequency >= 2.",
  }],
  "stats::HoltWinters": [{
    arg: "x",
    expected_classes: ["ts"],
    recommended_coerce: "ts(frequency=12)",
    reason: "Holt-Winters needs a ts class; specify frequency for seasonal models.",
  }],
  "stats::decompose": [{
    arg: "x",
    expected_classes: ["ts"],
    recommended_coerce: "ts(frequency=12)",
    reason: "Classical decomposition requires a ts class with frequency > 1.",
  }],
};

export function getClassHint(pkg: string, fn: string): ClassHint[] | null {
  return CLASS_HINTS[`${pkg}::${fn}`] ?? null;
}

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
    const samePackageSuggestions = searchEngine.suggestFunctions(lookupPkg, fn);
    const packageSuggestions = searchEngine.suggestPackages(lookupPkg);
    const didYouMean = {
      ...(samePackageSuggestions.length > 0 ? { same_package: samePackageSuggestions } : {}),
      ...(packageSuggestions.length > 0 ? { packages: packageSuggestions } : {}),
    };
    const hasSuggestions = Object.keys(didYouMean).length > 0;

    logUsage({ type: "resolve", timestamp: new Date().toISOString(), package: pkg, function: fn, success: false, error_code: "not_found", latency_ms: elapsed() });
    return errorResult(
      `Function '${fn}' not found in package '${pkg}'. Use stat_search to find the correct function.`,
      {
        package: pkg,
        function: fn,
        ...(hasSuggestions ? { did_you_mean: didYouMean } : {}),
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
  const nseHint = !isPython ? getNseHint(pkg, fn) : null;
  const classHint = !isPython ? getClassHint(pkg, fn) : null;
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
    ...(nseHint ? { nse_hint: nseHint } : {}),
    ...(classHint ? { class_hint: classHint } : {}),
  });
}
