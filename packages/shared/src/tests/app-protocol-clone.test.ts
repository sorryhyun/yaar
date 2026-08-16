/**
 * A reply the structured clone algorithm refuses is recovered, not lost.
 *
 * A value read off a solid-js store is a Proxy, and clone runs over internal slots
 * rather than proxy traps — so returning store state from a state getter or a
 * command handler, the obvious thing to write, always failed with
 * "[object Object] could not be cloned": no field, no key, no path. Three bundled
 * apps grew their own hand-maintained plain-copy helper against it (session-logs'
 * `toPlain`, search's rebuild-from-primitives, dc-comics' `plainVerdict`).
 *
 * The recovery lives on the throw path on purpose: a payload that already clones
 * pays nothing, and the Dates/Maps/typed arrays that cross fine today are not
 * downgraded by a blanket JSON round-trip.
 *
 * The script is ES5 injected into an iframe, so it's exercised the way the browser
 * runs it — evaluated with a stub `window` — rather than pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';

interface Posted {
  type: string;
  requestId?: string;
  data?: unknown;
  result?: unknown;
  error?: string;
}

type Listener = (e: { data: Record<string, unknown> }) => void;

interface Harness {
  query: (stateKey: string) => Posted;
  command: (command: string, params?: Record<string, unknown>) => Posted;
  warnings: string[];
}

/**
 * Install the protocol script over a stub window whose `postMessage` refuses
 * whatever structured clone refuses — which is what the real one does.
 */
function install(config: {
  state?: Record<string, unknown>;
  commands?: Record<string, unknown>;
}): Harness {
  const posted: Posted[] = [];
  const warnings: string[] = [];
  let listener: Listener = () => {};
  const window = {
    __yaarAppProtocolInstalled: false,
    parent: {
      postMessage: (msg: Posted) => {
        structuredClone(msg);
        posted.push(msg);
      },
    },
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') listener = fn;
    },
    console: { warn: (m: string) => warnings.push(m) },
  } as Record<string, unknown>;

  new Function('window', 'console', 'structuredClone', IFRAME_APP_PROTOCOL_SCRIPT)(
    window,
    window.console,
    structuredClone,
  );
  (window.yaar as { app: { __registerApp: (c: unknown) => void } }).app.__registerApp({
    appId: 'demo',
    name: 'Demo',
    state: config.state ?? {},
    commands: config.commands ?? {},
  });

  const send = (data: Record<string, unknown>, want: string): Posted => {
    posted.length = 0;
    listener({ data });
    const reply = posted.find((m) => m.type === want);
    if (!reply) throw new Error('no ' + want + ' posted');
    return reply;
  };

  return {
    query: (stateKey) =>
      send(
        { type: 'yaar:app-query-request', requestId: 'r1', stateKey },
        'yaar:app-query-response',
      ),
    command: (command, params) =>
      send(
        { type: 'yaar:app-command-request', requestId: 'r1', command, params },
        'yaar:app-command-response',
      ),
    warnings,
  };
}

/** What `createStore` hands back: a proxy that reads through, and clone refuses. */
function storeProxy<T extends object>(target: T): T {
  return new Proxy(target, { get: (t, k) => Reflect.get(t, k) });
}

describe('app protocol replies that structured clone refuses', () => {
  it('delivers a solid store proxy as plain data instead of failing', () => {
    const store = storeProxy({ title: 'Bait', tags: ['a', 'b'], meta: { score: 3 } });
    const reply = install({
      state: { verdict: { description: 'The verdict', handler: () => store } },
    }).query('verdict');

    expect(reply.error).toBeUndefined();
    expect(reply.data).toEqual({ title: 'Bait', tags: ['a', 'b'], meta: { score: 3 } });
  });

  it('unwraps a proxy nested inside an otherwise plain result', () => {
    const rows = [storeProxy({ id: 1 }), storeProxy({ id: 2 })];
    const reply = install({
      commands: { list: { description: 'List', handler: () => ({ ok: true, rows }) } },
    }).command('list');

    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ ok: true, rows: [{ id: 1 }, { id: 2 }] });
  });

  it('keeps the values clone carries natively rather than JSON-flattening them', () => {
    const when = new Date('2026-08-16T00:00:00.000Z');
    const bytes = new Uint8Array([1, 2, 3]);
    const reply = install({
      state: {
        snapshot: {
          description: 'Snapshot',
          handler: () => storeProxy({ when, bytes, seen: new Set(['x']) }),
        },
      },
    }).query('snapshot');

    const data = reply.data as { when: Date; bytes: Uint8Array; seen: Set<string> };
    expect(data.when).toBeInstanceOf(Date);
    expect(data.when.toISOString()).toBe('2026-08-16T00:00:00.000Z');
    expect(data.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(data.bytes)).toEqual([1, 2, 3]);
    expect(data.seen).toBeInstanceOf(Set);
    expect(Array.from(data.seen)).toEqual(['x']);
  });

  it('preserves a cycle rather than blowing the stack on it', () => {
    const node: Record<string, unknown> = { name: 'root' };
    const proxied = storeProxy(node);
    node.self = proxied;
    const reply = install({
      state: { tree: { description: 'Tree', handler: () => proxied } },
    }).query('tree');

    const data = reply.data as { name: string; self: unknown };
    expect(data.name).toBe('root');
    expect(data.self).toBe(data);
  });

  it('drops what cannot cross at all, and says which field it dropped', () => {
    const harness = install({
      commands: {
        handle: {
          description: 'Handle',
          handler: () => ({ ok: true, onDone: () => {} }),
        },
      },
    });
    const reply = harness.command('handle');

    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ ok: true, onDone: undefined });
    expect(harness.warnings.join('\n')).toContain('result.onDone (function)');
  });

  it('names the offending path when the value cannot be recovered either', () => {
    // A proxy around a Date passes `instanceof Date`, so the copy hands it through
    // as a built-in clone carries — and clone still refuses it. Whatever the reason,
    // the reply has to say *where* it was instead of repeating a message that names
    // nothing.
    const hostile = new Proxy(new Date('2026-08-16T00:00:00.000Z'), {});
    const reply = install({
      state: { broken: { description: 'Broken', handler: () => ({ inner: hostile }) } },
    }).query('broken');

    expect(reply.data).toBeNull();
    expect(reply.error).toContain('data.inner');
    expect(reply.error).toContain('DataCloneError');
  });

  it('leaves an already-cloneable reply untouched', () => {
    const reply = install({
      state: { plain: { description: 'Plain', handler: () => ({ a: 1, b: [2, 3] }) } },
    }).query('plain');

    expect(reply.error).toBeUndefined();
    expect(reply.data).toEqual({ a: 1, b: [2, 3] });
  });
});
