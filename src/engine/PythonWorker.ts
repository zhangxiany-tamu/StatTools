// ============================================================================
// StatTools — Python Worker Subprocess Manager
// ============================================================================
// Same pattern as RWorker.ts but spawns python3 py/bridge.py.
// Reuses NdjsonCodec for NDJSON protocol.

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RpcRequest, RpcResponse } from "../types.js";
import { NdjsonCodec, encodeNdjson } from "./protocol.js";

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = findProjectRoot(__dirname);
const BRIDGE_SCRIPT = resolve(PROJECT_ROOT, "py", "bridge.py");

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PythonWorkerConfig = {
  pythonPath: string;
  timeoutMs: number;
  onCrash?: (error: Error) => void;
};

const DEFAULT_CONFIG: PythonWorkerConfig = {
  pythonPath: "python3",
  timeoutMs: 30_000,
};

export class PythonWorker {
  private proc: ChildProcess | null = null;
  private codec: NdjsonCodec | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private config: PythonWorkerConfig;
  private _started = false;
  private _intentionalStop = false;

  constructor(config?: Partial<PythonWorkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed && this._started;
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error("Python worker already started");

    return new Promise<void>((resolveStart, rejectStart) => {
      const proc = spawn(this.config.pythonPath, ["-u", BRIDGE_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
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
        },
        (error) => {
          console.error("[PythonWorker] NDJSON parse error:", error.message);
        },
      );

      this.codec = codec;

      proc.stdout!.setEncoding("utf-8");
      proc.stdout!.on("data", (chunk: string) => {
        codec.feed(chunk);
      });

      proc.stderr!.setEncoding("utf-8");
      proc.stderr!.on("data", (_chunk: string) => {
        // Python stderr (warnings, import messages) — ignore
      });

      proc.on("error", (err) => {
        if (!this._started) {
          rejectStart(new Error(`Failed to spawn Python: ${err.message}`));
        }
        this.handleCrash(err);
      });

      proc.on("exit", (code, signal) => {
        if (!this._started) {
          rejectStart(new Error(`Python exited during startup: code=${code}`));
          return;
        }
        if (this._intentionalStop) return;
        this.handleCrash(new Error(`Python exited unexpectedly: code=${code}, signal=${signal}`));
      });

      // Python starts faster than R — shorter startup wait
      const startupTimer = setTimeout(() => {
        this._started = true;
        resolveStart();
      }, 300);

      proc.on("exit", () => clearTimeout(startupTimer));
    });
  }

  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<RpcResponse> {
    if (!this.proc || !this.codec) throw new Error("Python worker not started");

    const id = ++this.requestId;
    const request: RpcRequest = { id, method: method as RpcRequest["method"], params };

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Python call timed out after ${this.config.timeoutMs}ms: ${method}`));
      }, this.config.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(encodeNdjson(request as unknown as Record<string, unknown>));
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this._intentionalStop = true;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Python worker stopped"));
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
      }, 3000);

      proc.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      proc.stdin?.end();
    });
  }

  private handleCrash(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Python worker crashed: ${error.message}`));
      this.pending.delete(id);
    }

    this.proc = null;
    this.codec?.reset();
    this.codec = null;
    this._started = false;
    this.config.onCrash?.(error);
  }
}
