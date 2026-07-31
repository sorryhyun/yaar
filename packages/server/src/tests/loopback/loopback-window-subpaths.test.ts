/**
 * S10 — `yaar://windows/{id}` sub-paths, against a window a real app is answering from.
 *
 * `enrichManifestWithUris` has been stamping `yaar://windows/{id}/state/{key}` and
 * `.../commands/{key}` onto every key of every live manifest for as long as there have been
 * live manifests, and until now no handler implemented either: a `read` of one silently
 * returned the whole window, and an `invoke` of one demanded an `action` the URI had
 * already named. This file is the promise being kept — and the shape of the refusals when
 * it is used wrongly, because "silently something else" was the old failure and a URI that
 * parses as neither sub-resource must not fall back to it.
 *
 * Why the loopback harness rather than a unit test over `handlers/window.ts`: every one of
 * these verbs is answered by *asking the iframe* — `fetchLiveManifest`, `handleAppDescribe`,
 * `handleAppQuery`, `handleAppCommand` each park on a `PendingStore` entry that only a
 * frame arriving through `createWsHandlers().message()` can settle. A stubbed emitter would
 * prove the routing table and nothing about whether the answer can arrive; here the manifest
 * `describe` reads, the doc it falls back to, and the params a command runs with have all
 * made the round trip an app really makes. The `describe` request kind is new on that wire,
 * so this is also the first test that carries one.
 *
 * The head-of-line hazard those waits live inside is S1's subject, not this file's; these
 * calls are made the way the MCP tool handler makes them — inside the caller's restored
 * agent context — because that context is where the window handlers resolve both the
 * session and the monitor from.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import type { AppManifest, AppProtocolRequest, AppProtocolResponse } from '@yaar/shared';
import type { ContentBlock, Verb, VerbResult } from '../../handlers/uri-registry.js';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

const { ResourceRegistry } = await import('../../handlers/uri-registry.js');
const { registerWindowHandlers } = await import('../../handlers/window.js');
const { runWithAgentContext } = await import('../../agents/agent-context.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/**
 * One app, as the browser holds it — a manifest, the values behind its state keys, and the
 * per-key docs it computes on demand.
 *
 * `docs` is keyed `"{target}/{key}"` and is deliberately partial: an app defines
 * `describe()` on the entries where a static one-liner is not enough and leaves the rest
 * alone, which is exactly the case the manifest fallback exists for.
 */
interface FakeApp {
  manifest: AppManifest;
  state: Record<string, unknown>;
  docs: Record<string, string>;
  /** Commands the iframe was actually asked to run, in order, with the params it got. */
  ran: Array<{ command: string; params: unknown }>;
}

/**
 * The memo app as it is *running* — deliberately not the memo app as it is on disk.
 *
 * `apps/memo/dist/protocol.json` declares `memos` and `searchMemos`; this registration
 * declares `drafts` and `pinMemo` as well. So a `describe`/`list` answer carrying `drafts`
 * can only have come from the iframe, and one carrying `searchMemos` can only have come
 * from the disk fallback. Without that asymmetry both sources would produce the same
 * assertion and `source: 'live'` would be untested.
 */
