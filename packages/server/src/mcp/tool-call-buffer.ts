/**
 * Lightweight buffer for recent MCP verb tool calls.
 *
 * When the SDK runs a subagent, its tool calls hit our MCP endpoint but
 * the `task_progress` event only carries `last_tool_name` (no input).
 * We buffer verb executions here so the message-mapper can enrich
 * task_progress events with the actual URI/payload.
 */

interface BufferedCall {
  verb: string;
  uri: string;
  payload?: unknown;
  timestamp: number;
}

const buffer: BufferedCall[] = [];
const MAX_SIZE = 100;
const TTL_MS = 30_000;

/** Record a verb tool execution. Called from the verb handler wrapper. */
export function recordVerbCall(verb: string, uri: string, payload?: unknown): void {
  // Evict stale entries
  const cutoff = Date.now() - TTL_MS;
  while (buffer.length > 0 && buffer[0].timestamp < cutoff) {
    buffer.shift();
  }
  buffer.push({ verb, uri, payload, timestamp: Date.now() });
  if (buffer.length > MAX_SIZE) buffer.shift();
}

/**
 * Consume the most recent buffered call matching a verb name.
 * Returns null if no match found. Removes the entry from the buffer.
 */
export function consumeLastCall(verb: string): { uri: string; payload?: unknown } | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].verb === verb) {
      const [entry] = buffer.splice(i, 1);
      return { uri: entry.uri, payload: entry.payload };
    }
  }
  return null;
}
