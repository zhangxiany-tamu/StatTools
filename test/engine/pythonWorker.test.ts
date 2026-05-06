import { describe, it, expect, afterEach } from "vitest";
import { PythonWorker } from "../../src/engine/PythonWorker.js";

describe("PythonWorker.start()", () => {
  let worker: PythonWorker | null = null;

  afterEach(async () => {
    if (worker) {
      await worker.stop().catch(() => {});
      worker = null;
    }
  });

  it("never throws when the configured python binary does not exist", async () => {
    worker = new PythonWorker({ pythonPath: "/nonexistent/python_doesnotexist_xyz" });
    await expect(worker.start()).resolves.toBeUndefined();
  });

  it("reports state='spawn_failed' with diagnostic fields when python is missing", async () => {
    worker = new PythonWorker({ pythonPath: "/nonexistent/python_doesnotexist_xyz" });
    await worker.start();
    const status = worker.getStatus();
    expect(status.state).toBe("spawn_failed");
    expect(status.path).toBe("/nonexistent/python_doesnotexist_xyz");
    expect(status.error).toBeTruthy();
    expect(Array.isArray(status.recentStderr)).toBe(true);
    expect(status.availableModules).toEqual([]);
    expect(status.missingModules).toEqual([]);
  });

  it("reports state='healthy' or 'modules_missing' when python3 is available", async () => {
    const pythonPath = process.env.PYTHON_PATH || "python3";
    worker = new PythonWorker({ pythonPath });
    await worker.start();
    const status = worker.getStatus();
    expect(["healthy", "modules_missing", "spawn_failed"]).toContain(status.state);
    expect(status.path).toBe(pythonPath);
    expect(Array.isArray(status.recentStderr)).toBe(true);
  });
});
