// ============================================================================
// StatTools — MCP Server
// ============================================================================
// Wires all tools to the @modelcontextprotocol/sdk Server.
// Transport: stdio (for Claude Code, Cursor, etc.)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { SearchEngine } from "./search/searchEngine.js";
import { WorkerPool } from "./engine/workerPool.js";
import { PythonWorker } from "./engine/PythonWorker.js";
import {
  createSessionStore,
  recordFailure,
  type SessionStore,
} from "./engine/session.js";

import {
  STAT_SEARCH_SCHEMA,
  executeStatSearch,
  type StatSearchInput,
} from "./tools/statSearch.js";
import {
  STAT_RESOLVE_SCHEMA,
  executeStatResolve,
  type StatResolveInput,
} from "./tools/statResolve.js";
import {
  STAT_CALL_SCHEMA,
  executeStatCall,
  type StatCallInput,
} from "./tools/statCall.js";
import {
  STAT_LOAD_DATA_SCHEMA,
  executeStatLoadData,
  resolveDataRoots,
  type StatLoadDataInput,
} from "./tools/statLoadData.js";
import {
  STAT_SESSION_SCHEMA,
  executeStatSession,
  type StatSessionInput,
} from "./tools/statSession.js";
import {
  STAT_DESCRIBE_SCHEMA,
  executeStatDescribe,
  type StatDescribeInput,
} from "./tools/statDescribe.js";

import {
  STAT_INSTALL_SCHEMA,
  executeStatInstall,
  InstallManager,
  type StatInstallInput,
} from "./tools/statInstall.js";
import {
  STAT_METHOD_SCHEMA,
  executeStatMethod,
  type StatMethodInput,
} from "./tools/statMethod.js";

import {
  STAT_EXTRACT_SCHEMA,
  executeStatExtract,
  type StatExtractInput,
} from "./tools/statExtract.js";
import {
  STAT_PLOT_SCHEMA,
  executeStatPlot,
  type StatPlotInput,
} from "./tools/statPlot.js";

import { reindexPackage } from "./search/incrementalReindex.js";

import { FAILURE_PAYLOAD, errorResult, type StatToolResult } from "./types.js";
import { randomBytes } from "node:crypto";

export type ServerConfig = {
  dbPath: string;
  allowedDataRoots?: string[];
  rPath?: string;
  pythonPath?: string;
  recycleAfterCalls?: number;
};

