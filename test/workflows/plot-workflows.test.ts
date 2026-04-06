// ============================================================================
// StatTools — Plot Workflow Tests (Wave 2)
// ============================================================================
// ggplot2 visualization via stat_plot expression.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import {
  createTestServer, callTool, expectSuccess, TEST_CSV, type TestServer,
} from "../fixtures/common.js";

describe("Plot Workflows (Wave 2)", () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer();
    expectSuccess(await callTool(ts.server, "stat_load_data", { file_path: TEST_CSV, name: "plot_data" }));
  });

  afterAll(async () => {
    await ts.cleanup();
  });

  it("ggplot2: scatter + smooth + color + labs → durable PNG", async () => {
    const result = expectSuccess(await callTool(ts.server, "stat_plot", {
      expression: 'library(ggplot2); ggplot(plot_data, aes(x=wt, y=mpg, color=factor(cyl))) + geom_point() + geom_smooth(method="lm") + labs(title="MPG vs Weight", color="Cylinders")',
    }));

    expect(result.file_path).toBeDefined();
    expect(result.format).toBe("png");
    expect((result.file_size_bytes as number)).toBeGreaterThan(1000);
    // Verify file actually exists on disk (durable path, not tempdir)
    expect(existsSync(result.file_path as string)).toBe(true);
    expect((result.file_path as string)).toContain("data/plots");
  }, 15000);

  it("base R: histogram → PNG", async () => {
    const result = expectSuccess(await callTool(ts.server, "stat_plot", {
      expression: 'hist(plot_data$mpg, main="MPG Distribution", xlab="MPG", col="steelblue")',
    }));
    expect(result.file_path).toBeDefined();
    expect(existsSync(result.file_path as string)).toBe(true);
  }, 15000);

  it("ggplot2: faceted plot → PNG", async () => {
    const result = expectSuccess(await callTool(ts.server, "stat_plot", {
      expression: 'library(ggplot2); ggplot(plot_data, aes(x=hp, y=mpg)) + geom_point() + facet_wrap(~cyl) + theme_minimal()',
    }));
    expect(result.file_path).toBeDefined();
    expect(existsSync(result.file_path as string)).toBe(true);
  }, 15000);

  it("stat_plot: PDF format", async () => {
    const result = expectSuccess(await callTool(ts.server, "stat_plot", {
      expression: 'plot(plot_data$wt, plot_data$mpg, main="Scatter")',
      format: "pdf",
    }));
    expect(result.format).toBe("pdf");
    expect(existsSync(result.file_path as string)).toBe(true);
  }, 15000);
});
