/**
 * Stub Transport for Codex (placeholder).
 *
 * This stub always reports as unavailable. It serves as:
 * 1. Documentation for how to implement a new transport
 * 2. Placeholder for future Codex implementation
 *
 * For a real implementation, see the JSON-RPC approach documented
 * in the original Python backend: backend/providers/codex/transport.py
 */

import type { AITransport, StreamMessage, TransportOptions } from './types.js';

export class StubTransport implements AITransport {
  readonly name = 'codex';

  async isAvailable(): Promise<boolean> {
    // Always unavailable - this is just a stub
    return false;
  }

  async *query(
    _prompt: string,
    _options: TransportOptions
  ): AsyncIterable<StreamMessage> {
    yield {
      type: 'error',
      error: 'Codex transport not implemented. Use Claude instead.',
    };
  }

  interrupt(): void {
    // No-op for stub
  }

  async dispose(): Promise<void> {
    // No-op for stub
  }
}
