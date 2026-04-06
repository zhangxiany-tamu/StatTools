// ============================================================================
// StatTools — R Worker Pool (Broker)
// ============================================================================
// Manages 1 active + 1 standby worker. Handles:
// - Dispatch calls to active worker
// - Recycle on call count / memory / time limits
// - Crash recovery: promote standby → spawn new standby
// - Handle persistence: save serializable handles before recycle

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RpcResponse, WorkerPoolConfig } from "../types.js";
import { DEFAULT_POOL_CONFIG } from "../types.js";
import { RWorker } from "./RWorker.js";
import {
  type SessionStore,
  getSerializableHandleIds,
  markHandlesLost,
  updateHandlesWorkerId,
} from "./session.js";

function generateWorkerId(): string {
  return "w_" + randomBytes(4).toString("hex");
}

type ManagedWorker = {
  id: string;
  worker: RWorker;
  callCount: number;
  startedAt: number;
};

export class WorkerPool {
  private active: ManagedWorker | null = null;
  private standby: ManagedWorker | null = null;
  private config: WorkerPoolConfig;
  private sessionStore: SessionStore;
  private sessionDir: string;
  private recycling = false;

  constructor(sessionStore: SessionStore, config?: Partial<WorkerPoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.sessionStore = sessionStore;

    // Session persistence directory
    this.sessionDir = join(
      tmpdir(),
      "stattools",
      sessionStore.getState().sessionId,
    );
    mkdirSync(this.sessionDir, { recursive: true });
  }

  /** Start the pool: spawn active + standby workers. */
  async start(): Promise<void> {
    this.active = await this.spawnWorker();
    this.standby = await this.spawnWorker();
  }

  /** Send an RPC call to the active worker. */
  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<RpcResponse> {
    if (!this.active) {
      throw new Error("Worker pool not started");
    }

    // Check recycle triggers before dispatch
    if (this.shouldRecycle(this.active)) {
      await this.recycle();
    }

    if (!this.active) {
      throw new Error("No active worker available after recycle");
    }

    this.active.callCount++;

    try {
      return await this.active.worker.call(method, params);
    } catch (error) {
      // If call failed due to crash, try to recover
      if (!this.active.worker.isRunning) {
        await this.handleCrash();
        throw error; // Re-throw — caller should retry if appropriate
      }
      throw error;
    }
  }

  /** Gracefully stop all workers. */
  async stop(): Promise<void> {
    const stops: Promise<void>[] = [];
    if (this.active) {
      stops.push(this.active.worker.stop());
      this.active = null;
    }
    if (this.standby) {
      stops.push(this.standby.worker.stop());
      this.standby = null;
    }
    await Promise.all(stops);
  }

  /** Get pool status for stat_session. */
  getStatus(): {
    activeWorkerId: string | null;
    activeCallCount: number;
    standbyReady: boolean;
  } {
    return {
      activeWorkerId: this.active?.id ?? null,
      activeCallCount: this.active?.callCount ?? 0,
      standbyReady: this.standby?.worker.isRunning ?? false,
    };
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async spawnWorker(): Promise<ManagedWorker> {
    const id = generateWorkerId();
    const worker = new RWorker({
      rPath: this.config.rPath,
      timeoutMs: this.config.callTimeoutMs,
      onCrash: (err) => {
        console.error(`[WorkerPool] Worker ${id} crashed:`, err.message);
      },
    });

    await worker.start();

    return {
      id,
      worker,
      callCount: 0,
      startedAt: Date.now(),
    };
  }

  private shouldRecycle(w: ManagedWorker): boolean {
    if (this.recycling) return false;

    if (w.callCount >= this.config.recycleAfterCalls) return true;

    const uptimeMinutes = (Date.now() - w.startedAt) / 60_000;
    if (uptimeMinutes >= this.config.recycleAfterMinutes) return true;

    // Memory check would require querying R — skip for Phase 1
    return false;
  }

  private async recycle(): Promise<void> {
    if (this.recycling || !this.active) return;
    this.recycling = true;

    try {
      // 1. Persist serializable handles
      const serializableIds = getSerializableHandleIds(this.sessionStore);
      if (serializableIds.length > 0) {
        try {
          const resp = await this.active.worker.call("persist", {
            handles: serializableIds,
            session_dir: this.sessionDir,
          });
          // Mark any that failed to persist as lost
          if (resp.persistFailed && resp.persistFailed.length > 0) {
            markHandlesLost(this.sessionStore, [...resp.persistFailed]);
          }
        } catch {
          // Persist failed entirely — mark all as lost
          markHandlesLost(this.sessionStore, serializableIds);
        }
      }

      // 2. Stop active worker
      await this.active.worker.stop();

      // 3. Promote standby
      if (this.standby) {
        this.active = this.standby;
        this.standby = null;

        // 4. Restore handles in new active worker
        if (serializableIds.length > 0) {
          try {
            await this.active.worker.call("restore", {
              session_dir: this.sessionDir,
            });
          } catch {
            // Restore failed — handles are lost
            markHandlesLost(this.sessionStore, serializableIds);
          }
        }

        // 5. Update workerId on all surviving handles
        updateHandlesWorkerId(this.sessionStore, this.active.id);
      } else {
        // No standby — spawn a new active
        this.active = await this.spawnWorker();
      }

      // 5. Spawn new standby
      this.standby = await this.spawnWorker();

      // 6. Mark ephemeral handles as lost
      const allHandles = this.sessionStore.getState().handles;
      const ephemeralIds = [...allHandles.values()]
        .filter((h) => h.persistenceClass === "ephemeral")
        .map((h) => h.id);
      if (ephemeralIds.length > 0) {
        markHandlesLost(this.sessionStore, ephemeralIds);
      }
    } finally {
      this.recycling = false;
    }
  }

  private async handleCrash(): Promise<void> {
    // Active worker died unexpectedly
    this.active = null;

    // Promote standby
    if (this.standby) {
      this.active = this.standby;
      this.standby = null;

      // Try to restore persisted handles
      try {
        await this.active.worker.call("restore", {
          session_dir: this.sessionDir,
        });
      } catch {
        // Restore failed
      }

      // Update workerId on surviving handles
      updateHandlesWorkerId(this.sessionStore, this.active.id);

      // Mark all ephemeral handles as lost
      const allHandles = this.sessionStore.getState().handles;
      const ephemeralIds = [...allHandles.values()]
        .filter((h) => h.persistenceClass === "ephemeral")
        .map((h) => h.id);
      markHandlesLost(this.sessionStore, ephemeralIds);

      // Spawn new standby
      try {
        this.standby = await this.spawnWorker();
      } catch {
        // Can't spawn standby — continue with just active
      }
    } else {
      // No standby either — spawn fresh
      try {
        this.active = await this.spawnWorker();
      } catch (e) {
        throw new Error(
          `Cannot recover: failed to spawn R worker: ${(e as Error).message}`,
        );
      }
    }
  }
}
