// ============================================================================
// StatTools — Session State Manager
// ============================================================================
// Tracks object handles and resolved functions. Immutable update pattern.

import {
  type SessionState,
  type ObjectHandle,
  type HandleType,
  type RuntimeType,
  type RpcObjectCreated,
  type FailureRecord,
  createSessionState,
  nextHandleId,
  getPersistenceClass,
  createStore,
  type Store,
} from "../types.js";

export type SessionStore = Store<SessionState>;

const MAX_RECENT_FAILURES = 10;

export function createSessionStore(sessionId: string): SessionStore {
  return createStore(createSessionState(sessionId));
}

/** Register a new object handle from a bridge response. */
export function registerHandle(
  store: SessionStore,
  created: RpcObjectCreated,
  workerId: string,
  createdBy: string,
  runtime: RuntimeType = "r",
): ObjectHandle {
  const state = store.getState();
  const persistenceClass = getPersistenceClass(created.rClass);

  const handle: ObjectHandle = {
    id: created.id,
    type: created.type as HandleType,
    runtime,
    rClass: created.rClass,
    persistenceClass,
    sessionId: state.sessionId,
    workerId,
    createdBy,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    sizeBytes: created.sizeBytes,
    summary: created.summary,
    schema: created.schema,
  };

  store.setState((prev) => ({
    ...prev,
    handles: new Map([...prev.handles, [handle.id, handle]]),
  }));

  return handle;
}

/** Mark a function as resolved (allows stat_call to execute it). */
export function markResolved(
  store: SessionStore,
  packageName: string,
  functionName: string,
): void {
  const key = `${packageName}::${functionName}`;
  store.setState((prev) => ({
    ...prev,
    resolvedFunctions: new Set([...prev.resolvedFunctions, key]),
  }));
}

/** Check if a function has been resolved in this session. */
export function isResolved(
  store: SessionStore,
  packageName: string,
  functionName: string,
): boolean {
  return store.getState().resolvedFunctions.has(`${packageName}::${functionName}`);
}

/** Update workerId on all surviving handles after recycle/restore. */
export function updateHandlesWorkerId(
  store: SessionStore,
  newWorkerId: string,
): void {
  store.setState((prev) => {
    const newHandles = new Map<string, ObjectHandle>();
    for (const [id, h] of prev.handles) {
      newHandles.set(id, { ...h, workerId: newWorkerId });
    }
    return { ...prev, handles: newHandles };
  });
}

/** Get all serializable handle IDs (for worker recycle persistence). */
export function getSerializableHandleIds(store: SessionStore): string[] {
  const handles = store.getState().handles;
  return [...handles.values()]
    .filter((h) => h.persistenceClass === "serializable")
    .map((h) => h.id);
}

/** Mark handles as lost (after crash or recycle failure). */
export function markHandlesLost(
  store: SessionStore,
  lostIds: string[],
): void {
  const lostSet = new Set(lostIds);
  store.setState((prev) => {
    const newHandles = new Map(prev.handles);
    for (const id of lostSet) {
      newHandles.delete(id);
    }
    return { ...prev, handles: newHandles };
  });
}

/** Record a structured tool failure for agent-loop recovery. */
export function recordFailure(
  store: SessionStore,
  failure: Omit<FailureRecord, "id" | "timestamp">,
): FailureRecord {
  const record: FailureRecord = {
    ...failure,
    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  store.setState((prev) => ({
    ...prev,
    recentFailures: [record, ...prev.recentFailures].slice(0, MAX_RECENT_FAILURES),
  }));

  return record;
}

/** Return recent tool failures newest-first. */
export function getRecentFailures(
  store: SessionStore,
): readonly FailureRecord[] {
  return store.getState().recentFailures;
}
