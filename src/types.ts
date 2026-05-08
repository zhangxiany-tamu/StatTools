// ============================================================================
// StatTools — Core Type Definitions
// ============================================================================

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes as cryptoRandomBytes } from "node:crypto";

// ----------------------------------------------------------------------------
// Object Handle System
// ----------------------------------------------------------------------------

export type HandleType =
  | "data"
  | "model"
  | "prediction"
  | "test_result"
  | "generic";

export type PersistenceClass =
  | "serializable"    // Safe for saveRDS/readRDS (data.frame, lm, htest, etc.)
  | "ephemeral"       // Lost on worker recycle (connections, external pointers)
  | "reconstructable"; // Phase 2: restore via stored call expression

/** Whitelist of R classes known to survive saveRDS/readRDS safely. */
export const SERIALIZABLE_R_CLASSES: ReadonlySet<string> = new Set([
  "data.frame",
  "tbl_df",
  "data.table",
  "matrix",
  "array",
  "list",
  "numeric",
  "integer",
  "character",
  "logical",
  "complex",
  "factor",
  "Date",
  "POSIXct",
  "POSIXlt",
  "lm",
  "glm",
  "nls",
  "htest",
  "anova",
  "aov",
  "summary.lm",
  "summary.glm",
  "lmerMod",
  "glmerMod",
  "coxph",
  "survfit",
  "survreg",
  "prcomp",
  "kmeans",
  "ts",
  "mts",
  "formula",
  "table",
  "ftable",
  "dendrogram",
  "dist",
  "density",
]);

export function getPersistenceClass(rClass: string): PersistenceClass {
  if (SERIALIZABLE_R_CLASSES.has(rClass)) {
    return "serializable";
  }
  return "ephemeral";
}

export type RuntimeType = "r" | "python";

export type ObjectHandle = {
  readonly id: string;
  readonly type: HandleType;
  readonly runtime: RuntimeType;
  readonly rClass: string;
  readonly persistenceClass: PersistenceClass;
  readonly sessionId: string;
  readonly workerId: string;
  readonly createdBy: string;
  readonly createdAt: number;
  lastAccessedAt: number;
  readonly sizeBytes: number;
  readonly summary: string;
  readonly schema?: Readonly<Record<string, string>>;
};

// ----------------------------------------------------------------------------
// R Bridge Protocol (NDJSON over stdin/stdout)
// ----------------------------------------------------------------------------

export type RpcRequest = {
  readonly id: number;
  readonly method:
    | "call"
    | "call_method"
    | "healthcheck"
    | "select_columns"
    | "extract_columns"
    | "render_plot"
    | "load_data"
    | "schema"
    | "inspect"
    | "persist"
    | "restore"
    | "list_objects";
  readonly params: Record<string, unknown>;
};

export type RpcResponse = {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly traceback?: string;
    readonly suggestion?: string;
  };
  readonly warnings?: readonly string[];
  readonly stdout?: readonly string[];
  readonly objectsCreated?: readonly RpcObjectCreated[];
  readonly persistFailed?: readonly string[];
};

export type RpcObjectCreated = {
  readonly id: string;
  readonly type: HandleType;
  readonly rClass: string;
  readonly summary: string;
  readonly sizeBytes: number;
  readonly schema?: Record<string, string>;
};

export type PythonRuntimeState =
  | "not_configured"   // Worker was never created (e.g. server explicitly disabled Python)
  | "starting"         // Worker created, start() not yet resolved
  | "spawn_failed"     // Process could not be launched (executable missing, permission denied, ...)
  | "modules_missing"  // Process running, healthcheck reported missing required modules
  | "crashed"          // Process was running but exited unexpectedly
  | "healthy";         // Process running and all required modules importable

export type PythonRuntimeStatus = {
  readonly state: PythonRuntimeState;
  readonly path: string;
  readonly pythonVersion?: string;
  readonly availableModules: readonly string[];
  readonly missingModules: readonly string[];
  readonly recentStderr: readonly string[];
  readonly error?: string;
};

export type FailureRecord = {
  readonly id: string;
  readonly timestamp: string;
  readonly tool: string;
  readonly message: string;
  readonly input?: unknown;
  readonly package?: string;
  readonly functionName?: string;
  readonly code?: string | number;
  readonly hint?: unknown;
  readonly suggestion?: unknown;
  readonly didYouMean?: unknown;
  readonly retryHint?: unknown;
};

// ----------------------------------------------------------------------------
// Session State (immutable updates)
// ----------------------------------------------------------------------------

