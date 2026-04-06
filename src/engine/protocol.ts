// ============================================================================
// StatTools — Newline-Delimited JSON (NDJSON) Codec
// ============================================================================
// Handles buffering partial lines from R process stdout. R may emit large JSON
// objects that arrive in multiple chunks. This codec buffers until a complete
// line (terminated by \n) is received, then parses and dispatches.

import type { RpcResponse } from "../types.js";

export type MessageHandler = (response: RpcResponse) => void;
export type ErrorHandler = (error: Error) => void;

export class NdjsonCodec {
  private buffer = "";
  private readonly onMessage: MessageHandler;
  private readonly onError: ErrorHandler;

  constructor(onMessage: MessageHandler, onError: ErrorHandler) {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  /** Feed raw data from stdout. May contain partial lines or multiple lines. */
  feed(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) continue;

      try {
        const parsed = JSON.parse(line) as RpcResponse;
        this.onMessage(parsed);
      } catch (e) {
        this.onError(
          new Error(
            `Failed to parse R bridge response: ${(e as Error).message}. Line: ${line.slice(0, 200)}`,
          ),
        );
      }
    }
  }

  /** Check if there's unparsed data remaining in the buffer. */
  hasPartialData(): boolean {
    return this.buffer.trim().length > 0;
  }

  /** Reset the buffer (e.g., after worker restart). */
  reset(): void {
    this.buffer = "";
  }
}

/** Encode an object as a single NDJSON line (with trailing newline). */
export function encodeNdjson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}
