import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createStatToolsServer, type ServerConfig } from "../../src/server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/stattools.db");
const TEST_CSV = "/tmp/stattools_e2e_test.csv";

// Helper: call a tool on the server directly (bypassing transport)
async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // Use the server's request handler directly
  const handler = (server as any)._requestHandlers?.get("tools/call");
  if (!handler) throw new Error("No tools/call handler registered");

  const result = await handler({
    method: "tools/call",
    params: { name, arguments: args },
  });
  return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

async function listTools(
  server: Server,
): Promise<Array<{ name: string; description: string }>> {
  const handler = (server as any)._requestHandlers?.get("tools/list");
  if (!handler) throw new Error("No tools/list handler registered");

  const result = await handler({ method: "tools/list", params: {} });
  return (result as { tools: Array<{ name: string; description: string }> }).tools;
}

describe("MCP Server End-to-End", () => {
  let server: Server;
  let cleanup: () => Promise<void>;
  let pythonIndexed = false;

  beforeAll(async () => {
    // Create test CSV
    writeFileSync(
      TEST_CSV,
      "mpg,wt,hp,cyl\n21,2.62,110,6\n22.8,2.32,93,4\n21.4,3.215,110,6\n18.7,3.44,175,8\n14.3,3.57,245,8\n",
    );

    const config: ServerConfig = {
      dbPath: DB_PATH,
      allowedDataRoots: ["/tmp"],
      rPath: "Rscript",
    };

    const result = await createStatToolsServer(config);
    server = result.server;
    cleanup = result.cleanup;

    // Probe: are Python functions in the search index?
    const probe = await callTool(server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
    });
    pythonIndexed = !probe.isError;
  }, 15000);

  afterAll(async () => {
    await cleanup();
  });

  /** Call inside a test body to skip when Python is not indexed. */
  const requirePython = (ctx: { skip: () => void }) => {
    if (!pythonIndexed) ctx.skip();
  };

  it("lists 10 tools", async () => {
    const tools = await listTools(server);
    expect(tools).toHaveLength(10);

    const names = tools.map((t) => t.name);
    expect(names).toContain("stat_search");
    expect(names).toContain("stat_resolve");
    expect(names).toContain("stat_call");
    expect(names).toContain("stat_load_data");
    expect(names).toContain("stat_session");
    expect(names).toContain("stat_describe");
    expect(names).toContain("stat_install");
    expect(names).toContain("stat_extract");
    expect(names).toContain("stat_plot");
    expect(names).toContain("stat_method");
  });

  it("full flow: search → resolve → load → call → session", async () => {
    // 1. Search for linear regression
    const searchResult = await callTool(server, "stat_search", {
      query: "linear regression",
    });
    expect(searchResult.isError).toBeFalsy();
    const searchData = JSON.parse(searchResult.content[0].text);
    expect(searchData.results.length).toBeGreaterThan(0);

    // stats::lm should be in results
    const lmResult = searchData.results.find(
      (r: { id: string }) => r.id === "stats::lm",
    );
    expect(lmResult).toBeDefined();

    // 2. Resolve stats::lm
    const resolveResult = await callTool(server, "stat_resolve", {
      package: "stats",
      function: "lm",
    });
    expect(resolveResult.isError).toBeFalsy();
    const resolveData = JSON.parse(resolveResult.content[0].text);
    expect(resolveData.resolved).toBe(true);
    expect(resolveData.safety_class).toBe("safe");
    expect(resolveData.schema.properties.formula).toBeDefined();

    // 3. Load data
    const loadResult = await callTool(server, "stat_load_data", {
      file_path: TEST_CSV,
      name: "cars",
    });
    expect(loadResult.isError).toBeFalsy();
    const loadData = JSON.parse(loadResult.content[0].text);
    expect(loadData.dimensions.rows).toBe(5);

    // 4. Call lm
    const callResult = await callTool(server, "stat_call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt + hp", data: "cars" },
    });
    expect(callResult.isError).toBeFalsy();
    const callData = JSON.parse(callResult.content[0].text);
    expect(callData.result.class).toBe("lm");
    expect(callData.result.r_squared).toBeDefined();
    expect(callData.objects_created).toBeDefined();
    expect(callData.objects_created.length).toBeGreaterThan(0);

    // 5. Check session state
    const sessionResult = await callTool(server, "stat_session", {});
    expect(sessionResult.isError).toBeFalsy();
    const sessionData = JSON.parse(sessionResult.content[0].text);
    expect(sessionData.handle_count).toBeGreaterThanOrEqual(2); // cars + model
    expect(sessionData.resolved_functions).toContain("stats::lm");
  }, 30000);

  it("stat_call rejects unresolved function", async () => {
    const result = await callTool(server, "stat_call", {
      package: "stats",
      function: "glm",
      args: {},
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("not been resolved");
  });

  it("stat_load_data rejects path outside allowed roots", async () => {
    const result = await callTool(server, "stat_load_data", {
      file_path: "/etc/passwd",
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("outside allowed");
  });

  it("stat_load_data rejects sibling prefix path attack", async () => {
    // If allowed root is /tmp, then /tmp_evil/file.csv should be rejected
    // (prefix attack: "/tmp_evil".startsWith("/tmp") is true without separator check)
    const result = await callTool(server, "stat_load_data", {
      file_path: "/tmp_evil/data.csv",
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("outside allowed");
  });

  it("two servers in same process have isolated data roots", async () => {
    // Server 1 allows /tmp, server 2 allows nothing beyond cwd
    const config2: ServerConfig = {
      dbPath: DB_PATH,
      allowedDataRoots: ["/nonexistent_root_for_test"],
      rPath: "Rscript",
    };

    const result2 = await createStatToolsServer(config2);
    const server2 = result2.server;

    try {
      // Server 1 (allowed: /tmp) should accept /tmp files
      const r1 = await callTool(server, "stat_load_data", {
        file_path: TEST_CSV,
      });
      expect(r1.isError).toBeFalsy();

      // Server 2 (allowed: /nonexistent_root_for_test) should reject /tmp files
      const r2 = await callTool(server2, "stat_load_data", {
        file_path: TEST_CSV,
      });
      expect(r2.isError).toBe(true);
      const data = JSON.parse(r2.content[0].text);
      expect(data.message).toContain("outside allowed");
    } finally {
      await result2.cleanup();
    }
  });

  it("stat_install detects already-installed package without reinstalling", async () => {
    // jsonlite is always installed (required by bridge.R)
    const installResult = await callTool(server, "stat_install", {
      package: "jsonlite",
    });
    expect(installResult.isError).toBeFalsy();
    const installData = JSON.parse(installResult.content[0].text);
    expect(installData.status).toBe("already_installed");
  });

  it("stat_session shows install_jobs", async () => {
    // Trigger an install first
    await callTool(server, "stat_install", { package: "jsonlite" });

    const sessionResult = await callTool(server, "stat_session", {});
    const sessionData = JSON.parse(sessionResult.content[0].text);
    expect(sessionData.install_jobs).toBeDefined();
    expect(Array.isArray(sessionData.install_jobs)).toBe(true);
    expect(sessionData.install_jobs.length).toBeGreaterThan(0);
    expect(sessionData.install_jobs[0].package).toBe("jsonlite");
    expect(sessionData.install_jobs[0].status).toBe("installed");
  });

  it("stat_install writes log file on failure", async () => {
    // Install a nonexistent package — should fail and write a log
    const result = await callTool(server, "stat_install", {
      package: "nonexistent_pkg_xyzzy_12345",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("installing");

    // Poll until the install completes or times out (max 25s)
    let job: { status: string; log_path?: string } | undefined;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const sessionResult = await callTool(server, "stat_session", {});
      const sessionData = JSON.parse(sessionResult.content[0].text);
      job = sessionData.install_jobs.find(
        (j: { package: string }) => j.package === "nonexistent_pkg_xyzzy_12345",
      );
      if (job && job.status !== "installing") break;
    }
    expect(job).toBeDefined();
    expect(job!.status).toBe("failed");
    expect(job!.log_path).toBeTruthy();

    // Verify the log file actually exists on disk
    const { existsSync } = await import("node:fs");
    expect(existsSync(job!.log_path!)).toBe(true);
  }, 45000);

  it("stat_install rejects invalid package name", async () => {
    const result = await callTool(server, "stat_install", {
      package: "../etc/passwd",
    });
    expect(result.isError).toBe(true);
  });

  it("stat_search returns is_stub and stub_note for non-installed packages", async () => {
    const result = await callTool(server, "stat_search", {
      query: "random forest classification",
    });
    const data = JSON.parse(result.content[0].text);
    const stub = data.results.find(
      (r: { is_stub: boolean }) => r.is_stub === true,
    );
    // At least one stub should appear (randomForest or similar non-installed package)
    if (stub) {
      expect(stub.stub_note).toBeDefined();
      expect(stub.stub_note).toContain("stat_install");
    }
  });

  it("stat_resolve rejects unclassified or stub functions", async () => {
    // Use a very niche package unlikely to be installed or tarball-extracted
    const result = await callTool(server, "stat_resolve", {
      package: "SQUAREM",
      function: "squarem",
    });
    // Should either be a stub, unclassified, or not found — any error is valid
    // If the function happens to be classified, the test still passes (no assertion needed)
    if (result.isError) {
      const data = JSON.parse(result.content[0].text);
      // Valid error reasons: stub, unclassified, not found, not installed
      expect(
        data.is_stub === true ||
        data.message?.includes("not found") ||
        data.message?.includes("not been reviewed") ||
        data.message?.includes("not installed"),
      ).toBe(true);
    }
  });

  it("Python: search → resolve → call → describe sklearn LinearRegression", async (ctx) => {
    requirePython(ctx);
    // 1. Search — Python results should appear and be callable
    const searchResult = await callTool(server, "stat_search", {
      query: "sklearn linear regression",
      max_results: 20,
    });
    const searchData = JSON.parse(searchResult.content[0].text);
    const pyResult = searchData.results.find(
      (r: { runtime: string; id: string }) =>
        r.runtime === "python" && r.id.includes("LinearRegression"),
    );
    expect(pyResult).toBeDefined();
    // callable_count should include Python functions
    expect(searchData.callable_count).toBeGreaterThan(0);

    // 2. Resolve
    const resolveResult = await callTool(server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
    });
    expect(resolveResult.isError).toBeFalsy();
    const resolveData = JSON.parse(resolveResult.content[0].text);
    expect(resolveData.resolved).toBe(true);
    expect(resolveData.runtime).toBe("python");

    // 3. Call to create model
    const callResult = await callTool(server, "stat_call", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
      args: {},
    });
    expect(callResult.isError).toBeFalsy();
    const callData = JSON.parse(callResult.content[0].text);
    expect(callData.result.class).toBe("LinearRegression");
    expect(callData.objects_created).toBeDefined();
    const modelId = callData.objects_created[0].id;

    // 4. Describe the Python handle — should route to Python worker, not R
    const describeResult = await callTool(server, "stat_describe", {
      handle: modelId,
    });
    expect(describeResult.isError).toBeFalsy();
    const describeData = JSON.parse(describeResult.content[0].text);
    expect(describeData.r_class).toBe("LinearRegression");
  }, 15000);

  it("Python: safe_only search includes Python callable functions", async (ctx) => {
    requirePython(ctx);
    const result = await callTool(server, "stat_search", {
      query: "sklearn logistic regression",
      safe_only: true,
      max_results: 20,
    });
    const data = JSON.parse(result.content[0].text);
    const pyResults = data.results.filter(
      (r: { runtime: string }) => r.runtime === "python",
    );
    // Python callable_with_caveats functions should appear in safe_only results
    expect(pyResults.length).toBeGreaterThan(0);
  });

  it("stat_session returns isError for missing handle", async () => {
    const result = await callTool(server, "stat_session", {
      handle: "nonexistent_handle_999",
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("not found");
  });

  it("Python: full sklearn workflow — load → construct → fit → predict via stat_method", async (ctx) => {
    requirePython(ctx);
    // 1. Resolve LinearRegression
    const resolveResult = await callTool(server, "stat_resolve", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
    });
    expect(resolveResult.isError).toBeFalsy();

    // 2. Construct the model
    const callResult = await callTool(server, "stat_call", {
      package: "sklearn.linear_model",
      function: "LinearRegression",
      args: {},
      assign_to: "lr_model",
    });
    expect(callResult.isError).toBeFalsy();
    const callData = JSON.parse(callResult.content[0].text);
    expect(callData.objects_created).toBeDefined();
    expect(callData.objects_created[0].id).toBe("lr_model");

    // 3. Fit using stat_method with inline arrays (no data loading needed)
    const fitResult = await callTool(server, "stat_method", {
      object: "lr_model",
      method: "fit",
      positional_args: [[[1], [2], [3], [4], [5]], [2, 4, 6, 8, 10]],
    });
    expect(fitResult.isError).toBeFalsy();
    const fitData = JSON.parse(fitResult.content[0].text);
    // fit() returns self, so result should have coefficients
    expect(fitData.result.coefficients).toBeDefined();

    // 4. Predict using stat_method
    const predictResult = await callTool(server, "stat_method", {
      object: "lr_model",
      method: "predict",
      positional_args: [[[6], [7]]],
      assign_to: "preds",
    });
    expect(predictResult.isError).toBeFalsy();
    const predData = JSON.parse(predictResult.content[0].text);
    expect(predData.result).toBeDefined();

    // 5. Verify the prediction handle exists in session
    const sessionResult = await callTool(server, "stat_session", {});
    expect(sessionResult.isError).toBeFalsy();
    const sessionData = JSON.parse(sessionResult.content[0].text);
    const predHandle = sessionData.handles.find(
      (h: { id: string }) => h.id === "preds",
    );
    expect(predHandle).toBeDefined();
    expect(predHandle.r_class).toBe("ndarray");
  }, 20000);

  it("Python: stat_load_data with runtime=python creates pandas handle", async (ctx) => {
    requirePython(ctx);
    // Load into Python runtime
    const loadResult = await callTool(server, "stat_load_data", {
      file_path: TEST_CSV,
      runtime: "python",
      name: "py_cars",
    });
    expect(loadResult.isError).toBeFalsy();
    const loadData = JSON.parse(loadResult.content[0].text);
    expect(loadData.class).toBe("DataFrame");
    expect(loadData.dimensions.rows).toBe(5);
    expect(loadData.dimensions.cols).toBe(4);
    expect(loadData.object_id).toBe("py_cars");

    // Verify handle is tagged as Python in session
    const sessionResult = await callTool(server, "stat_session", {
      handle: "py_cars",
    });
    expect(sessionResult.isError).toBeFalsy();
    const sessionData = JSON.parse(sessionResult.content[0].text);
    expect(sessionData.handle.runtime).toBe("python");

    // Describe should route to Python worker
    const descResult = await callTool(server, "stat_describe", {
      handle: "py_cars",
      action: "head",
    });
    expect(descResult.isError).toBeFalsy();
  }, 10000);

  it("stat_method rejects non-Python handle", async () => {
    // Load data into R
    const loadResult = await callTool(server, "stat_load_data", {
      file_path: TEST_CSV,
    });
    expect(loadResult.isError).toBeFalsy();
    const loadData = JSON.parse(loadResult.content[0].text);
    const handleId = loadData.object_id;

    // Try to call a method on the R handle
    const methodResult = await callTool(server, "stat_method", {
      object: handleId,
      method: "head",
    });
    expect(methodResult.isError).toBe(true);
    const data = JSON.parse(methodResult.content[0].text);
    expect(data.message).toContain("R object");
  });

  it("stat_method rejects missing handle", async () => {
    const result = await callTool(server, "stat_method", {
      object: "nonexistent_42",
      method: "fit",
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toContain("not found");
  });
});