export async function createStatToolsServer(
  config: ServerConfig,
): Promise<{ server: Server; cleanup: () => Promise<void> }> {
  // Session ID
  const sessionId = "s_" + randomBytes(6).toString("hex");

  // Initialize components
  const searchEngine = new SearchEngine(config.dbPath);
  const sessionStore = createSessionStore(sessionId);
  // Only pass defined values to avoid overriding defaults with undefined
  const poolConfig: Record<string, unknown> = {};
  if (config.rPath) poolConfig.rPath = config.rPath;
  if (config.recycleAfterCalls) poolConfig.recycleAfterCalls = config.recycleAfterCalls;
  const workerPool = new WorkerPool(sessionStore, poolConfig);

  await workerPool.start();

  // Python worker — always created. start() never throws; final state is
  // exposed via getStatus().state so tools can return structured diagnostics
  // instead of generic "not available" errors.
  const pythonWorker = new PythonWorker({
    pythonPath: config.pythonPath || process.env.PYTHON_PATH || "python3",
  });
  await pythonWorker.start();
  const pythonStatus = pythonWorker.getStatus();
  switch (pythonStatus.state) {
    case "spawn_failed":
      console.error(
        `[StatTools] Python spawn failed at ${pythonStatus.path}: ${pythonStatus.error ?? "unknown error"} — Python tools disabled`,
      );
      break;
    case "modules_missing":
      console.error(
        `[StatTools] Python at ${pythonStatus.path} is reachable but missing modules: ${pythonStatus.missingModules.join(", ") || "(unknown)"} — install with pip then restart the server`,
      );
      break;
    case "healthy":
      break;
    default:
      console.error(
        `[StatTools] Python worker in unexpected state '${pythonStatus.state}' at ${pythonStatus.path}`,
      );
  }

  // Path policy — resolved once per server instance, not global
  const allowedDataRoots = resolveDataRoots(
    config.allowedDataRoots || [process.cwd()],
  );

  // Install manager — per server instance
  const installManager = new InstallManager(config.rPath);

  // Wire incremental reindex: after successful install, extract metadata
  // and refresh the search engine so the new package is immediately searchable.
  installManager.onInstallComplete = (packageName: string) => {
    reindexPackage(config.dbPath, packageName, config.rPath)
      .then((result) => {
        if (result.functionsInserted > 0) {
          searchEngine.refresh();
          console.error(
            `[StatTools] Reindexed ${packageName}: ${result.functionsInserted} functions (${result.durationMs}ms)`,
          );
        }
      })
      .catch((err) => {
        console.error(`[StatTools] Reindex failed for ${packageName}:`, (err as Error).message);
      });
  };

  // Create MCP server
  const server = new Server(
    { name: "stattools", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // ---- tools/list ----------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "stat_search",
        description:
          "Search 24,000+ R functions by natural language. Returns ranked results with package, function name, description, and safety classification. Use this to discover what R functions are available for your analysis task.",
        inputSchema: STAT_SEARCH_SCHEMA,
      },
      {
        name: "stat_resolve",
        description:
          "Validate an R function and get its full parameter schema. Must be called before stat_call. Returns argument names, types, defaults, and safety classification.",
        inputSchema: STAT_RESOLVE_SCHEMA,
      },
      {
        name: "stat_call",
        description:
          "Execute a resolved R function with structured arguments. The function must have been validated via stat_resolve first. Returns structured JSON results (coefficients, p-values, etc.), not raw R console output. For NSE-heavy functions (dplyr verbs, tidyr pivots, ggplot2::aes), use the `expressions` and `dot_expressions` fields to pass R expression strings — see stat_resolve's `nse_hint` for guidance.",
        inputSchema: STAT_CALL_SCHEMA,
      },
      {
        name: "stat_load_data",
        description:
          "Load data into the session. Two modes: (1) `file_path` for CSV/TSV/RDS files; (2) `dataset` for built-in R datasets like 'mtcars', 'iris', 'AirPassengers' — pass `package` for non-default packages (e.g. 'sleepstudy'/'cbpp' from lme4, 'lung' from survival). Returns a handle ID with column schema and preview. Default runtime is R; set runtime='python' to load a file as a pandas DataFrame.",
        inputSchema: STAT_LOAD_DATA_SCHEMA,
      },
      {
        name: "stat_session",
        description:
          "View current session state: loaded data handles, fitted model handles, resolved functions, and R worker status.",
        inputSchema: STAT_SESSION_SCHEMA,
      },
      {
        name: "stat_describe",
        description:
          "Inspect a data or model handle without full serialization. Actions: 'schema' (column types), 'head' (first rows), 'dimensions', 'summary' (stats), 'str' (R structure).",
        inputSchema: STAT_DESCRIBE_SCHEMA,
      },
      {
        name: "stat_install",
        description:
          "Install an R package from CRAN. Runs in the background — check stat_session for completion. Returns installation status and error details if the build fails.",
        inputSchema: STAT_INSTALL_SCHEMA,
      },
      {
        name: "stat_method",
        description:
          "Call a method on a Python session object. Use for sklearn/statsmodels workflows: model.fit(X, y), model.predict(X), model.score(X, y), scaler.transform(X), etc. The object must have been created by a previous stat_call.",
        inputSchema: STAT_METHOD_SCHEMA,
      },
      {
        name: "stat_extract",
        description:
          "Extract columns from a data handle as a vector or matrix. Use to build X matrices and y vectors for APIs like glmnet that don't accept formulas. Single column returns a vector, multiple columns return a data frame or matrix (set as_matrix=true).",
        inputSchema: STAT_EXTRACT_SCHEMA,
      },
      {
        name: "stat_plot",
        description:
          "Render a plot to a file (PNG/PDF/SVG) and return the file path. Accepts either a stored ggplot handle or an R expression string. Session data handles are available by name in expressions. Example: expression='ggplot(data_1, aes(x=wt, y=mpg)) + geom_point() + geom_smooth(method=\"lm\")'",
        inputSchema: STAT_PLOT_SCHEMA,
      },
    ],
  }));

  // ---- tools/call ----------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    let result: StatToolResult;

    switch (name) {
      case "stat_search":
        result = executeStatSearch(
          args as unknown as StatSearchInput,
          searchEngine,
        );
        break;

      case "stat_resolve":
        result = await executeStatResolve(
          args as unknown as StatResolveInput,
          searchEngine,
          workerPool,
          sessionStore,
          pythonWorker,
        );
        break;

      case "stat_call":
        result = await executeStatCall(
          args as unknown as StatCallInput,
          workerPool,
          sessionStore,
          pythonWorker,
        );
        break;

      case "stat_load_data":
        result = await executeStatLoadData(
          args as unknown as StatLoadDataInput,
          workerPool,
          sessionStore,
          allowedDataRoots,
          pythonWorker,
        );
        break;

      case "stat_session":
        result = executeStatSession(
          args as unknown as StatSessionInput,
          workerPool,
          sessionStore,
          installManager,
          pythonWorker?.getStatus(),
        );
        break;

      case "stat_describe":
        result = await executeStatDescribe(
          args as unknown as StatDescribeInput,
          workerPool,
          sessionStore,
          pythonWorker,
        );
        break;

      case "stat_install":
        result = await executeStatInstall(
          args as unknown as StatInstallInput,
          installManager,
        );
        break;

      case "stat_method":
        result = await executeStatMethod(
          args as unknown as StatMethodInput,
          sessionStore,
          pythonWorker,
        );
        break;

      case "stat_extract":
        result = await executeStatExtract(
          args as unknown as StatExtractInput,
          workerPool,
          sessionStore,
          pythonWorker,
        );
        break;

      case "stat_plot":
        result = await executeStatPlot(
          args as unknown as StatPlotInput,
          workerPool,
          sessionStore,
        );
        break;

      default:
        result = errorResult(`Unknown tool: ${name}`);
    }

    if (result.isError) {
      recordToolFailure(sessionStore, name, args, result);
    }

    return result;
  });

  // Cleanup function
  const cleanup = async () => {
    searchEngine.close();
    await workerPool.stop();
    if (pythonWorker) await pythonWorker.stop();
  };

  return { server, cleanup };
}

