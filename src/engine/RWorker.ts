// ============================================================================
// StatTools — Single R Worker Subprocess Manager
// ============================================================================
// Spawns and manages a single R bridge.R process. Handles:
// - Spawn with correct script path
// - Send/receive via NDJSON protocol
// - Request timeout
// - Crash detection and cleanup
// - Stall detection (R prompts for input)

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcRequest, RpcResponse } from "../types.js";
import { NdjsonCodec, encodeNdjson } from "./protocol.js";

// Resolve bridge.R path.
// After tsc, this file lives at dist/src/engine/RWorker.js, so ../../r/bridge.R
// would resolve to dist/r/bridge.R which doesn't exist. Instead, walk up from
// the compiled file until we find package.json (project root), then resolve r/.
import { existsSync } from "node:fs";

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd(); // Final fallback
}

function findBridgeScript(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const root = findProjectRoot(thisDir);
  return resolve(root, "r", "bridge.R");
}

const BRIDGE_SCRIPT = findBridgeScript();

// Stall patterns: R is waiting for interactive input
const STALL_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /Continue\?/i,
  /Update all\/some\/none\?/i,
  /Selection:/i,
  /Enter an item from the menu/i,
];

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RWorkerConfig = {
  rPath: string;
  timeoutMs: number;
  onCrash?: (error: Error) => void;
  onStall?: (lastOutput: string) => void;
};

const DEFAULT_CONFIG: RWorkerConfig = {
  rPath: "Rscript",
  timeoutMs: 30_000,
};

export class RWorker {
  private proc: ChildProcess | null = null;
  private codec: NdjsonCodec | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private config: RWorkerConfig;
  private lastStdout = "";
  private stderrBuffer = "";
  private _started = false;
  private _intentionalStop = false;

  constructor(config?: Partial<RWorkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed && this._started;
  }

  async start(): Promise<void> {
    if (this.proc) {
      throw new Error("Worker already started");
    }

    return new Promise<void>((resolveStart, rejectStart) => {
      const bridgeDir = resolve(BRIDGE_SCRIPT, "..");
      const proc = spawn(this.config.rPath, ["--vanilla", BRIDGE_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          R_DEFAULT_PACKAGES: "base,stats,utils,methods",
          STATTOOLS_BRIDGE_DIR: bridgeDir,
        },
      });

      this.proc = proc;

      const codec = new NdjsonCodec(
        (response) => {
          const pending = this.pending.get(response.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            pending.resolve(response);
          }
          // Ignore responses without matching pending (e.g., ready signal)
        },
        (error) => {
          // Parse error — log but don't crash
          console.error("[RWorker] NDJSON parse error:", error.message);
        },
      );

      this.codec = codec;

      proc.stdout!.setEncoding("utf-8");
      proc.stdout!.on("data", (chunk: string) => {
        this.lastStdout = chunk;
        codec.feed(chunk);
      });

      proc.stderr!.setEncoding("utf-8");
      proc.stderr!.on("data", (chunk: string) => {
        this.stderrBuffer += chunk;
        // Check for stall patterns
        for (const pattern of STALL_PATTERNS) {
          if (pattern.test(chunk)) {
            this.config.onStall?.(chunk);
          }
        }
      });

      proc.on("error", (err) => {
        if (!this._started) {
          rejectStart(new Error(`Failed to spawn R process: ${err.message}`));
        }
        this.handleCrash(err);
      });

      proc.on("exit", (code, signal) => {
        if (!this._started) {
          rejectStart(
            new Error(
              `R process exited during startup: code=${code}, signal=${signal}`,
            ),
          );
          return;
        }
        // Don't treat intentional stop() as a crash
        if (this._intentionalStop) return;
        this.handleCrash(
          new Error(
            `R process exited unexpectedly: code=${code}, signal=${signal}. stderr: ${this.stderrBuffer.slice(-500)}`,
          ),
        );
      });

      // Give R a moment to start, then mark as ready
      // The bridge doesn't send a ready signal anymore, so we just wait briefly
      const startupTimer = setTimeout(() => {
        this._started = true;
        resolveStart();
      }, 500);

      // If process dies before startup timeout, the exit handler rejects
      proc.on("exit", () => clearTimeout(startupTimer));
    });
  }

  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<RpcResponse> {
    if (!this.proc || !this.codec) {
      throw new Error("Worker not started");
    }

    const id = ++this.requestId;
    const request: RpcRequest = { id, method: method as RpcRequest["method"], params };

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `R call timed out after ${this.config.timeoutMs}ms: ${method}`,
          ),
        );
      }, this.config.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const encoded = encodeNdjson(request as unknown as Record<string, unknown>);
      const ok = this.proc!.stdin!.write(encoded);
      if (!ok) {
        // Backpressure — wait for drain
        this.proc!.stdin!.once("drain", () => {
          // Already written, just noting
        });
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;

    // Mark as intentional so the exit handler doesn't call handleCrash
    this._intentionalStop = true;

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Worker stopped"));
      this.pending.delete(id);
    }

    const proc = this.proc;
    this.proc = null;
    this.codec?.reset();
    this.codec = null;
    this._started = false;

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);

      proc.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      // Close stdin to signal EOF → bridge.R exits cleanly
      proc.stdin?.end();
    });
  }

  private handleCrash(error: Error): void {
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`R worker crashed: ${error.message}`),
      );
      this.pending.delete(id);
    }

    this.proc = null;
    this.codec?.reset();
    this.codec = null;
    this._started = false;

    this.config.onCrash?.(error);
  }
}
