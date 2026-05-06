// ============================================================================
// StatTools — stat_session Tool
// ============================================================================
// View session state: loaded handles, resolved functions, worker status.

import type { WorkerPool } from "../engine/workerPool.js";
import type { SessionStore } from "../engine/session.js";
import type { InstallManager } from "./statInstall.js";
import type { PythonRuntimeStatus } from "../types.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";

export const STAT_SESSION_SCHEMA = {
  type: "object" as const,
  properties: {
    handle: {
      type: "string",
      description:
        "Optional: inspect a specific handle in detail (e.g. 'data_1')",
    },
  },
  required: [],
};

export type StatSessionInput = {
  handle?: string;
};

export function executeStatSession(
  input: StatSessionInput,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  installManager?: InstallManager,
  pythonStatus?: PythonRuntimeStatus,
): StatToolResult {
  const state = sessionStore.getState();
  const poolStatus = workerPool.getStatus();

  if (input.handle) {
    // Detail view for a specific handle
    const handle = state.handles.get(input.handle);
    if (!handle) {
      const available = [...state.handles.keys()].join(", ") || "(none)";
      return errorResult(
        `Handle '${input.handle}' not found. Available: ${available}`,
      );
    }

    return successResult({
      handle: {
        id: handle.id,
        type: handle.type,
        runtime: handle.runtime,
        r_class: handle.rClass,
        persistence_class: handle.persistenceClass,
        created_by: handle.createdBy,
        created_at: new Date(handle.createdAt).toISOString(),
        size_bytes: handle.sizeBytes,
        summary: handle.summary,
        schema: handle.schema || null,
      },
    });
  }

  // Overview
  const handles = [...state.handles.values()].map((h) => ({
    id: h.id,
    type: h.type,
    runtime: h.runtime,
    r_class: h.rClass,
    persistence_class: h.persistenceClass,
    summary: h.summary,
  }));

  const resolvedFunctions = [...state.resolvedFunctions];

  // Install jobs
  const installJobs = installManager
    ? installManager.getAllJobs().map((j) => ({
        package: j.package,
        status: j.status,
        started_at: new Date(j.startedAt).toISOString(),
        completed_at: j.completedAt
          ? new Date(j.completedAt).toISOString()
          : null,
        error_summary: j.errorSummary || null,
        log_path: j.logPath || null,
      }))
    : [];

  return successResult({
    session_id: state.sessionId,
    handles: handles,
    handle_count: handles.length,
    resolved_functions: resolvedFunctions,
    resolved_count: resolvedFunctions.length,
    worker: {
      active_worker_id: poolStatus.activeWorkerId,
      call_count: poolStatus.activeCallCount,
      standby_ready: poolStatus.standbyReady,
    },
    python: pythonStatus || {
      state: "not_configured",
      path: process.env.PYTHON_PATH || "python3",
      availableModules: [],
      missingModules: [],
      recentStderr: [],
    },
    install_jobs: installJobs,
    install_jobs_count: installJobs.length,
  });
}
