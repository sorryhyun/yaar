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
import type {
  AppManifest,
  AppProtocolRequest,
  AppProtocolResponse,
  OSAction,
  WindowCaptureAction,
} from '@yaar/shared';
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
        // A command that declares two of the three names the sub-path spelling reserves.
        // Not hypothetical: `studio-3d.setGeometryParams(id, params, points)` was
        // unreachable through this URI and `devtools.previewEval(expression, timeoutMs)`
        // had its `timeoutMs` silently eaten as the transport deadline. Both of those
        // ship in the tree; this is their shape.
        applyStyle: {
          description: 'Apply a named style with its own params',
          params: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              params: { type: 'object' },
              timeoutMs: { type: 'number' },
            },
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
    case 'command': {
      // One id the app refuses, so a batch has something real to stop at. An app that
      // never fails would let a batch's stop-at-first-failure rule pass vacuously.
      const params = request.params as { id?: unknown } | undefined;
      if (params?.id === 'boom') {
        return { kind: 'command', result: null, error: `No memo "boom".` };
      }
      app.ran.push({ command: request.command, params: request.params });
      return { kind: 'command', result: `ran ${request.command}` };
    }
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

/** The pixels the fake frontend answers a `window.capture` with. */
const CAPTURED = 'Y2FwdHVyZWQtcGl4ZWxz';

/**
 * Answer window captures the way the browser does — over `RENDERING_FEEDBACK`, keyed by the
 * `requestId` the action carries. Without this the capture waits out its own 5s deadline,
 * which is the difference between a test that asserts a screenshot and one that asserts a
 * timeout that happens to look the same from the outside.
 */
function answerCaptures(h: Harness): void {
  h.client.onFrame(ServerEventType.ACTIONS, async (frame) => {
    for (const action of frame.actions) {
      if (action.type !== 'window.capture') continue;
      const capture = action as WindowCaptureAction;
      if (!capture.requestId) continue;
      await h.client.deliver({
        type: ClientEventType.RENDERING_FEEDBACK,
        requestId: capture.requestId,
        windowId: capture.windowId,
        renderer: 'capture',
        success: true,
        imageData: CAPTURED,
      });
    }
  });
}

/**
 * A window with no app in it, seeded the way an agent's `window.create` does.
 *
 * The interesting case for the built-in state keys: there is no iframe to ask, so anything
 * this window can answer, the OS is answering.
 */
function seedMarkdownWindow(h: Harness, rawId: string, body: string): string {
  h.session.windowState.handleAction(
    {
      type: 'window.create',
      windowId: rawId,
      title: rawId,
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      content: { renderer: 'markdown', data: body },
    } as OSAction,
    '0',
  );
  return h.session.windowState.getWindow(rawId)?.id ?? `0/${rawId}`;
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
  const call = (
    verb: Verb,
    uri: string,
    payload?: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<VerbResult> =>
    expectSettlesWithin(
      runWithAgentContext(
        { agentId: 'harness-app-agent', sessionId: h.sessionId, monitorId: '0' },
        () => registry.execute(verb, uri, payload),
      ),
      2000,
      `${verb}("${uri}")`,
    );

  /**
   * The same call, but inside a real turn — which is what a `window.capture` needs.
   *
   * An emitted OS Action only reaches the browser through `ToolActionBridge`, and that is
   * installed per turn. A capture asserted from a bare `call()` would be asserting the
   * timeout path with extra steps: the frame never goes out, so nothing can answer it.
   */
  const callInTurn = async (verb: Verb, uri: string): Promise<VerbResult> => {
    h.registry.onTurn(() => [
      { kind: 'tool', name: `${verb}(${uri})`, run: () => registry.execute(verb, uri) },
    ]);
    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.USER_MESSAGE,
        messageId: `m-${h.registry.turns.length}`,
        monitorId: '0',
        content: `${verb} ${uri}`,
      }),
      2000,
      `the turn running ${verb}("${uri}")`,
    );
    return h.registry.tools.at(-1)!.result as VerbResult;
  };

  return { h, call, callInTurn, memo: apps.get(memoKey)!, storage: apps.get(storageKey)! };
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

