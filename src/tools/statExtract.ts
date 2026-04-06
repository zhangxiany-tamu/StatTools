// ============================================================================
// StatTools — stat_extract Tool
// ============================================================================
// Extract columns from a data handle as vectors or matrices.
// Enables workflows like: load data → extract X matrix + y vector → fit glmnet.

import type { WorkerPool } from "../engine/workerPool.js";
import type { PythonWorker } from "../engine/PythonWorker.js";
import { type SessionStore, registerHandle } from "../engine/session.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";
import { logUsage, startTimer } from "../util/usageLogger.js";

export const STAT_EXTRACT_SCHEMA = {
  type: "object" as const,
  properties: {
    handle: {
      type: "string",
      description: "Handle ID of a data frame (e.g. 'data_1')",
    },
    columns: {
      type: "array",
      items: { type: "string" },
      description: "Column names to extract. Single column → vector, multiple columns → data frame or matrix.",
    },
    as_matrix: {
      type: "boolean",
      description: "If true, return a numeric matrix instead of a data frame. Required for glmnet, model.matrix-style APIs.",
    },
    assign_to: {
      type: "string",
      description: "Optional: name for the result handle (auto-generated if omitted).",
    },
  },
  required: ["handle", "columns"],
};

export type StatExtractInput = {
  handle: string;
  columns: string[];
  as_matrix?: boolean;
  assign_to?: string;
};

export async function executeStatExtract(
  input: StatExtractInput,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  pythonWorker?: PythonWorker | null,
): Promise<StatToolResult> {
  const { handle, columns, as_matrix, assign_to } = input;
  const elapsed = startTimer();

  // Validate handle exists
  const handleObj = sessionStore.getState().handles.get(handle);
  if (!handleObj) {
    return errorResult(`Handle '${handle}' not found.`, {
      available: [...sessionStore.getState().handles.keys()],
    });
  }

  const isPython = handleObj.runtime === "python";

  let response;
  try {
    if (isPython) {
      if (!pythonWorker) return errorResult("Python runtime not available.");
      response = await pythonWorker.call("select_columns", {
        object: handle,
        columns,
        assign_to: assign_to || null,
      });
    } else {
      response = await workerPool.call("extract_columns", {
        object: handle,
        columns,
        as_matrix: as_matrix || false,
        assign_to: assign_to || null,
      });
    }
  } catch (err) {
    return errorResult(`Extraction failed: ${(err as Error).message}`);
  }

  if (response.error) {
    return errorResult(response.error.message, {
      suggestion: response.error.suggestion,
    });
  }

  // Register created handles
  if (response.objectsCreated) {
    for (const obj of response.objectsCreated) {
      registerHandle(
        sessionStore,
        obj,
        isPython ? "python" : workerPool.getStatus().activeWorkerId!,
        `stat_extract:${handle}`,
        isPython ? "python" : "r",
      );
    }
  }

  logUsage({
    type: "call",
    timestamp: new Date().toISOString(),
    package: "stattools",
    function: "extract_columns",
    success: true,
    latency_ms: elapsed(),
  });

  return successResult(response.result);
}
