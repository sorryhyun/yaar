/**
 * `missingOk` on an app's config read — `yaar://config/app/{appId}`, where per-app
 * config and user-supplied credentials live.
 *
 * Storage honoured the option; config did not look at it. An app with no config yet
 * therefore got a *success* back whose body was `{ app: { [id]: null, error: "No config
 * found…" } }` — neither the `null` that `missingOk` promises nor a failure a caller could
 * catch, so "is the token set yet?" had to be answered by sniffing an `error` field out
 * of a success. This pins the same contract storage has (`storage-missing-ok.test.ts`):
 * absent + `missingOk` → `null`; absent without it → a failure tagged not-found; present →
 * the stored value either way.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { initRegistry } from '../handlers/index.js';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { writeAppConfig } from '../features/apps/config.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-config-missing-ok' as SessionId;
const APP = 'config-reader';

function appToken(): string {
  return generateIframeToken('win-config-missing-ok', SESSION, {
    appId: APP,
    permissions: [
      `yaar://config/app/${APP}`,
      'yaar://config/app/other-app',
      'yaar://config/hooks/',
      'yaar://config/mcp/',
    ],
  });
}

async function read(uri: string, options?: unknown): Promise<Record<string, unknown>> {
  const req = new Request('http://localhost:8000/api/verb', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iframe-token': appToken() },
    body: JSON.stringify({
      verb: 'read',
      uri,
      ...(options === undefined ? {} : { payload: options }),
    }),
  });
  const res = await handleVerbRoutes(req, new URL(req.url));
  if (!res) throw new Error('route did not handle POST /api/verb');
  return (await res.json()) as Record<string, unknown>;
}

describe('read yaar://config/app/{appId} with missingOk', () => {
  beforeAll(() => {
    initRegistry();
  });

  it('answers an app that has no config yet with null', async () => {
    const envelope = await read('yaar://config/app/other-app', { missingOk: true });

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeNull();
  });

  it('fails that read, rather than succeeding with an error field, without missingOk', async () => {
    const envelope = await read('yaar://config/app/other-app');

    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain('No config found');
  });

  it('returns the stored config when there is one, missingOk or not', async () => {
    await writeAppConfig(APP, { api_key: 'k' });

    for (const options of [undefined, { missingOk: true }]) {
      const envelope = await read(`yaar://config/app/${APP}`, options);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ app: { [APP]: { api_key: 'k' } } });
    }
  });
});

// The other config entries an app can name by id take the option the same way.
describe('read of an absent config entry with missingOk', () => {
  beforeAll(() => {
    initRegistry();
  });

  for (const uri of ['yaar://config/hooks/no-such-hook', 'yaar://config/mcp/no-such-server']) {
    it(`answers ${uri} with null, and fails it without the option`, async () => {
      const withOption = await read(uri, { missingOk: true });
      expect(withOption.ok).toBe(true);
      expect(withOption.data).toBeNull();

      const without = await read(uri);
      expect(without.ok).toBe(false);
      expect(without.error).toContain('not found');
    });
  }
});
