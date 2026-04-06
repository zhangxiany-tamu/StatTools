// ============================================================================
// StatTools — stat_plot Tool
// ============================================================================
// Render a plot to a file and return the path.
// Supports: ggplot objects, base R plot expressions, stored plot handles.

import type { WorkerPool } from "../engine/workerPool.js";
import type { SessionStore } from "../engine/session.js";
import { successResult, errorResult, type StatToolResult } from "../types.js";
import { logUsage, startTimer } from "../util/usageLogger.js";

export const STAT_PLOT_SCHEMA = {
  type: "object" as const,
  properties: {
    handle: {
      type: "string",
      description:
        "Handle ID of a ggplot or plot object to render. Mutually exclusive with 'expression'.",
    },
    expression: {
      type: "string",
      description:
        "R expression that produces a plot. Session handles are available by name. Examples: 'plot(data_1$mpg, data_1$wt)', 'ggplot(data_1, aes(x=wt, y=mpg)) + geom_point() + geom_smooth(method=\"lm\")', 'hist(data_1$mpg)'. Mutually exclusive with 'handle'.",
    },
    format: {
      type: "string",
      description: "Output format: png (default), pdf, or svg.",
      enum: ["png", "pdf", "svg"],
    },
    width: {
      type: "number",
      description: "Width in pixels (default: 800). For pdf/svg, converted to inches.",
    },
    height: {
      type: "number",
      description: "Height in pixels (default: 600). For pdf/svg, converted to inches.",
    },
  },
  required: [],
};

export type StatPlotInput = {
  handle?: string;
  expression?: string;
  format?: "png" | "pdf" | "svg";
  width?: number;
  height?: number;
};

export async function executeStatPlot(
  input: StatPlotInput,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
): Promise<StatToolResult> {
  const { handle, expression, format, width, height } = input;
  const elapsed = startTimer();

  if (!handle && !expression) {
    return errorResult(
      "Provide either 'handle' (a ggplot/plot object) or 'expression' (R code that produces a plot).",
      {
        examples: [
          'expression: "plot(data_1$mpg, data_1$wt)"',
          'expression: "ggplot(data_1, aes(x=wt, y=mpg)) + geom_point()"',
          'expression: "hist(data_1$mpg, main=\\"MPG Distribution\\")"',
          "handle: \"model_1\"  (if model_1 is a ggplot object)",
        ],
      },
    );
  }

  // Validate handle if provided
  if (handle) {
    const handleObj = sessionStore.getState().handles.get(handle);
    if (!handleObj) {
      return errorResult(`Handle '${handle}' not found.`, {
        available: [...sessionStore.getState().handles.keys()],
      });
    }
    if (handleObj.runtime === "python") {
      return errorResult("stat_plot only supports R objects. Use matplotlib for Python plots.");
    }
  }

  let response;
  try {
    response = await workerPool.call("render_plot", {
      object: handle || null,
      expression: expression || null,
      format: format || "png",
      width: width || 800,
      height: height || 600,
    });
  } catch (err) {
    return errorResult(`Plot rendering failed: ${(err as Error).message}`);
  }

  if (response.error) {
    return errorResult(response.error.message, {
      suggestion: response.error.suggestion,
    });
  }

  logUsage({
    type: "call",
    timestamp: new Date().toISOString(),
    package: "stattools",
    function: "render_plot",
    success: true,
    latency_ms: elapsed(),
  });

  return successResult(response.result);
}
