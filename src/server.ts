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
import { createSessionStore, type SessionStore } from "./engine/session.js";

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

import { reindexPackage } from "./search/incrementalReindex.js";

import type { StatToolResult } from "./types.js";
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

  // Python worker (optional — starts if python3 is available)
  let pythonWorker: PythonWorker | null = null;
  try {
    pythonWorker = new PythonWorker({
      pythonPath: config.pythonPath || "python3",
    });
    await pythonWorker.start();
  } catch {
    console.error("[StatTools] Python worker not available — Python tools disabled");
    pythonWorker = null;
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
          "Execute a resolved R function with structured arguments. The function must have been validated via stat_resolve first. Returns structured JSON results (coefficients, p-values, etc.), not raw R console output.",
        inputSchema: STAT_CALL_SCHEMA,
      },
      {
        name: "stat_load_data",
        description:
          "Load a CSV, TSV, or RDS file into the session. Returns a handle ID (e.g. 'data_1') with column schema and preview. Default runtime is R; set runtime='python' to load as a pandas DataFrame for sklearn/statsmodels workflows.",
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

      default:
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                message: `Unknown tool: ${name}`,
              }),
            },
          ],
          isError: true,
        };
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
