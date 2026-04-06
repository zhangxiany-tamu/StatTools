// ============================================================================
// StatTools — stat_describe Tool
// ============================================================================
// Inspect a session handle without full serialization.
// Actions: schema, sample, head, dimensions, profile.

import type { WorkerPool } from "../engine/workerPool.js";
import type { PythonWorker } from "../engine/PythonWorker.js";
import type { SessionStore } from "../engine/session.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";

export const STAT_DESCRIBE_SCHEMA = {
  type: "object" as const,
  properties: {
    handle: {
      type: "string",
      description: "Object handle to inspect (e.g. 'data_1', 'model_1')",
    },
    action: {
      type: "string",
      description: "What to show: 'schema' (columns+types), 'head' (first rows), 'dimensions', 'summary' (full summary stats), 'str' (R str output)",
      enum: ["schema", "head", "dimensions", "summary", "str"],
    },
  },
  required: ["handle"],
};

export type StatDescribeInput = {
  handle: string;
  action?: "schema" | "head" | "dimensions" | "summary" | "str";
};

export async function executeStatDescribe(
  input: StatDescribeInput,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  pythonWorker?: PythonWorker | null,
): Promise<StatToolResult> {
  const { handle, action = "summary" } = input;

  // Check handle exists in session
  const state = sessionStore.getState();
  const handleMeta = state.handles.get(handle);

  if (!handleMeta) {
    const available = [...state.handles.keys()].join(", ") || "(none)";
    return errorResult(
      `Handle '${handle}' not found. Available: ${available}`,
    );
  }

  // Route to correct worker based on handle runtime
  const isPython = handleMeta.runtime === "python";

  let response;
  try {
    if (isPython && pythonWorker) {
      response = await pythonWorker.call("inspect", {
        object: handle,
        action,
      });
    } else if (isPython) {
      return errorResult("Python runtime not available for this handle.");
    } else {
      response = await workerPool.call("inspect", {
        object: handle,
        action,
      });
    }
  } catch (err) {
    return errorResult(`Failed to describe '${handle}': ${(err as Error).message}`);
  }

  if (response.error) {
    return errorResult(response.error.message);
  }

  return successResult({
    handle: handle,
    action,
    type: handleMeta.type,
    r_class: handleMeta.rClass,
    result: response.result,
  });
}
