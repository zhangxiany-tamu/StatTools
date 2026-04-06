// ============================================================================
// StatTools — Shared Test Fixtures
// ============================================================================
// Common helpers for workflow tests. Extracted from mcp-e2e.test.ts.

import { createStatToolsServer, type ServerConfig } from "../../src/server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = resolve(__dirname, "../../data/stattools.db");
export const TEST_DATA_DIR = resolve(__dirname, "data");
export const TEST_CSV = resolve(__dirname, "data/mtcars_sample.csv");
export const TEST_CSV_NANF = resolve(__dirname, "data/with_nan.csv");

export type TestServer = {
  server: Server;
  cleanup: () => Promise<void>;
};

/** Create a test server with default config. */
export async function createTestServer(
  overrides?: Partial<ServerConfig>,
): Promise<TestServer> {
  const config: ServerConfig = {
    dbPath: DB_PATH,
    allowedDataRoots: ["/tmp", TEST_DATA_DIR],
    rPath: "Rscript",
    ...overrides,
  };
  const { server, cleanup } = await createStatToolsServer(config);
  return { server, cleanup };
}

/** Call an MCP tool directly (bypassing transport). */
export async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = (server as any)._requestHandlers?.get("tools/call");
  if (!handler) throw new Error("No tools/call handler registered");

  const result = await handler({
    method: "tools/call",
    params: { name, arguments: args },
  });
  return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

/** Parse the JSON text from a tool result. */
export function parseResult(
  result: { content: Array<{ type: string; text: string }>; isError?: boolean },
): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/** Assert that a tool call succeeded and return parsed data. */
export function expectSuccess(
  result: { content: Array<{ type: string; text: string }>; isError?: boolean },
): Record<string, unknown> {
  if (result.isError) {
    const data = JSON.parse(result.content[0].text);
    throw new Error(`Tool call failed: ${data.message || JSON.stringify(data)}`);
  }
  return parseResult(result);
}
