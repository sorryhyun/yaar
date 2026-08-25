/**
 * Absence of an optional config file is a normal answer, and the layer that reads it
 * had no way to say so.
 *
 * `appStorage.readJsonOr(path, fallback)` is an app declaring "if this isn't there yet,
 * use the fallback" — and it was implemented as a plain `read` plus a `catch`, because
 * `window.yaar.read` took no options and the verb layer had no read-or-null. So the
 * declaration reached nobody: the read still failed, the failure was still recorded as
 * a session error, and the app's own console stayed clean because it had handled the
 * rejection one layer above. A first launch, where every persisted preference is still
 * missing, therefore reported one error per optional file per mount — in the sessions
 * that motivated this, between 92% and 100% of every error the log held.
 *
 * Two halves are pinned here, because they cover different populations:
 *
 *   - `missingOk` on the read itself, for an app compiled against the current SDK.
 *   - `notFound` on the failure, for the apps that are not — an app bakes its SDK in at
 *     compile time, so a plain read keeps arriving from every app not yet rebuilt. That
 *     one still logs, and still must not count.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { storageWrite, storageRead } from '../storage/storage-manager.js';
import { initRegistry } from '../handlers/index.js';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { createSession, SessionLogger } from '../logging/session-logger.js';
import { NOT_FOUND_CATEGORY } from '../logging/types.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-missing-ok' as SessionId;
const APP = 'prefs-reader';

/** An app that may read and write its own storage, and read the shared tree. */
function appToken(): string {
  return generateIframeToken('win-missing-ok', SESSION, {
    appId: APP,
    permissions: [`yaar://apps/${APP}/storage/`, 'yaar://storage/'],
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

describe('storageRead marks absence', () => {
  it('flags a missing file rather than only saying so in prose', async () => {
    const result = await storageRead('missing-ok/no-such-file.json');

    expect(result.success).toBe(false);
    expect(result.notFound).toBe(true);
    // The sentence stays — it is what a human reader sees.
    expect(result.error).toContain('File not found');
  });

  it('leaves a readable file unflagged', async () => {
    await storageWrite('missing-ok/present.json', '{"a":1}');
    const result = await storageRead('missing-ok/present.json');

    expect(result.success).toBe(true);
    expect(result.notFound).toBeUndefined();
  });
});

describe('read with missingOk', () => {
  beforeAll(() => {
    initRegistry();
  });

  it('answers an absent app-storage file with null instead of an error', async () => {
    const envelope = await read(`yaar://apps/${APP}/storage/settings.json`, { missingOk: true });

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeNull();
  });

  it('still fails that read when the caller does not ask for it', async () => {
    const envelope = await read(`yaar://apps/${APP}/storage/settings.json`);

    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain('File not found');
  });

  it('answers an absent shared-storage file with null too', async () => {
    const envelope = await read('yaar://storage/missing-ok/absent.json', { missingOk: true });

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeNull();
  });

  // The option must not turn into "reads never fail" — a file that IS there still comes
  // back, or `readJsonOr` would quietly hand every app its fallback forever.
  it('returns the stored value when the file exists', async () => {
    await storageWrite(`apps/${APP}/settings.json`, JSON.stringify({ theme: 'light' }));

    const envelope = await read(`yaar://apps/${APP}/storage/settings.json`, { missingOk: true });

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ theme: 'light' });
  });
});

describe('the session failure tally', () => {
  it('counts an ordinary verb failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yaar-tally-'));
    try {
      const info = await createSession('claude', root);
      const logger = new SessionLogger(info);
      logger.logVerbResult('iframe:app', { ok: false, error: 'boom' }, { isError: true });
      await logger.dispose();

      expect(info.metadata.failureCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // What an app compiled before `missingOk` still produces. It stays in the log — the app
  // asked for something and did not get it — and stays out of the count.
  it('does not count a not-found one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yaar-tally-'));
    try {
      const info = await createSession('claude', root);
      const logger = new SessionLogger(info);
      logger.logVerbResult(
        'iframe:app',
        { ok: false, error: 'File not found: apps/x/settings.json' },
        { isError: true, errorCategory: NOT_FOUND_CATEGORY },
      );
      await logger.dispose();

      expect(info.metadata.failureCount ?? 0).toBe(0);
      const entries = await Bun.file(join(info.directory, 'messages.jsonl')).text();
      expect(entries).toContain(NOT_FOUND_CATEGORY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
