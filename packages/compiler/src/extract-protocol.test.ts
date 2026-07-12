import { describe, expect, test } from 'bun:test';
import { extractProtocolFromSource } from './extract-protocol.js';

/**
 * The manifest that reaches the agent is built twice from the same source: once
 * at build time by this extractor (→ `dist/protocol.json`), once at runtime by
 * `app.register()` in the iframe. `defineCommand` is an identity function, so
 * the runtime path is unaffected by it — these tests exist to keep the build-time
 * path in step, i.e. wrapping a descriptor must not change what is extracted.
 */

const PLAIN = `
import { app } from '@bundled/yaar';
app.register({
  appId: 'demo',
  name: 'Demo',
  state: {
    tabs: {
      description: 'Open tabs',
      handler: () => tabs(),
      schema: { type: 'array', items: { type: 'number' } },
    },
  },
  commands: {
    focus: {
      description: 'Focus a tab',
      aliases: ['activate'],
      params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
      returns: { type: 'boolean' },
      handler: (p: { tabId: number }) => bridge.focus(p.tabId),
    },
    'close-all': {
      description: 'Close every tab',
      handler: () => bridge.closeAll(),
    },
  },
  events: {
    navigated: { description: 'Fires after a tab navigates' },
  },
});
`;

const WRAPPED = `
import { app, defineCommand } from '@bundled/yaar';
app.register({
  appId: 'demo',
  name: 'Demo',
  state: {
    tabs: {
      description: 'Open tabs',
      handler: () => tabs(),
      schema: { type: 'array', items: { type: 'number' } },
    },
  },
  commands: {
    focus: defineCommand({
      description: 'Focus a tab',
      aliases: ['activate'],
      params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
      returns: { type: 'boolean' },
      handler: (p) => bridge.focus(p.tabId),
    }),
    'close-all': defineCommand({
      description: 'Close every tab',
      handler: () => bridge.closeAll(),
    }),
  },
  events: {
    navigated: { description: 'Fires after a tab navigates' },
  },
});
`;

describe('extractProtocolFromSource', () => {
  test('extracts state, commands, aliases, params, returns and events', () => {
    expect(extractProtocolFromSource(PLAIN)).toEqual({
      state: {
        tabs: { description: 'Open tabs', schema: { type: 'array', items: { type: 'number' } } },
      },
      commands: {
        focus: {
          description: 'Focus a tab',
          aliases: ['activate'],
          params: {
            type: 'object',
            properties: { tabId: { type: 'number' } },
            required: ['tabId'],
          },
          returns: { type: 'boolean' },
        },
        'close-all': { description: 'Close every tab' },
      },
      events: { navigated: { description: 'Fires after a tab navigates' } },
    });
  });

  test('a defineCommand wrapper extracts identically to a plain literal', () => {
    expect(extractProtocolFromSource(WRAPPED)).toEqual(extractProtocolFromSource(PLAIN)!);
  });

  test('sees through a wrapper carrying explicit type arguments', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: {
        run: defineCommand<Params, void>({ description: 'Run it', handler: () => go() }),
        stop: { description: 'Stop it', handler: () => halt() },
      },
    });`;
    expect(extractProtocolFromSource(source)?.commands).toEqual({
      run: { description: 'Run it' },
      stop: { description: 'Stop it' },
    });
  });

  test('a wrapped command does not swallow the commands that follow it', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: {
        first: defineCommand({
          description: 'First',
          params: { type: 'object', properties: { n: { type: 'number' } } },
          handler: (p) => p.n,
        }),
        second: defineCommand({ description: 'Second', handler: () => 2 }),
        third: { description: 'Third', handler: () => 3 },
      },
    });`;
    const commands = extractProtocolFromSource(source)?.commands ?? {};
    expect(Object.keys(commands)).toEqual(['first', 'second', 'third']);
  });

  test('joins a description split across concatenated literals', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: {
        screenshot: defineCommand({
          description:
            'Capture a screenshot of a real tab. ' +
            'The tab must be focused first (see \\'focus\\'). ' +
            'May prompt per-origin consent.',
          handler: () => shoot(),
        }),
      },
    });`;
    expect(extractProtocolFromSource(source)?.commands.screenshot.description).toBe(
      "Capture a screenshot of a real tab. The tab must be focused first (see \\'focus\\'). May prompt per-origin consent.",
    );
  });

  test('concatenation stops at the first non-literal operand', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: {
        run: { description: 'Run ' + verb + ' now', handler: () => go() },
      },
    });`;
    expect(extractProtocolFromSource(source)?.commands.run.description).toBe('Run ');
  });

  test('a lone literal description is unaffected', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: { run: { description: 'Run it', handler: () => go() } },
    });`;
    expect(extractProtocolFromSource(source)?.commands.run.description).toBe('Run it');
  });

  test('normalizes comments, trailing commas and quotes in alias arrays', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: {
        run: {
          description: 'Run it',
          aliases: [
            'say "go"',
            'don\\'t stop',
            // Kept readable for app authors.
            "finish",
          ],
          handler: () => go(),
        },
      },
    });`;
    expect(extractProtocolFromSource(source)?.commands.run.aliases).toEqual([
      'say "go"',
      "don't stop",
      'finish',
    ]);
  });

  test('returns null when there is no register call', () => {
    expect(extractProtocolFromSource('export const x = 1;')).toBeNull();
  });
});