export type SessionState = {
  readonly sessionId: string;
  readonly handles: ReadonlyMap<string, ObjectHandle>;
  readonly resolvedFunctions: ReadonlySet<string>; // "pkg::fn" keys
  readonly loadedPackages: ReadonlySet<string>;
  readonly nextId: Readonly<Record<HandleType, number>>;
  readonly recentFailures: readonly FailureRecord[];
};

export function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    handles: new Map(),
    resolvedFunctions: new Set(),
    loadedPackages: new Set(),
    nextId: { data: 0, model: 0, prediction: 0, test_result: 0, generic: 0 },
    recentFailures: [],
  };
}

export function nextHandleId(
  state: SessionState,
  type: HandleType,
): { id: string; nextId: Readonly<Record<HandleType, number>> } {
  const counter = state.nextId[type] + 1;
  const prefix =
    type === "test_result" ? "test" : type === "prediction" ? "pred" : type;
  return {
    id: `${prefix}_${counter}`,
    nextId: { ...state.nextId, [type]: counter },
  };
}

// ----------------------------------------------------------------------------
// R Worker
// ----------------------------------------------------------------------------

export type WorkerStatus = "idle" | "busy" | "recycling" | "dead";

export type RWorkerState = {
  readonly id: string;
  readonly status: WorkerStatus;
  readonly callCount: number;
  readonly startedAt: number;
  readonly sessionId: string;
  readonly loadedPackages: ReadonlySet<string>;
};

export type WorkerPoolConfig = {
  readonly maxWorkers: number;
  readonly recycleAfterCalls: number;
  readonly recycleAfterMemoryMB: number;
  readonly recycleAfterMinutes: number;
  readonly callTimeoutMs: number;
  readonly rPath: string;
};

export const DEFAULT_POOL_CONFIG: WorkerPoolConfig = {
  maxWorkers: 2, // 1 active + 1 standby
  recycleAfterCalls: 100,
  recycleAfterMemoryMB: 2048,
  recycleAfterMinutes: 60,
  callTimeoutMs: 30_000,
  rPath: "Rscript",
};

// ----------------------------------------------------------------------------
// Safety Classification
// ----------------------------------------------------------------------------

export type SafetyClass =
  | "safe"
  | "callable_with_caveats"
  | "unsafe"
  | "unclassified";

// ----------------------------------------------------------------------------
// Tool Result Envelope
// ----------------------------------------------------------------------------

/**
 * Symbol-keyed structured failure payload attached by `errorResult`.
 *
 * Symbol keys are invisible to `JSON.stringify`, so the MCP wire format
 * stays exactly `{ content, isError }` — but consumers inside the process
 * (e.g. the central failure recorder in server.ts) can read structured
 * failure details without re-parsing the JSON inside `content[0].text`.
 *
 * Treat this as the source of truth for tool failures. If you create an
 * error result by hand instead of using `errorResult`, attach this symbol
 * (or route through `errorResult`) so the failure is recorded faithfully.
 */
export const FAILURE_PAYLOAD: unique symbol = Symbol("stattools.failurePayload");

export type FailurePayload = {
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type StatToolResult = {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
  readonly [FAILURE_PAYLOAD]?: FailurePayload;
};

export function successResult(data: unknown): StatToolResult {
  const json = JSON.stringify(data, null, 2);

  // If result exceeds 100KB, persist to disk and return preview
  if (json.length > 100_000) {
    try {
      const dir = join(tmpdir(), "stattools", "results");
      mkdirSync(dir, { recursive: true });
      const filepath = join(dir, `result_${cryptoRandomBytes(6).toString("hex")}.json`);
      writeFileSync(filepath, json, "utf-8");

      const preview = json.slice(0, 2000);
      const sizeKB = (json.length / 1024).toFixed(1);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            _persisted: true,
            message: `Result too large (${sizeKB}KB). Full output saved to: ${filepath}`,
            preview_text: preview + "\n... (truncated)",
            original_size_kb: parseFloat(sizeKB),
            filepath,
          }, null, 2),
        }],
      };
    } catch {
      // Fallback: return full result even if persistence fails
    }
  }

  return {
    content: [{ type: "text", text: json }],
  };
}

export function errorResult(
  message: string,
  details?: Record<string, unknown>,
): StatToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: true, message, ...details }, null, 2),
      },
    ],
    isError: true,
    [FAILURE_PAYLOAD]: { message, details },
  };
}

// ----------------------------------------------------------------------------
// Reactive Store (from Claude Code's state/store.ts pattern)
// ----------------------------------------------------------------------------

export type Store<T> = {
  getState: () => T;
  setState: (updater: (prev: T) => T) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState: (updater: (prev: T) => T) => {
      const next = updater(state);
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
