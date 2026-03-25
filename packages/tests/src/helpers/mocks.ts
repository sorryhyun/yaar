/**
 * Shared mock helpers for integration tests.
 */

import { mock } from 'bun:test';

/**
 * Create a minimal mock WebSocket that records sent messages.
 */
export function createMockWs(readyState = 1 /* OPEN */) {
  const sentMessages: string[] = [];
  return {
    readyState,
    send: mock((msg: string) => {
      sentMessages.push(msg);
    }),
    sentMessages,
    close: mock(() => {}),
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
    publish: mock(() => {}),
    cork: mock(() => {}),
    ping: mock(() => {}),
    terminate: mock(() => {}),
    data: {},
    remoteAddress: '127.0.0.1',
    binaryType: 'arraybuffer' as const,
    readyStateNumber: readyState,
  };
}

/**
 * Create a minimal mock Bun.serve Server for the HTTP fetch handler.
 */
export function createMockServer() {
  return {
    upgrade: mock(() => false),
    stop: mock(() => {}),
    fetch: mock(() => {}),
    publish: mock(() => {}),
    reload: mock(() => {}),
    ref: mock(() => {}),
    unref: mock(() => {}),
    requestIP: mock(() => null),
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