/** A JSON result that rides in an embedded resource block (`okJsonResource`) instead. */
function resourceJsonOf(result: VerbResult): Record<string, unknown> {
  const block = result.content.find((b) => b.type === 'resource');
  if (block?.type !== 'resource' || !('text' in block.resource)) {
    throw new Error(`no embedded resource in result: ${JSON.stringify(result.content)}`);
  }
  return JSON.parse(block.resource.text) as Record<string, unknown>;
}

/** The `resource_link` blocks of a list result. */
function linksOf(result: VerbResult): Array<{ uri: string; name: string; description?: string }> {
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

describe('S10 — a reserved key belongs to the command that declares it', () => {
  it('`params` reaches a command that declares one, instead of being refused as a wrapper', async () => {
    const { call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/applyStyle', {
      id: 'm-1',
      params: { color: 'red' },
    });

    // The refusal used to fire on the key *name*, so every command whose own schema
    // declares `params` was unreachable through this spelling — the caller's only way out
    // was the { action: 'app_command' } form, for every subsequent call in the session.
    expect(result.isError).toBeUndefined();
    expect(memo.ran).toEqual([
      { command: 'applyStyle', params: { id: 'm-1', params: { color: 'red' } } },
    ]);
  });

  it('a declared `timeoutMs` is passed to the app *and* steers the deadline', async () => {
    const { h, call, memo } = await bootTwoAppWindows();

    await call('invoke', 'yaar://windows/memo/commands/applyStyle', { id: 'm-1', timeoutMs: 4000 });

    // The silent half of the bug: `timeoutMs` was deleted from the payload and used as the
    // transport deadline, so a command that declares one (devtools' previewEval) was told
    // nothing and no error was raised. It is now both — the app learns how long it may
    // take, and the server does not cut off a wait it just authorized.
    expect(memo.ran).toEqual([{ command: 'applyStyle', params: { id: 'm-1', timeoutMs: 4000 } }]);
    expect(commandFrames(h)[0]!.timeoutMs).toBe(4000);
  });

  it('the reservation still holds for a command that declares nothing of the kind', async () => {
    const { call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', {
      params: { id: 'm-1' },
    });

    // The schema is what decides, so the same payload is refused here and accepted above.
    // Guessing in the app's favour would send an undeclared key to a bridge that rejects
    // the whole command for it.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('declares no param of that name');
    expect(memo.ran).toEqual([]);
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

describe('S10 — one URI, many payloads', () => {
  it('runs the command once per element, in order, as one call', async () => {
    const { h, call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', [
      { id: 'm-1' },
      { id: 'm-2', note: 'second' },
      { id: 'm-3' },
    ]);

    // The axis brace expansion does not cover: one resource, a different payload each
    // time. Authoring a scene took one `addNodes`; the forty follow-up tweaks that each
    // nudged one node took forty calls, because no two payloads were the same.
    expect(result.isError).toBeUndefined();
    expect(memo.ran).toEqual([
      { command: 'pinMemo', params: { id: 'm-1' } },
      { command: 'pinMemo', params: { id: 'm-2', note: 'second' } },
      { command: 'pinMemo', params: { id: 'm-3' } },
    ]);
    // Ordered *and* sequential: these are edits to one resource, so overlapping them
    // would make the result depend on scheduling.
    expect(
      commandFrames(h).map((frame) =>
        frame.request.kind === 'command' ? (frame.request.params as { id: string }).id : null,
      ),
    ).toEqual(['m-1', 'm-2', 'm-3']);
    expect(textOf(result)).toContain('Batch complete: 3 of 3.');
  });

  it('stops at the first failure and names the index to resume from', async () => {
    const { call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', [
      { id: 'm-1' },
      { id: 'boom' },
      { id: 'm-3' },
    ]);

    // The conservative reading of "in order": payload 3 was written for a state payload 2
    // was supposed to produce. Running it anyway would edit a resource nobody asked to
    // edit — so the remainder is reported as not attempted, with the index to resend from.
    expect(result.isError).toBe(true);
    expect(memo.ran).toEqual([{ command: 'pinMemo', params: { id: 'm-1' } }]);
    expect(textOf(result)).toContain('No memo "boom"');
    expect(textOf(result)).toContain('Batch stopped at [1] of 3');
    expect(textOf(result)).toContain('resend from [1]');
  });

  it('each element is checked exactly as a lone invoke is', async () => {
    const { call, memo } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', [
      { id: 'm-1' },
      { params: { id: 'm-2' } },
    ]);

    // A batch is a spelling, never a bypass: the second element meets the same
    // reserved-key refusal it would have met on its own.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('declares no param of that name');
    expect(memo.ran).toEqual([{ command: 'pinMemo', params: { id: 'm-1' } }]);
  });

  it('an empty batch is an error, not a silent success', async () => {
    const { call } = await bootTwoAppWindows();

    const result = await call('invoke', 'yaar://windows/memo/commands/pinMemo', []);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('nothing to do');
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
    //
    // The window's own keys come first and the app's follow, because the answer is "what is
    // addressable under this URI" — and three of those keys are the window's, not the app's.
    expect(links.map((link) => link.uri)).toEqual([
      'yaar://windows/memo/state/__content',
      'yaar://windows/memo/state/__screenshot',
      'yaar://windows/memo/state/__console',
      'yaar://windows/memo/state/drafts',
      'yaar://windows/memo/state/memos',
      'yaar://windows/memo/commands/pinMemo',
      'yaar://windows/memo/commands/applyStyle',
    ]);
    expect(links.map((link) => link.name)).toContain('commands/pinMemo');

    // The other window is open, on this monitor, and answering — and is still none of this
    // URI's business. (Under the old behavior it was the *whole* answer.)
    const uris = links.map((link) => link.uri).join(' ');
    expect(uris).not.toContain('storage');
    expect(uris).not.toBe('yaar://windows/memo');
  });

  it('a command link carries its signature, so the list is enough to call from', async () => {
    const { call } = await bootTwoAppWindows();

    const links = linksOf(await call('list', 'yaar://windows/memo'));
    const pin = links.find((link) => link.name === 'commands/pinMemo')!;
    const open = linksOf(await call('list', 'yaar://windows/storage')).find(
      (link) => link.name === 'commands/openPath',
    )!;

    // `list` is the door an agent reaches for first, and a bare name is not enough to
    // call with — the round trip it saves is a `describe` spent only on param names.
    expect(pin.description).toBe(
      'pinMemo(id: string, note?: string) — Pin one memo to the top of the list',
    );
    // A command that declares no schema is left alone rather than rendered as `name()`,
    // which would document a command that takes params as one that takes none.
    expect(open.description).toBe('Open a path in the browser pane');
  });

  it('the other window answers for itself, from its own manifest', async () => {
    const { call } = await bootTwoAppWindows();

    const links = linksOf(await call('list', 'yaar://windows/storage'));

    // Same session, same monitor, one call apart — so the id in the URI is doing the work,
    // not the session's window list.
    expect(links.map((link) => link.uri).filter((uri) => !uri.includes('/__'))).toEqual([
      'yaar://windows/storage/state/cwd',
      'yaar://windows/storage/commands/openPath',
    ]);
  });
});

