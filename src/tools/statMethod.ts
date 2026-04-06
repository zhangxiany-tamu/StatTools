// ============================================================================
// StatTools — stat_method Tool
// ============================================================================
// Call a method on a Python session object (e.g., model.fit(X, y)).
// Bridges the gap between constructor calls (stat_call) and method
// invocations needed for sklearn/statsmodels workflows.

import type { PythonWorker } from "../engine/PythonWorker.js";
import {
  type SessionStore,
  registerHandle,
} from "../engine/session.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";

export const STAT_METHOD_SCHEMA = {
  type: "object" as const,
  properties: {
    object: {
      type: "string",
      description:
        "Handle ID of a session object (e.g. 'model_1'). Must be a Python object created by stat_call or stat_load_data.",
    },
    method: {
      type: "string",
      description:
        "Method name to call on the object (e.g. 'fit', 'predict', 'score', 'transform').",
    },
    args: {
      type: "object",
      description:
        "Keyword arguments as JSON. Session handle IDs (e.g. 'data_1') are resolved automatically.",
      additionalProperties: true,
    },
    positional_args: {
      type: "array",
      items: {},
      description:
        "Positional arguments (in order). Accepts any JSON value: strings (handle IDs resolved automatically), numbers, booleans, arrays, objects. Use for methods like fit(X, y) where argument order matters.",
    },
    assign_to: {
      type: "string",
      description:
        "Optional: name for the result handle. Ignored if the method returns self (e.g. fit() returns the fitted model in-place).",
    },
  },
  required: ["object", "method"],
};

export type StatMethodInput = {
  object: string;
  method: string;
  args?: Record<string, unknown>;
  positional_args?: unknown[];
  assign_to?: string;
};

export async function executeStatMethod(
  input: StatMethodInput,
  sessionStore: SessionStore,
  pythonWorker?: PythonWorker | null,
): Promise<StatToolResult> {
  const { object: objId, method, args, positional_args, assign_to } = input;

  // 1. Python worker must be available
  if (!pythonWorker) {
    return errorResult(
      "Python runtime not available. stat_method only works with Python objects.",
    );
  }

  // 2. Validate handle exists in session
  const handle = sessionStore.getState().handles.get(objId);
  if (!handle) {
    const available = [...sessionStore.getState().handles.keys()];
    return errorResult(
      `Object '${objId}' not found in session.`,
      {
        available_handles: available.length > 0 ? available : "(none)",
        hint: "Use stat_session to view all handles.",
      },
    );
  }

  // 3. Validate it's a Python handle
  if (handle.runtime !== "python") {
    return errorResult(
      `Object '${objId}' is an R object (${handle.rClass}). stat_method only works with Python objects.`,
      {
        hint: "For R objects, use stat_call with the appropriate R function.",
      },
    );
  }

  // 4. Dispatch to Python bridge
  let response;
  try {
    response = await pythonWorker.call("call_method", {
      object: objId,
      method,
      args: args || {},
      positional_args: positional_args || [],
      assign_to: assign_to || null,
    });
  } catch (err) {
    return errorResult(
      `Python method call failed: ${(err as Error).message}`,
      { object: objId, method },
    );
  }

  // 5. Handle errors from bridge
  if (response.error) {
    return errorResult(response.error.message, {
      object: objId,
      method,
      code: response.error.code,
      suggestion: response.error.suggestion,
      traceback: response.error.traceback,
    });
  }

  // 6. Register any new handles created
  if (response.objectsCreated) {
    for (const obj of response.objectsCreated) {
      registerHandle(
        sessionStore,
        obj,
        "python",
        `stat_method:${objId}.${method}`,
        "python",
      );
    }
  }

  // 7. Build result
  const result: Record<string, unknown> = {
    result: response.result,
  };

  if (response.warnings && response.warnings.length > 0) {
    result.warnings = response.warnings;
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
