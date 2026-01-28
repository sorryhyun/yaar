/**
 * Transport factory for creating AI transport instances.
 */

import { AgentSDKTransport } from './agent-sdk.js';
import { StubTransport } from './stub.js';
import type { AITransport } from './types.js';

const transports: Record<string, () => AITransport> = {
  claude: () => new AgentSDKTransport(),
  codex: () => new StubTransport(),
};

/**
 * Get list of available transport names.
 */
export async function getAvailableTransports(): Promise<string[]> {
  const available: string[] = [];

  for (const [name, factory] of Object.entries(transports)) {
    const transport = factory();
    try {
      if (await transport.isAvailable()) {
        available.push(name);
      }
    } finally {
      await transport.dispose();
    }
  }

  return available;
}

/**
 * Create a transport instance by name.
 */
export function createTransport(name: string): AITransport {
  const factory = transports[name];
  if (!factory) {
    throw new Error(`Unknown transport: ${name}`);
  }
  return factory();
}

/**
 * Get the first available transport.
 */
export async function getFirstAvailableTransport(): Promise<AITransport | null> {
  // Prefer Claude over Codex
  const preferenceOrder = ['claude', 'codex'];

  for (const name of preferenceOrder) {
    const factory = transports[name];
    if (!factory) continue;

    const transport = factory();
    if (await transport.isAvailable()) {
      return transport;
    }
    await transport.dispose();
  }

  return null;
}
