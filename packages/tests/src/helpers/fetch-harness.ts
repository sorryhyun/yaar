/**
 * Thin wrapper around createFetchHandler() for integration tests.
 * Calls the handler directly — no Bun.serve() process needed.
 */

import { createFetchHandler } from '@yaar/server/http/server';
import { createMockServer } from './mocks.js';

const BASE_URL = 'http://localhost:8000';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Make a test request through the real fetch handler.
 * Returns a Response; returns 101 synthetic response for WS upgrade paths.
 */
export async function makeRequest(path: string, opts: RequestOptions = {}): Promise<Response> {
  const handler = createFetchHandler();
  const server = createMockServer();

  const req = new Request(`${BASE_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await handler(req, server as any);
  if (result === undefined) {
    // WS upgrade — return a synthetic 101 so tests don't explode
    return new Response(null, { status: 101 });
  }
  return result;
}