// PII NOTE: failure history (visible via stat_session.recent_failures) retains
// the caller's `input`, including data values passed in `args`. Values are
// truncated/depth-limited by `compactForFailureHistory`, but if user data
// would be sensitive, do not pass it inline to stat_call — load it via
// stat_load_data and pass a handle id instead.
function recordToolFailure(
  sessionStore: SessionStore,
  toolName: string,
  input: unknown,
  result: StatToolResult,
): void {
  const payload = result[FAILURE_PAYLOAD];
  const message = payload?.message ?? "Tool call failed";
  const details = payload?.details ?? {};

  recordFailure(sessionStore, {
    tool: toolName,
    message,
    input: compactForFailureHistory(input),
    package: asOptionalString(details.package),
    functionName: asOptionalString(details.function),
    code: asOptionalCode(details.code),
    hint: compactForFailureHistory(details.hint),
    suggestion: compactForFailureHistory(details.suggestion),
    didYouMean: compactForFailureHistory(details.did_you_mean),
    retryHint: compactForFailureHistory(details.retry_hint),
  });
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalCode(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

const MAX_FAILURE_STRING_LENGTH = 500;
const MAX_FAILURE_ARRAY_ITEMS = 20;
const MAX_FAILURE_OBJECT_KEYS = 30;
const MAX_FAILURE_DEPTH = 4;

function compactForFailureHistory(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_FAILURE_STRING_LENGTH
      ? `${value.slice(0, MAX_FAILURE_STRING_LENGTH)}... [truncated ${value.length - MAX_FAILURE_STRING_LENGTH} chars]`
      : value;
  }
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_FAILURE_DEPTH) {
    return Array.isArray(value) ? `[array(${value.length})]` : "[object]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, MAX_FAILURE_ARRAY_ITEMS)
      .map((item) => compactForFailureHistory(item, depth + 1, seen));
    if (value.length > MAX_FAILURE_ARRAY_ITEMS) {
      compacted.push(`... ${value.length - MAX_FAILURE_ARRAY_ITEMS} more items`);
    }
    return compacted;
  }

  const entries = Object.entries(value).slice(0, MAX_FAILURE_OBJECT_KEYS);
  const compacted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    compacted[key] = compactForFailureHistory(entryValue, depth + 1, seen);
  }

  const remainingKeys = Object.keys(value).length - entries.length;
  if (remainingKeys > 0) {
    compacted._truncated_keys = remainingKeys;
  }

  return compacted;
}

export async function startServer(config: ServerConfig): Promise<void> {
  const { server, cleanup } = await createStatToolsServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });
}
