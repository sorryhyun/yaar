/**
 * The copy shape the gate reads is the copy shape the handlers act on.
 *
 * `invoke { action: 'copy', from }` is the one storage action that reads a URI the
 * caller did not name as its target, so `POST /api/verb` re-checks `read` on `from`
 * before dispatching. The storage handlers authorize nothing themselves, so that
 * check is the whole invariant — and it used to be duck-typed against a payload
 * shape three other files defined independently. A renamed field would have
 * uncovered it silently: the copies keep working, the `read` gate simply stops
 * firing.
 *
 * `handlers/storage-copy.ts` is now the one definition. These rows pin the two
 * halves that must agree: what the gate extracts, and that the gate actually
 * refuses a source the caller may not read — including in a batch, which the
 * registry runs without coming back through the door.
 */
import { describe, it, expect } from 'bun:test';
import {
  COPY_ACTION,
  COPY_FROM_REQUIRED,
  COPY_FROM_SCHEMA,
  copyFrom,
  copySources,
  isCopyPayload,
  resolveCopySources,
} from '../handlers/storage-copy.js';
import { initRegistry } from '../handlers/index.js';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-copy-shape' as SessionId;

/** An app that may write its own storage and read nothing else. */
function appToken(): string {
  return generateIframeToken('win-copy', SESSION, {
    appId: 'notes',
    permissions: ['yaar://apps/notes/storage/'],
  });
}

async function callVerb(
  token: string,
  verb: string,
  uri: string,
  payload?: unknown,
): Promise<Response> {
  const req = new Request('http://localhost:8000/api/verb', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iframe-token': token },
    body: JSON.stringify({ verb, uri, ...(payload === undefined ? {} : { payload }) }),
  });
  const res = await handleVerbRoutes(req, new URL(req.url));
  if (!res) throw new Error('route did not handle POST /api/verb');
  return res;
}

async function invoke(token: string, payload: unknown): Promise<Response> {
  return callVerb(token, 'invoke', 'yaar://apps/notes/storage/copied.txt', payload);
}

describe('copySources', () => {
  it('collects nothing from a payload that is not a copy', () => {
    expect(copySources({ action: 'write', content: 'x' })).toEqual({ sources: [] });
    expect(copySources(undefined)).toEqual({ sources: [] });
  });

  it('collects the source of a single copy', () => {
    expect(copySources({ action: COPY_ACTION, from: 'yaar://storage/a.txt' })).toEqual({
      sources: ['yaar://storage/a.txt'],
    });
  });

  it('collects every source in a batch, skipping the non-copies', () => {
    expect(
      copySources([
        { action: 'write', content: 'x' },
        { action: COPY_ACTION, from: 'yaar://storage/a.txt' },
        { action: COPY_ACTION, from: 'yaar://apps/vault/storage/b.txt' },
      ]),
    ).toEqual({ sources: ['yaar://storage/a.txt', 'yaar://apps/vault/storage/b.txt'] });
  });

  it('refuses a copy whose source is missing or not a string', () => {
    expect(copySources({ action: COPY_ACTION })).toEqual({ error: COPY_FROM_REQUIRED });
    expect(copySources({ action: COPY_ACTION, from: 42 })).toEqual({ error: COPY_FROM_REQUIRED });
    // One bad element refuses the whole batch — the registry would run the good ones.
    expect(
      copySources([{ action: COPY_ACTION, from: 'yaar://storage/a.txt' }, { action: COPY_ACTION }]),
    ).toEqual({ error: COPY_FROM_REQUIRED });
  });

  it('agrees with the per-payload helpers the handlers use', () => {
    const payload = { action: COPY_ACTION, from: 'yaar://storage/a.txt' };
    expect(isCopyPayload(payload)).toBe(true);
    expect(copyFrom(payload)).toBe('yaar://storage/a.txt');
    // The schema the doors advertise names the same field these read.
    expect(COPY_FROM_SCHEMA.description).toContain('copy');
  });
});

describe('the door refuses a source the caller may not read', () => {
  it('403s a copy naming another app’s storage', async () => {
    initRegistry();
    const res = await invoke(appToken(), {
      action: COPY_ACTION,
      from: 'yaar://apps/vault/storage/secrets.json',
    });
    expect(res.status).toBe(403);
  });

  it('403s the same source hidden in a batch', async () => {
    initRegistry();
    const res = await invoke(appToken(), [
      { action: 'write', content: 'harmless' },
      { action: COPY_ACTION, from: 'yaar://apps/vault/storage/secrets.json' },
    ]);
    expect(res.status).toBe(403);
  });

  it('400s a copy that names no source at all', async () => {
    initRegistry();
    const res = await invoke(appToken(), { action: COPY_ACTION });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('required for copy');
  });
});

describe('resolveCopySources', () => {
  it('expands `self` in a copy source, leaving everything else alone', () => {
    expect(
      resolveCopySources({ action: COPY_ACTION, from: 'yaar://apps/self/storage/x.txt' }, 'notes'),
    ).toEqual({ action: COPY_ACTION, from: 'yaar://apps/notes/storage/x.txt' });
  });

  it('returns the payload itself when there is nothing to expand', () => {
    const payload = { action: COPY_ACTION, from: 'yaar://storage/a.txt' };
    expect(resolveCopySources(payload, 'notes')).toBe(payload);
    // No appId to expand against — a `describe` from an anonymous caller.
    const pronoun = { action: COPY_ACTION, from: 'yaar://apps/self/storage/x.txt' };
    expect(resolveCopySources(pronoun, undefined)).toBe(pronoun);
    const write = { action: 'write', content: 'x' };
    expect(resolveCopySources(write, 'notes')).toBe(write);
  });

  it('expands every element of a batch', () => {
    expect(
      resolveCopySources(
        [
          { action: 'write', content: 'x' },
          { action: COPY_ACTION, from: 'yaar://apps/self/storage/a.txt' },
          { action: COPY_ACTION, from: 'yaar://storage/b.txt' },
        ],
        'notes',
      ),
    ).toEqual([
      { action: 'write', content: 'x' },
      { action: COPY_ACTION, from: 'yaar://apps/notes/storage/a.txt' },
      { action: COPY_ACTION, from: 'yaar://storage/b.txt' },
    ]);
  });
});

/**
 * The export direction, end to end.
 *
 * An app could copy *into* its own storage and not back out of it: the target URI was
 * self-expanded before dispatch and the source was not, so `from: yaar://apps/self/...`
 * passed the read gate and then looked for an app literally named `self`. That asymmetry
 * is what left devtools with no way to hand a project file to another app.
 */
describe('a copy out of the app’s own storage', () => {
  it('lands the bytes in the shared tree when the source names `self`', async () => {
    initRegistry();
    const token = appToken();

    const written = await callVerb(token, 'invoke', 'yaar://apps/self/storage/level01.json', {
      action: 'write',
      content: '{"scene":"level01"}',
    });
    expect(written.status).toBe(200);

    const copied = await callVerb(token, 'invoke', 'yaar://storage/shared/notes/level01.json', {
      action: COPY_ACTION,
      from: 'yaar://apps/self/storage/level01.json',
    });
    expect(copied.status).toBe(200);
    expect(JSON.stringify(await copied.json())).not.toContain('apps/self');

    const read = await callVerb(token, 'read', 'yaar://storage/shared/notes/level01.json');
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain('level01');
  });
});