describe('S10 — every window has state of its own, whatever it renders', () => {
  it('a window with no app lists its own keys rather than failing', async () => {
    const { call, h } = await bootTwoAppWindows();
    seedMarkdownWindow(h, 'notes', '# Notes');

    const result = await call('list', 'yaar://windows/notes');

    // This used to be an error: "it has no protocol, so nothing under it is addressable".
    // But `list` is asked what is addressable under *this window*, and the answer for a
    // markdown window is its content — not a complaint about the app it never had. An
    // existing container with no children is an empty list; this one is not even empty.
    expect(result.isError).toBeUndefined();
    expect(linksOf(result).map((link) => link.uri)).toEqual([
      'yaar://windows/notes/state/__content',
    ]);
    // The two that need an iframe are absent rather than listed-and-broken.
    expect(textOf(result)).toContain('markdown window');
  });

  it('reads its content with no app, no capture, and no round trip', async () => {
    const { call, h } = await bootTwoAppWindows();
    seedMarkdownWindow(h, 'notes', '# Notes\n\nbuy milk');

    const before = h.client.framesOf(ServerEventType.APP_PROTOCOL_REQUEST).length;
    const content = resourceJsonOf(await call('read', 'yaar://windows/notes/state/__content'));

    expect(content.renderer).toBe('markdown');
    expect(content.content).toBe('# Notes\n\nbuy milk');
    // Answered from the registry. A markdown window has no iframe to ask, so a built-in that
    // fell through to the app path would sit out the readiness deadline and then refuse.
    expect(h.client.framesOf(ServerEventType.APP_PROTOCOL_REQUEST).length).toBe(before);
  });

  it('refuses the two built-ins that need an iframe, and says which window it is', async () => {
    const { call, h } = await bootTwoAppWindows();
    seedMarkdownWindow(h, 'notes', '# Notes');

    const shot = await call('read', 'yaar://windows/notes/state/__screenshot');

    // Not listed, not described, so reading it is a genuine "no such resource" — the rule
    // that a *missing* thing is an error is what makes the empty-ish list above safe.
    expect(shot.isError).toBe(true);
    expect(textOf(shot)).toContain('needs an iframe');
    expect(textOf(shot)).toContain('markdown window');
  });

  it('documents its built-ins itself, without asking the app', async () => {
    const { call } = await bootTwoAppWindows();

    const doc = jsonOf(await call('describe', 'yaar://windows/memo/state/__content'));

    // `source: 'window'` beside the app's `'manifest'`/computed docs: the memo app has never
    // heard of `__content` and would answer "Unknown state key" for it, which would report a
    // live resource as missing.
    expect(doc.source).toBe('window');
    expect(String(doc.doc)).toContain('no capture');
  });
});

