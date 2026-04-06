// ============================================================================
// StatTools — stat_load_data Tool
// ============================================================================
// Load CSV/TSV/RDS into session. Returns handle with schema + preview.
// Supports both R (default) and Python runtimes.
// Path policy: restricted to allowed roots (default: cwd only).

import { resolve as resolvePath, normalize } from "node:path";
import { realpathSync } from "node:fs";
import type { WorkerPool } from "../engine/workerPool.js";
import type { PythonWorker } from "../engine/PythonWorker.js";
import { type SessionStore, registerHandle } from "../engine/session.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";

export const STAT_LOAD_DATA_SCHEMA = {
  type: "object" as const,
  properties: {
    file_path: {
      type: "string",
      description: "Absolute or relative path to CSV, TSV, or RDS file",
    },
    name: {
      type: "string",
      description:
        "Optional name for the dataset handle (default: derived from filename)",
    },
    separator: {
      type: "string",
      description: "Column separator (default: auto-detect from extension)",
      enum: [",", "\t", "|", ";"],
    },
    runtime: {
      type: "string",
      description:
        "Runtime to load data into: 'r' (default) for R data.frame, 'python' for pandas DataFrame. Use 'python' when the data will be used with sklearn/statsmodels/pandas workflows.",
      enum: ["r", "python"],
    },
  },
  required: ["file_path"],
};

export type StatLoadDataInput = {
  file_path: string;
  name?: string;
  separator?: string;
  runtime?: "r" | "python";
};

export function resolveDataRoots(roots: string[]): string[] {
  return roots.map((r) => {
    try {
      return normalize(realpathSync(resolvePath(r)));
    } catch {
      return normalize(resolvePath(r));
    }
  });
}

function isPathAllowed(filePath: string, allowedRoots: string[]): boolean {
  // Ensure root paths end with separator to prevent prefix attacks:
  // "/tmp/safe" should NOT allow "/tmp/safe_evil/file.csv"
  const withSep = (p: string) => (p.endsWith("/") ? p : p + "/");

  try {
    const real = realpathSync(filePath);
    const normalized = normalize(real);
    return allowedRoots.some(
      (root) => normalized === root || normalized.startsWith(withSep(root)),
    );
  } catch {
    const normalized = normalize(resolvePath(filePath));
    return allowedRoots.some(
      (root) => normalized === root || normalized.startsWith(withSep(root)),
    );
  }
}

export async function executeStatLoadData(
  input: StatLoadDataInput,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  allowedRoots: string[],
  pythonWorker?: PythonWorker | null,
): Promise<StatToolResult> {
  const { file_path, name, separator, runtime = "r" } = input;

  // Path policy check
  const resolved = resolvePath(file_path);
  if (!isPathAllowed(resolved, allowedRoots)) {
    return errorResult(
      `Path '${file_path}' is outside allowed data roots. Allowed: ${allowedRoots.join(", ")}`,
      { allowed_roots: allowedRoots },
    );
  }

  const usePython = runtime === "python";

  if (usePython && !pythonWorker) {
    return errorResult(
      "Python runtime not available. Install python3 or use runtime='r'.",
    );
  }

  // Dispatch to the appropriate worker
  let response;
  try {
    if (usePython) {
      response = await pythonWorker!.call("load_data", {
        file_path: resolved,
        name: name || undefined,
        separator: separator || undefined,
      });
    } else {
      response = await workerPool.call("load_data", {
        file_path: resolved,
        name: name || undefined,
        separator: separator || undefined,
      });
    }
  } catch (err) {
    return errorResult(`Failed to load data: ${(err as Error).message}`);
  }

  if (response.error) {
    return errorResult(response.error.message, {
      suggestion: response.error.suggestion,
    });
  }

  // Register handles with correct runtime
  if (response.objectsCreated) {
    for (const obj of response.objectsCreated) {
      registerHandle(
        sessionStore,
        obj,
        usePython ? "python" : workerPool.getStatus().activeWorkerId!,
        "stat_load_data",
        usePython ? "python" : "r",
      );
    }
  }

  return successResult(response.result);
}
