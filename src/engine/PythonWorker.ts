// ============================================================================
// StatTools — Python Worker Subprocess Manager
// ============================================================================
// Same pattern as RWorker.ts but spawns python3 py/bridge.py.
// Reuses NdjsonCodec for NDJSON protocol.

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  PythonRuntimeState,
  PythonRuntimeStatus,
  RpcRequest,
  RpcResponse,
} from "../types.js";
import { NdjsonCodec, encodeNdjson } from "./protocol.js";

// Stderr ring buffer cap: keeps the last 50 lines or ~4KB, whichever comes
// first. Surfaced via getStatus().recentStderr so agents can see Python
// import warnings, traceback context, and crash output without spawning a
// debug session.
const MAX_STDERR_LINES = 50;
const MAX_STDERR_BYTES = 4096;

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

type PythonHealthcheckResult = {
  python_version?: string;
  available_modules?: string[];
  missing_modules?: string[];
  healthy?: boolean;
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
  private runtimeStatus: PythonRuntimeStatus;
  private stderrLines: string[] = [];
  private stderrPartial = "";
  private stderrBytes = 0;

  constructor(config?: Partial<PythonWorkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runtimeStatus = {
      state: "starting",
      path: this.config.pythonPath,
      availableModules: [],
      missingModules: [],
      recentStderr: [],
    };
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed && this._started;
  }

  getStatus(): PythonRuntimeStatus {
    return { ...this.runtimeStatus, recentStderr: [...this.stderrLines] };
  }

  // Push a chunk of stderr text into the ring buffer. Splits on newlines so
  // each entry is a single line, and trims oldest entries when MAX_STDERR_LINES
  // or MAX_STDERR_BYTES is exceeded.
  private appendStderr(chunk: string): void {
    this.stderrPartial += chunk;
    const parts = this.stderrPartial.split("\n");
    this.stderrPartial = parts.pop() ?? "";

    for (const line of parts) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.length === 0) continue;
      this.stderrLines.push(trimmed);
      this.stderrBytes += trimmed.length + 1;
      while (
        this.stderrLines.length > MAX_STDERR_LINES ||
        this.stderrBytes > MAX_STDERR_BYTES
      ) {
      const dropped = this.stderrLines.shift();
        if (dropped == null) break;
        this.stderrBytes -= dropped.length + 1;
      }
    }
  }

  // Always resolves. Outcome is reflected in getStatus().state:
  //   "spawn_failed"     — executable missing, permission denied, immediate exit
  //   "modules_missing"  — process up but required modules not all importable
  //   "healthy"          — process up, all modules importable
  // Callers should check state before issuing call().
  async start(): Promise<void> {
    if (this.proc) throw new Error("Python worker already started");

    return new Promise<void>((resolveStart) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolveStart();
      };

      let proc: ChildProcess;
      try {
        proc = spawn(this.config.pythonPath, ["-u", BRIDGE_SCRIPT], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
      } catch (err) {
        this.runtimeStatus = {
          state: "spawn_failed",
          path: this.config.pythonPath,
          availableModules: [],
          missingModules: [],
          recentStderr: [],
          error: `Failed to spawn Python: ${(err as Error).message}`,
        };
        finish();
        return;
      }

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
      proc.stderr!.on("data", (chunk: string) => {
        this.appendStderr(chunk);
      });

      proc.on("error", (err) => {
        if (!this._started) {
          this.runtimeStatus = {
            state: "spawn_failed",
            path: this.config.pythonPath,
            availableModules: [],
            missingModules: [],
            recentStderr: [...this.stderrLines],
            error: `Failed to spawn Python: ${err.message}`,
          };
          finish();
          return;
        }
        this.handleCrash(err);
      });

      proc.on("exit", (code, signal) => {
        if (!this._started) {
          this.runtimeStatus = {
            state: "spawn_failed",
            path: this.config.pythonPath,
            availableModules: [],
            missingModules: [],
            recentStderr: [...this.stderrLines],
            error: `Python exited during startup: code=${code}, signal=${signal}`,
          };
          finish();
          return;
        }
        if (this._intentionalStop) return;
        this.handleCrash(
          new Error(`Python exited unexpectedly: code=${code}, signal=${signal}`),
        );
      });

      // Python starts faster than R — shorter startup wait
      const startupTimer = setTimeout(() => {
        this._started = true;
        this.call("healthcheck", {})
          .then((response) => {
            const health = (response.result || {}) as PythonHealthcheckResult;
            const allModulesAvailable =
              response.error == null && health.healthy === true;
            this.runtimeStatus = {
              state: allModulesAvailable ? "healthy" : "modules_missing",
              path: this.config.pythonPath,
              pythonVersion: health.python_version,
              availableModules: health.available_modules || [],
              missingModules: health.missing_modules || [],
              recentStderr: [...this.stderrLines],
              error: response.error?.message,
            };
            finish();
          })
          .catch((err) => {
            this.runtimeStatus = {
              state: "modules_missing",
              path: this.config.pythonPath,
              availableModules: [],
              missingModules: [],
              recentStderr: [...this.stderrLines],
              error: `Healthcheck failed: ${(err as Error).message}`,
            };
            finish();
          });
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
    this.runtimeStatus = {
      state: "not_configured",
      path: this.config.pythonPath,
      availableModules: [],
      missingModules: [],
      recentStderr: [...this.stderrLines],
    };

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
    this.runtimeStatus = {
      state: "crashed",
      path: this.config.pythonPath,
      availableModules: [],
      missingModules: [],
      recentStderr: [...this.stderrLines],
      error: error.message,
    };
    this.config.onCrash?.(error);
  }
}
