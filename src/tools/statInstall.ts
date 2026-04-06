// ============================================================================
// StatTools — stat_install Tool
// ============================================================================
// Async package installation. Runs install.packages() in a separate R call.
// Returns immediately with job status. Agent checks progress via stat_session.
// Reports host-observed install_status + raw build log on failure.
// No guessed system dependency names.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { successResult, errorResult, type StatToolResult } from "../types.js";
import { logUsage } from "../util/usageLogger.js";

type InstallJob = {
  package: string;
  status: "installing" | "installed" | "failed";
  startedAt: number;
  completedAt?: number;
  errorSummary?: string;
  logPath?: string;
};

// Per-server install state (not global — created per server instance)
export class InstallManager {
  private jobs = new Map<string, InstallJob>();
  private logDir: string;
  private rPath: string;

  /** Called after a successful install with the package name. */
  onInstallComplete?: (packageName: string) => void;

  constructor(rPath: string = "Rscript") {
    this.logDir = join(tmpdir(), "stattools", "install-logs");
    mkdirSync(this.logDir, { recursive: true });
    this.rPath = rPath;
  }

  /** Check if a package is already installed on the host via Rscript. */
  private isInstalledOnHost(packageName: string): boolean {
    try {
      const result = execFileSync(
        this.rPath,
        ["--vanilla", "-e", `cat(requireNamespace("${packageName.replace(/"/g, '\\"')}", quietly=TRUE))`],
        { encoding: "utf-8", timeout: 5000 },
      );
      return result.trim() === "TRUE";
    } catch {
      return false;
    }
  }

  getJob(packageName: string): InstallJob | undefined {
    return this.jobs.get(packageName);
  }

  getAllJobs(): InstallJob[] {
    return [...this.jobs.values()];
  }

  async install(packageName: string): Promise<InstallJob> {
    // Check if already installing or installed in this session
    const existing = this.jobs.get(packageName);
    if (existing) {
      if (existing.status === "installing") {
        return existing;
      }
      if (existing.status === "installed") {
        return existing;
      }
      // Failed — allow retry
    }

    // Check if already installed on the host (avoid redundant installs)
    if (this.isInstalledOnHost(packageName)) {
      const job: InstallJob = {
        package: packageName,
        status: "installed",
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
      this.jobs.set(packageName, job);
      // Trigger reindex so "installed but stubbed" packages become searchable
      try {
        this.onInstallComplete?.(packageName);
      } catch {
        // Reindex failure should not affect install status
      }
      return job;
    }

    const logPath = join(this.logDir, `${packageName}.log`);
    const job: InstallJob = {
      package: packageName,
      status: "installing",
      startedAt: Date.now(),
      logPath,
    };
    this.jobs.set(packageName, job);

    // Run installation in background (non-blocking)
    this.runInstall(packageName, logPath, job);

    return job;
  }

  private runInstall(
    packageName: string,
    logPath: string,
    job: InstallJob,
  ): void {
    const rCode = `
      tryCatch({
        install.packages("${packageName.replace(/"/g, '\\"')}",
          repos = "https://cloud.r-project.org",
          quiet = FALSE)
        if (requireNamespace("${packageName.replace(/"/g, '\\"')}", quietly = TRUE)) {
          cat("\\nINSTALL_SUCCESS\\n")
        } else {
          cat("\\nINSTALL_FAILED\\n")
        }
      }, error = function(e) {
        cat(paste0("\\nINSTALL_ERROR: ", conditionMessage(e), "\\n"))
      })
    `;

    const proc = spawn(this.rPath, ["--vanilla", "-e", rCode], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errOutput = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      errOutput += chunk.toString();
    });

    proc.on("exit", (code) => {
      const fullLog = output + "\n---STDERR---\n" + errOutput;

      // Write log (writeFileSync imported at module level — works in ESM)
      try {
        writeFileSync(logPath, fullLog);
      } catch {
        // Ignore log write failures
      }

      if (output.includes("INSTALL_SUCCESS")) {
        job.status = "installed";
        job.completedAt = Date.now();
        // Trigger incremental reindex so the package is immediately searchable
        try {
          this.onInstallComplete?.(packageName);
        } catch {
          // Reindex failure should not affect install status
        }
      } else {
        job.status = "failed";
        job.completedAt = Date.now();
        // Extract error summary (first meaningful error line)
        const errorMatch = output.match(/INSTALL_ERROR: (.+)/);
        const configError = errOutput.match(/configuration failed.*/);
        const compileError = errOutput.match(/ERROR: compilation failed.*/);
        job.errorSummary =
          errorMatch?.[1] ||
          configError?.[0] ||
          compileError?.[0] ||
          `Exit code ${code}`;
        job.logPath = logPath;
      }
    });
  }
}

export const STAT_INSTALL_SCHEMA = {
  type: "object" as const,
  properties: {
    package: {
      type: "string",
      description: "CRAN package name to install (e.g. 'randomForest', 'brms')",
    },
  },
  required: ["package"],
};

export type StatInstallInput = {
  package: string;
};

export async function executeStatInstall(
  input: StatInstallInput,
  installManager: InstallManager,
): Promise<StatToolResult> {
  const { package: pkg } = input;

  if (!pkg || pkg.trim().length === 0) {
    return errorResult("Package name cannot be empty.");
  }

  // Sanitize: only allow alphanumeric, dots, underscores (valid R package names)
  if (!/^[a-zA-Z][a-zA-Z0-9._]*$/.test(pkg)) {
    return errorResult(
      `Invalid package name '${pkg}'. R package names must start with a letter and contain only letters, digits, dots, and underscores.`,
    );
  }

  // Check existing job
  const existing = installManager.getJob(pkg);
  if (existing?.status === "installing") {
    return successResult({
      package: pkg,
      status: "installing",
      message: `Package '${pkg}' is already being installed. Check stat_session for progress.`,
      started_at: new Date(existing.startedAt).toISOString(),
    });
  }

  if (existing?.status === "installed") {
    return successResult({
      package: pkg,
      status: "already_installed",
      message: `Package '${pkg}' is already installed.`,
    });
  }

  // Start async install (checks host first, then installs if needed)
  const job = await installManager.install(pkg);

  if (job.status === "installed" && !existing) {
    // Was already on host — detected by isInstalledOnHost check
    return successResult({
      package: pkg,
      status: "already_installed",
      message: `Package '${pkg}' is already installed on this system.`,
    });
  }

  logUsage({
    type: "install",
    timestamp: new Date().toISOString(),
    package: pkg,
    success: true,
    latency_ms: 0,
  });

  return successResult({
    package: pkg,
    status: "installing",
    message: `Installation of '${pkg}' started in the background.`,
    check_progress: "Use stat_session to check install_jobs for completion status.",
    note: "After installation completes, the package will be automatically indexed and immediately searchable via stat_search.",
  });
}