function memoApp(): FakeApp {
  return {
    manifest: {
      appId: 'memo',
      name: 'Memo',
      state: {
        drafts: { description: 'Memos typed but never saved' },
        memos: { description: 'Every saved memo, newest first' },
      },
      commands: {
        pinMemo: {
          description: 'Pin one memo to the top of the list',
          params: {
            type: 'object',
            properties: { id: { type: 'string' }, note: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    },
    state: {
      drafts: [{ id: 'd-1', title: 'half a thought' }],
      memos: [{ id: 'm-1', title: 'buy milk' }],
    },
    // Only `drafts` computes a doc; `memos` and `pinMemo` fall back to the manifest.
    docs: { 'state/drafts': '1 draft, last touched Tuesday. Shape: { id, title }.' },
    ran: [],
  };
}

/** A second app on the same monitor — the window `list` must *not* talk about. */
function storageApp(): FakeApp {
  return {
    manifest: {
      appId: 'storage',
      name: 'Storage',
      state: { cwd: { description: 'The directory being browsed' } },
      commands: { openPath: { description: 'Open a path in the browser pane' } },
    },
    state: { cwd: '/' },
    docs: {},
    ran: [],
  };
}

/**
 * The browser leg, answering the way the injected `iframe-scripts/app-protocol.ts` does.
 *
 * The `describe` branch mirrors that script's three outcomes exactly, because they are the
 * contract `handleAppDescribe` is written against: a key the app does not have is an
 * *error*, a key with no `describe()` is `doc: null` (not an error — the manifest still
 * documents it), and a key with one is the computed string.
 */
function answer(app: FakeApp, request: AppProtocolRequest): AppProtocolResponse {
  switch (request.kind) {
    case 'manifest':
      return { kind: 'manifest', manifest: app.manifest };
    case 'query':
      return { kind: 'query', data: app.state[request.stateKey] };
    case 'command':
      app.ran.push({ command: request.command, params: request.params });
      return { kind: 'command', result: `ran ${request.command}` };
    case 'describe': {
      const table = request.target === 'state' ? app.manifest.state : app.manifest.commands;
      if (!table[request.key]) {
        return {
          kind: 'describe',
          doc: null,
          error: `Unknown ${request.target === 'state' ? 'state key' : 'command'}: ${request.key}.`,
        };
      }
      return { kind: 'describe', doc: app.docs[`${request.target}/${request.key}`] ?? null };
    }
    case 'eval':
      return { kind: 'eval', error: 'The harness apps do not answer eval.' };
  }
}

/** A session holding two registered app windows, and a browser that answers for both. */
async function bootTwoAppWindows() {
  const h = await boot();
  harness = h;

  const memoKey = h.seedIframeWindow('memo');
  const storageKey = h.seedIframeWindow('storage');
  const apps = new Map<string, FakeApp>([
    [memoKey, memoApp()],
    [storageKey, storageApp()],
  ]);

  h.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, async (frame) => {
    const app = apps.get(frame.windowId);
    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: frame.requestId,
      windowId: frame.windowId,
      response: app
        ? answer(app, frame.request)
        : ({ kind: frame.request.kind, error: 'No app in this window.' } as AppProtocolResponse),
    });
  });

  // Registration on the wire, as an iframe does it — `fetchLiveManifest` returns null for a
  // window whose app has not registered, so without these frames every `describe`/`list`
  // below would silently be testing the disk fallback.
  await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: memoKey });
  await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: storageKey });

  // The real window handlers over the real session registry. Only this domain is
  // registered: the behavior under test is `handlers/window.ts`'s, and a registry carrying
  // every other domain would let a routing mistake land somewhere else and look like a pass.
  const registry = new ResourceRegistry();
  registerWindowHandlers(registry, () => h.session.windowState);

  /**
   * Call a verb the way the MCP handler does — inside the caller's agent context, which is
   * where `getWindowState()` finds the session and `getMonitorId()` finds the monitor that
   * turns a raw window id into `"0/memo"`. Every call is budgeted: an unbudgeted await of a
   * call that can park on the app is a test that hangs instead of failing.
   */
  const call = (verb: Verb, uri: string, payload?: Record<string, unknown>): Promise<VerbResult> =>
    expectSettlesWithin(
      runWithAgentContext(
        { agentId: 'harness-app-agent', sessionId: h.sessionId, monitorId: '0' },
        () => registry.execute(verb, uri, payload),
      ),
      1000,
      `${verb}("${uri}")`,
    );

  return { h, call, memo: apps.get(memoKey)!, storage: apps.get(storageKey)! };
}