describe('S10 — a bare read of an app window is __content + __screenshot', () => {
  it('returns the screenshot and says where the content went', async () => {
    const { callInTurn, h } = await bootTwoAppWindows();
    answerCaptures(h);

    const result = await callInTurn('read', 'yaar://windows/memo');
    const image = result.content.find((block) => block.type === 'image');
    const meta = resourceJsonOf(result);

    expect(image).toEqual({ type: 'image', data: CAPTURED, mimeType: 'image/webp' });
    // The composition used to be silent: `content` was dropped whenever a capture happened to
    // succeed, so the shape of "the window's current value" depended on whether the frontend
    // answered in time, and the dropped half was addressable by nothing.
    expect(meta.content).toBeUndefined();
    expect(String(meta.contentOmitted)).toContain('yaar://windows/memo/state/__content');
  });

  it('the screenshot is separately addressable, and is the same capture', async () => {
    const { callInTurn, h } = await bootTwoAppWindows();
    answerCaptures(h);

    const result = await callInTurn('read', 'yaar://windows/memo/state/__screenshot');

    expect(result.content).toEqual([{ type: 'image', data: CAPTURED, mimeType: 'image/webp' }]);
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
    expect(Object.keys(manual.commands as object)).toEqual(['pinMemo', 'applyStyle']);
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

  it('a command says how it is called, not only what it does', async () => {
    const { call } = await bootTwoAppWindows();

    const doc = jsonOf(await call('describe', 'yaar://windows/memo/commands/pinMemo'));

    // The two questions that were being guessed — what is this called, and what shape is
    // it — answered without a second call. The example carries the literal param names,
    // which is the part prose cannot do: "the payload *is* `params`" reads as a ban on a
    // payload containing a key called `params`.
    expect(doc.signature).toBe('pinMemo(id: string, note?: string)');
    expect(doc.invoke).toBe(
      'invoke("yaar://windows/memo/commands/pinMemo", { id: <string>, note?: <string> })',
    );
    // A command with no name collision earns no note.
    expect(doc.note).toBeUndefined();
  });

  it('a command that declares a reserved name says so, in its own describe', async () => {
    const { call } = await bootTwoAppWindows();

    const doc = jsonOf(await call('describe', 'yaar://windows/memo/commands/applyStyle'));

    expect(doc.signature).toBe('applyStyle(id: string, params?: object, timeoutMs?: number)');
    expect(String(doc.invoke)).toContain('params?: <object>');
    // The note exists for exactly the reader who has just been told the payload *is*
    // `params` and is holding a command whose params include one.
    expect(String(doc.note)).toContain('`params`');
    expect(String(doc.note)).toContain('`timeoutMs`');
    expect(String(doc.note)).toContain('inline');
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
