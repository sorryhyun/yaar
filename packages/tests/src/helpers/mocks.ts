/**
 * Shared mock helpers for integration tests.
 */

import { vi } from 'vitest';

/**
 * Create a minimal mock WebSocket that records sent messages.
 */
export function createMockWs(readyState = 1 /* OPEN */) {
  const sentMessages: string[] = [];
  return {
    readyState,
    send: vi.fn((msg: string) => {
      sentMessages.push(msg);
    }),
    sentMessages,
    close: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
    cork: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
    data: {},
    remoteAddress: '127.0.0.1',
    binaryType: 'arraybuffer' as const,
    readyStateNumber: readyState,
  };
}

/**
 * Stub the global Bun object for Node.js/vitest environments.
 *
 * Pass fileContents map of { partialPath: jsonString } to control what
 * Bun.file(path).text() returns for paths ending with each key.
 */
export function stubBunFile(
  fileContents: Record<string, string> = {},
  defaultContent = '{}',
): void {
  vi.stubGlobal('Bun', {
    file: vi.fn((filePath: string) => ({
      text: async () => {
        const key = Object.keys(fileContents).find((k) => filePath.endsWith(k));
        if (key) return fileContents[key];
        return defaultContent;
      },
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => {
        const content = defaultContent;
        return JSON.parse(content);
      },
    })),
    write: vi.fn().mockResolvedValue(0),
  });
}

/**
 * Create a minimal mock Bun.serve Server for the HTTP fetch handler.
 */
export function createMockServer() {
  return {
    upgrade: vi.fn(() => false),
    stop: vi.fn(),
    fetch: vi.fn(),
    publish: vi.fn(),
    reload: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    requestIP: vi.fn(() => null),
    pendingWebSockets: 0,
    pendingRequests: 0,
    hostname: 'localhost',
    port: 8000,
    protocol: 'http',
    url: new URL('http://localhost:8000'),
    id: 'test-server',
    development: false,
  };
}