/** What the model reads: every text block of a result, joined. */
function textOf(result: VerbResult): string {
  return result.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** A JSON result (`okJson`), parsed back out of the text block it rides in. */
function jsonOf(result: VerbResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** The `resource_link` blocks of a list result. */
function linksOf(result: VerbResult): Array<{ uri: string; name: string }> {
  return result.content.filter(
    (block): block is Extract<ContentBlock, { type: 'resource_link' }> =>
      block.type === 'resource_link',
  );
}

/** Command requests that actually reached the browser. */
function commandFrames(h: Harness) {
  return h.client
    .framesOf(ServerEventType.APP_PROTOCOL_REQUEST)
    .filter((frame) => frame.request.kind === 'command');
}

describe('S10 — a window sub-path addresses one state key or one command', () => {
  it('read of a state key returns that key, and says exactly what app_query says', async () => {
    const { call } = await bootTwoAppWindows();

    const viaSubPath = await call('read', 'yaar://windows/memo/state/drafts');
    const viaAction = await call('invoke', 'yaar://windows/memo', {
      action: 'app_query',
      stateKey: 'drafts',
    });

    expect(viaSubPath.isError).toBeUndefined();
    expect(JSON.parse(textOf(viaSubPath))).toEqual([{ id: 'd-1', title: 'half a thought' }]);
    // The sub-path is a spelling of the same call, not a second implementation of it. If
    // these ever diverge, one of the two is answering from somewhere the other is not.
    expect(textOf(viaSubPath)).toBe(textOf(viaAction));
  });

  it('invoke of a command runs it, with the payload as its params', async () => {
    const { h, call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', {
      id: 'm-1',
      note: 'keep this at the top',
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('ran pinMemo');
    // The payload *is* the params — no wrapper on the wire, and nothing dropped from it.
    expect(memo.ran).toEqual([
      { command: 'pinMemo', params: { id: 'm-1', note: 'keep this at the top' } },
    ]);
    expect(commandFrames(h).map((frame) => frame.request)).toEqual([
      { kind: 'command', command: 'pinMemo', params: { id: 'm-1', note: 'keep this at the top' } },
    ]);
  });

  it('timeoutMs is transport, not a param — it steers the deadline and never reaches the app', async () => {
    const { h, call, memo } = await bootTwoAppWindows();

    await call('invoke', 'yaar://windows/memo/commands/pinMemo', { id: 'm-1', timeoutMs: 4000 });

    // The one reserved key. Passed through as a param it would be an undeclared key the
    // real iframe bridge rejects the whole command for, naming a key the caller never
    // meant as a param at all.
    expect(memo.ran).toEqual([{ command: 'pinMemo', params: { id: 'm-1' } }]);
    expect(commandFrames(h)[0]!.timeoutMs).toBe(4000);
  });
});

describe('S10 — the wrong spelling is refused, not guessed at', () => {
  it('a command sub-path takes no "action" — the URI already named the command', async () => {
    const { call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', {
      action: 'app_command',
      command: 'pinMemo',
      params: { id: 'm-1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('the URI already names the');
    // It must also say what *does* work, both spellings: this refusal is read by a model
    // that is one edit away from a working call.
    expect(textOf(result)).toContain('yaar://windows/memo');
    expect(textOf(result)).toContain('app_command');
    // Refused means refused: nothing ran on the way to the error.
    expect(memo.ran).toEqual([]);
  });

  it('a command sub-path takes no "params" wrapper — the payload is params', async () => {
    const { call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', {
      params: { id: 'm-1' },
    });

    // Accepting this would be the second way to write one call, with unclear precedence
    // against the first — so it is refused rather than unwrapped, and the message says
    // which of the two shapes to keep.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('params');
    expect(textOf(result)).toContain('{ …params }');
    expect(memo.ran).toEqual([]);
  });

  it('a command is invoked, not read', async () => {
    const { call } = await bootTwoAppWindows();

    const result = await call('read', 'yaar://windows/memo/commands/pinMemo');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Commands are invoked, not read');
    expect(textOf(result)).toContain('invoke("yaar://windows/memo/commands/pinMemo"');
    // Emphatically *not* the old behavior, where an unimplemented sub-path fell through to
    // the window itself: a read that returns a window screenshot for a URI naming a command
    // is worse than an error, because it looks like it worked.
    expect(textOf(result)).not.toContain('"renderer"');
  });

  it('state is read, not invoked', async () => {
    const { call } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/state/drafts');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('State is read, not invoked');
    // The way to *change* state is a command, and the error points at where they are listed.
    expect(textOf(result)).toContain('list("yaar://windows/memo")');
  });

  it('a sub-path that names neither is refused, never treated as the whole window', async () => {
    const { call } = await bootTwoAppWindows();

    for (const verb of ['describe', 'read', 'list', 'invoke'] as const) {
      const result = await call(verb, 'yaar://windows/memo/nonsense/x');
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('is not a window sub-resource');
      expect(textOf(result)).toContain('yaar://windows/memo/state/{key}');
      expect(textOf(result)).toContain('yaar://windows/memo/commands/{key}');
    }

    // A resource type with no key names no resource either — `state` alone is the
    // collection, and `list` on the window is how that is asked for.
    const bare = await call('read', 'yaar://windows/memo/state');
    expect(bare.isError).toBe(true);
    expect(textOf(bare)).toContain('is not a window sub-resource');
  });
});

describe('S10 — list on a window is that window, not the monitor', () => {
  it("returns this window's own state keys and commands as addressable links", async () => {
    const { call } = await bootTwoAppWindows();

    const result = await call('list', 'yaar://windows/memo');
    const links = linksOf(result);

    // The behavior *change*: this used to ignore the window id and answer with every
    // window on the monitor — which is what `list("yaar://windows")` already says, and
    // which offered the caller no way to discover what a window could be asked.
    expect(links.map((link) => link.uri).sort()).toEqual([
      'yaar://windows/memo/commands/pinMemo',
      'yaar://windows/memo/state/drafts',
      'yaar://windows/memo/state/memos',
    ]);
    expect(links.map((link) => link.name).sort()).toEqual([
      'commands/pinMemo',
      'state/drafts',
      'state/memos',
    ]);

    // The other window is open, on this monitor, and answering — and is still none of this
    // URI's business. (Under the old behavior it was the *whole* answer.)
    const uris = links.map((link) => link.uri).join(' ');
    expect(uris).not.toContain('storage');
    expect(uris).not.toBe('yaar://windows/memo');
  });

  it('the other window answers for itself, from its own manifest', async () => {
    const { call } = await bootTwoAppWindows();

    const links = linksOf(await call('list', 'yaar://windows/storage'));

    // Same session, same monitor, one call apart — so the id in the URI is doing the work,
    // not the session's window list.
    expect(links.map((link) => link.uri).sort()).toEqual([
      'yaar://windows/storage/commands/openPath',
      'yaar://windows/storage/state/cwd',
    ]);
  });
});

describe('S10 — describe answers from the running app', () => {
  it("a live app window's manual is the iframe's manifest, and says so", async () => {
    const { call } = await bootTwoAppWindows();

    const manual = jsonOf(await call('describe', 'yaar://windows/memo'));

    // `source` is the whole point of this field: the disk protocol and the running
    // registration diverge after a deploy without a reload, and a manual that does not say
    // which one it read makes that divergence invisible.
    expect(manual.source).toBe('live');
    expect(manual.uri).toBe('yaar://windows/memo');
    expect(Object.keys(manual.state as object).sort()).toEqual(['drafts', 'memos']);
    expect(Object.keys(manual.commands as object)).toEqual(['pinMemo']);
    // `drafts` exists only in the running registration and `searchMemos` only on disk (see
    // memoApp) — so this pair is what proves the answer came off the wire.
    expect(manual.commands).not.toHaveProperty('searchMemos');
    // Every key carries the sub-path URI this file exists to make real.
    expect((manual.state as Record<string, { uri?: string }>).drafts!.uri).toBe(
      'yaar://windows/memo/state/drafts',
    );
  });

  it('a key the app documents itself answers with the doc it computed', async () => {
    const { call } = await bootTwoAppWindows();

    const doc = jsonOf(await call('describe', 'yaar://windows/memo/state/drafts'));

    expect(doc.uri).toBe('yaar://windows/memo/state/drafts');
    expect(doc.doc).toBe('1 draft, last touched Tuesday. Shape: { id, title }.');
    // Computed by the app, so there is nothing to attribute to the manifest.
    expect(doc.source).toBeUndefined();
  });

  it('a key with no describe() falls back to the manifest, which is a real answer', async () => {
    const { call } = await bootTwoAppWindows();

    const state = jsonOf(await call('describe', 'yaar://windows/memo/state/memos'));
    const command = jsonOf(await call('describe', 'yaar://windows/memo/commands/pinMemo'));

    // Not an error. `protocol.json` already documents every key in one line, so erroring
    // on a key that *is* documented would report a live resource as missing — the same
    // false signal the `exists` hook was added to remove.
    expect(state.isError).toBeUndefined();
    expect(state.doc).toBe('Every saved memo, newest first');
    expect(state.source).toBe('manifest');

    expect(command.doc).toBe('Pin one memo to the top of the list');
    expect(command.source).toBe('manifest');
    // A command's params schema rides along, so one describe is enough to call it.
    expect(command.schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
    });
  });

  it('a key the app does not have is the one genuine error', async () => {
    const { call } = await bootTwoAppWindows();

    const missing = await call('describe', 'yaar://windows/memo/state/nope');

    // The app is the authority on its own table — the server does not second-guess it, and
    // does not fall back to a manifest that (by construction) has nothing to say either.
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('Unknown state key: nope');
  });
});
