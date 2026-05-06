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
      description: "Absolute or relative path to CSV, TSV, or RDS file. Required unless `dataset` is provided.",
    },
    dataset: {
      type: "string",
      description:
        "Built-in R dataset name (e.g. 'mtcars', 'iris', 'AirPassengers'). Loaded via R's data() and registered as a session handle. Mutually exclusive with file_path. R runtime only.",
    },
    package: {
      type: "string",
      description:
        "Optional package containing the dataset (default: 'datasets'). Use for datasets shipped by other packages: 'lme4' for sleepstudy/cbpp, 'survival' for lung, 'plm' for Grunfeld, 'ggplot2' for diamonds. Only used when `dataset` is set.",
    },
    name: {
      type: "string",
      description:
        "Optional name for the dataset handle (default: derived from filename or dataset name)",
    },
    separator: {
      type: "string",
      description: "Column separator (default: auto-detect from extension)",
      enum: [",", "\t", "|", ";"],
    },
    runtime: {
      type: "string",
      description:
        "Runtime to load data into: 'r' (default) for R data.frame, 'python' for pandas DataFrame. Use 'python' when the data will be used with sklearn/statsmodels/pandas workflows. The `dataset` field requires runtime='r'.",
      enum: ["r", "python"],
    },
  },
};

export type StatLoadDataInput = {
  file_path?: string;
  dataset?: string;
  package?: string;
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
  const { file_path, dataset, package: pkg, name, separator, runtime = "r" } = input;

  // Validate exactly one of file_path / dataset
  if (!file_path && !dataset) {
    return errorResult(
      "Provide either 'file_path' (CSV/TSV/RDS) or 'dataset' (built-in R dataset name).",
    );
  }
  if (file_path && dataset) {
    return errorResult(
      "Provide either 'file_path' or 'dataset', not both.",
    );
  }

  const usePython = runtime === "python";

  // Built-in dataset path: R-only, no path policy check needed
  if (dataset) {
    if (usePython) {
      return errorResult(
        "The `dataset` field is R-only. For Python, write the data to a CSV under an allowed data root and use `file_path` with runtime='python'.",
      );
    }
    let response;
    try {
      response = await workerPool.call("load_data", {
        dataset,
        package: pkg || undefined,
        name: name || undefined,
      });
    } catch (err) {
      return errorResult(`Failed to load dataset: ${(err as Error).message}`);
    }
    if (response.error) {
      return errorResult(response.error.message, {
        suggestion: response.error.suggestion,
      });
    }
    if (response.objectsCreated) {
      for (const obj of response.objectsCreated) {
        registerHandle(
          sessionStore,
          obj,
          workerPool.getStatus().activeWorkerId!,
          "stat_load_data:dataset",
          "r",
        );
      }
    }
    return successResult(response.result);
  }

  // File path: enforce path policy
  const resolved = resolvePath(file_path!);
  if (!isPathAllowed(resolved, allowedRoots)) {
    return errorResult(
      `Path '${file_path}' is outside allowed data roots. Allowed: ${allowedRoots.join(", ")}`,
      { allowed_roots: allowedRoots },
    );
  }

  if (usePython) {
    const pythonStatus = pythonWorker?.getStatus();
    if (!pythonWorker || !pythonStatus || pythonStatus.state !== "healthy") {
      return errorResult(
        "Python runtime not healthy. Use runtime='r' or fix the Python environment.",
        {
          python_state: pythonStatus?.state ?? "not_configured",
          python_path: pythonStatus?.path ?? null,
          missing_modules: pythonStatus?.missingModules ?? [],
          recent_stderr: pythonStatus?.recentStderr ?? [],
          runtime_error: pythonStatus?.error ?? null,
          hint:
            pythonStatus?.state === "modules_missing"
              ? `Install missing modules: pip install ${(pythonStatus.missingModules ?? []).join(" ")}, or use runtime='r'.`
              : pythonStatus?.state === "spawn_failed"
                ? `Set PYTHON_PATH to a working python3 binary, or use runtime='r'.`
                : `Configure PYTHON_PATH or use runtime='r'.`,
        },
      );
    }
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
