import { describe, expect, test } from 'bun:test';
import {
  extractProtocolFromSource,
  extractProtocolWithDiagnostics,
  isBlockingProtocolWarning,
} from '../extract-protocol.js';

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

/**
 * The parser stops on the first entry it cannot read — a spread, computed key,
 * shorthand — and everything after that point silently vanishes from the
 * manifest. One real incident took an app from 29 commands to 3 with every
 * other signal green. Diagnostics turn that silence into warnings.
 */
describe('extractProtocolWithDiagnostics', () => {
  const SPREAD_MID = `app.register({
    appId: 'a', name: 'A', state: {},
    commands: {
      first: { description: 'First', handler: () => 1 },
      second: { description: 'Second', handler: () => 2 },
      ...sharedCommands,
      third: { description: 'Third', handler: () => 3 },
    },
  });`;

  test('a spread inside commands warns and keeps the parsed prefix', () => {
    const { protocol, warnings } = extractProtocolWithDiagnostics(SPREAD_MID);
    expect(Object.keys(protocol?.commands ?? {})).toEqual(['first', 'second']);
    expect(warnings).toHaveLength(1);
    const warning = warnings[0];
    // Names the section, the blocker, the parsed count, and the consequence.
    expect(warning).toStartWith('commands:');
    expect(warning).toContain('spread');
    expect(warning).toContain('2 entries were parsed');
    expect(warning).toContain('dropped');
    expect(isBlockingProtocolWarning(warning)).toBe(true);
  });

  test('a non-spread blocker quotes a snippet of the offending token', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: {
        first: { description: 'First', handler: () => 1 },
        [dynamicName]: { description: 'Computed', handler: () => 2 },
      },
    });`;
    const { protocol, warnings } = extractProtocolWithDiagnostics(source);
    expect(Object.keys(protocol?.commands ?? {})).toEqual(['first']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith('commands:');
    expect(warnings[0]).toContain('[dynamicName]');
  });

  test('a blocked state section warns with the state section name', () => {
    const source = `app.register({
      appId: 'a', name: 'A',
      state: {
        tabs: { description: 'Tabs', handler: () => [] },
        ...extraState,
      },
      commands: { run: { description: 'Run', handler: () => 0 } },
    });`;
    const { protocol, warnings } = extractProtocolWithDiagnostics(source);
    expect(Object.keys(protocol?.state ?? {})).toEqual(['tabs']);
    expect(Object.keys(protocol?.commands ?? {})).toEqual(['run']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith('state:');
  });

  test('an events-only warning is not blocking', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: { run: { description: 'Run', handler: () => 0 } },
      events: {
        navigated: { description: 'Navigated' },
        ...extraEvents,
      },
    });`;
    const { warnings } = extractProtocolWithDiagnostics(source);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith('events:');
    expect(isBlockingProtocolWarning(warnings[0])).toBe(false);
  });

  test('a spread as the first commands entry warns even though nothing parsed', () => {
    const source = `app.register({
      appId: 'a', name: 'A', state: {},
      commands: {
        ...sharedCommands,
        first: { description: 'First', handler: () => 1 },
      },
    });`;
    const { protocol, warnings } = extractProtocolWithDiagnostics(source);
    expect(protocol).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith('commands:');
    expect(warnings[0]).toContain('0 entries were parsed');
  });

  test('clean extraction yields no warnings', () => {
    expect(extractProtocolWithDiagnostics(PLAIN).warnings).toEqual([]);
    expect(extractProtocolWithDiagnostics(WRAPPED).warnings).toEqual([]);
  });

  test('no register call yields null protocol and no warnings', () => {
    expect(extractProtocolWithDiagnostics('export const x = 1;')).toEqual({
      protocol: null,
      warnings: [],
    });
  });

  test('extractProtocolFromSource delegates — same parsed prefix, no throw', () => {
    expect(Object.keys(extractProtocolFromSource(SPREAD_MID)?.commands ?? {})).toEqual([
      'first',
      'second',
    ]);
  });
});
