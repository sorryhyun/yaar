/**
 * Command params are checked against the descriptor's `params` JSON Schema.
 *
 * The schema is what an agent is shown in the manifest, but nothing used to check a
 * call against it: an undeclared key was dropped in silence and a missing required one
 * arrived as `undefined`. The handler then failed somewhere downstream with a message
 * about its own logic. devtools' `copyFile` called with `{ source, destination }` read
 * `from`/`to` as undefined, found them equal, and reported "Source and destination are
 * the same path" — an error that names neither the keys that were wrong nor the ones
 * that were right, and that reads as a bug in the file layer.
 *
 * The script is ES5 injected into an iframe, so it's exercised the way the browser runs
 * it — evaluated with a stub `window` — rather than pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';

interface Posted {
  type: string;
  requestId?: string;
  result?: unknown;
  error?: string;
}

type Listener = (e: { data: Record<string, unknown> }) => void;

/** Install the protocol script over a stub window, register `commands`, and return a caller. */
function installWith(commands: Record<string, unknown>) {
  const posted: Posted[] = [];
  let listener: Listener = () => {};
  const window = {
    __yaarAppProtocolInstalled: false,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') listener = fn;
    },
  } as Record<string, unknown>;

  new Function('window', IFRAME_APP_PROTOCOL_SCRIPT)(window);
  // The private entry `defineApp` calls; `app.register()` only throws now.
  (window.yaar as { app: { __registerApp: (c: unknown) => void } }).app.__registerApp({
    appId: 'demo',
    name: 'Demo',
    commands,
  });

  return (command: string, params?: Record<string, unknown>): Posted => {
    posted.length = 0;
    listener({
      data: { type: 'yaar:app-command-request', requestId: 'r1', command, params },
    });
    const reply = posted.find((m) => m.type === 'yaar:app-command-response');
    if (!reply) throw new Error('no command response posted');
    return reply;
  };
}

/** devtools' copyFile, reduced to the shape that matters. */
const copyFile = {
  description: 'Copy a file',
  params: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to'],
  },
  handler: (p: { from: string; to: string }) => ({ copied: `${p.from}->${p.to}` }),
};

describe('app command params validation', () => {
  it('runs a well-formed call untouched', () => {
    const call = installWith({ copyFile });
    expect(call('copyFile', { from: 'a.ts', to: 'b.ts' })).toMatchObject({
      result: { copied: 'a.ts->b.ts' },
    });
  });

  it('names the wrong keys AND the right ones, instead of reaching the handler', () => {
    const call = installWith({ copyFile });
    const reply = call('copyFile', { source: 'a.ts', destination: 'b.ts' });
    expect(reply.result).toBeNull();
    expect(reply.error).toContain('unknown param: source, destination');
    expect(reply.error).toContain('missing required param: from, to');
    expect(reply.error).toContain('Accepted params: from, to');
    expect(reply.error).toContain('copyFile');
    // The old symptom must not be what the caller sees.
    expect(reply.error).not.toContain('same path');
  });

  it('reports a required param omitted rather than coercing it to "undefined"', () => {
    const call = installWith({ copyFile });
    const reply = call('copyFile', { from: 'a.ts' });
    expect(reply.error).toContain('missing required param: to');
    expect(reply.error).not.toContain('unknown param');
  });

  it('accepts a declared optional param and an omitted one', () => {
    const call = installWith({
      grep: {
        description: 'search',
        params: {
          type: 'object',
          properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
          required: ['pattern'],
        },
        handler: (p: { pattern: string; glob?: string }) => ({ p: p.pattern, g: p.glob ?? '*' }),
      },
    });
    expect(call('grep', { pattern: 'x', glob: '*.ts' })).toMatchObject({ result: { g: '*.ts' } });
    expect(call('grep', { pattern: 'x' })).toMatchObject({ result: { g: '*' } });
  });

  it('leaves a command with no declared params free-form', () => {
    const call = installWith({
      ping: { description: 'ping', handler: (p: Record<string, unknown>) => ({ got: p }) },
    });
    expect(call('ping', { whatever: 1 })).toMatchObject({ result: { got: { whatever: 1 } } });
    expect(call('ping')).toMatchObject({ result: { got: {} } });
  });

  it('honors additionalProperties: true as the opt-out for a pass-through bag', () => {
    const call = installWith({
      forward: {
        description: 'forward',
        params: {
          type: 'object',
          properties: { target: { type: 'string' } },
          required: ['target'],
          additionalProperties: true,
        },
        handler: (p: Record<string, unknown>) => ({ got: p }),
      },
    });
    expect(call('forward', { target: 't', extra: 1 })).toMatchObject({
      result: { got: { target: 't', extra: 1 } },
    });
    expect(call('forward', { extra: 1 }).error).toContain('missing required param: target');
  });

  it('does not mistake an inherited Object property for a declared param', () => {
    const call = installWith({
      pick: {
        description: 'pick',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        handler: (p: { id: string }) => ({ id: p.id }),
      },
    });
    expect(call('pick', { id: 'a', toString: 'nope' }).error).toContain('unknown param: toString');
  });

  it('suggests the declared key a typo was reaching for', () => {
    const call = installWith({
      extrude: {
        description: 'extrude',
        params: { type: 'object', properties: { thickness: { type: 'number' } } },
        handler: () => ({}),
      },
    });
    expect(call('extrude', { thicknes: 1 }).error).toContain(
      'unknown param: thicknes (did you mean thicknes -> thickness?)',
    );
  });
});

/** Every name a registration of `count` no-op commands would register, `cmd00`..`cmdNN`. */
function manyCommands(count: number, extra: Record<string, unknown> = {}) {
  const commands: Record<string, unknown> = { ...extra };
  for (let i = 0; i < count; i++) {
    commands[`cmd${String(i).padStart(2, '0')}`] = { description: 'n', handler: () => ({}) };
  }
  return commands;
}

describe('unknown command names', () => {
  const noop = { description: 'n', handler: () => ({}) };

  it('suggests the nearest registered command', () => {
    const call = installWith({ undo: noop, redo: noop, extrude: noop });
    const reply = call('undoEdit');
    expect(reply.error).toContain('Unknown command: undoEdit.');
    expect(reply.error).toContain('Did you mean "undo"?');
  });

  it('suggests across a case slip or a one-letter typo', () => {
    const call = installWith({ newMesh: noop, extrude: noop });
    expect(call('newmesh').error).toContain('Did you mean "newMesh"?');
    expect(call('extrud').error).toContain('Did you mean "extrude"?');
  });

  it('offers no suggestion when nothing is close', () => {
    const call = installWith({ undo: noop, extrude: noop });
    expect(call('frobnicate').error).not.toContain('Did you mean');
  });

  it('says how many were cut and where the rest live, past the list cap', () => {
    const call = installWith(manyCommands(63));
    const error = call('nope').error ?? '';
    expect(error).toContain('(23 more of 63 - describe() lists them all)');
    expect(error).not.toContain('cmd40');
  });

  it('suggests a name even when it falls past the list cap', () => {
    const call = installWith(manyCommands(50, { zoomToFit: noop }));
    expect(call('zoomToFt').error).toContain('Did you mean "zoomToFit"?');
  });
});
