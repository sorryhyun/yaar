/**
 * Every advertised action list comes off the table that dispatches it.
 *
 * `defineActions` makes the schema enum and the dispatcher one object, so within a handler
 * they cannot disagree. What these rows pin is the rest: lists *outside* the handler that
 * used to be written by hand — the composite `yaar://apps/*` enum, the app-storage
 * `describe`, `yaar://session/browser`'s enum — and that the tables actually dispatch
 * every name they declare (a name that reaches the "unknown" refusal is the drift this
 * whole mechanism exists to prevent).
 */
import { describe, it, expect } from 'bun:test';
import { defineActions, summarizeActions } from '../handlers/define-actions.js';
import { initRegistry } from '../handlers/index.js';
import { appActions } from '../handlers/apps/app-resource.js';
import { appStorageActions, describeStorage } from '../handlers/apps/storage-resource.js';
import {
  BROWSER_ACTIONS,
  isMutatingAction,
  runBrowserAction,
} from '../features/browser/actions.js';
import type { BrowserProvider } from '../lib/browser/index.js';
import type { VerbResult } from '../lib/verb-result.js';

const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

/** The `invokeSchema.properties.action` the handler registered for `uri` advertises. */
function advertisedActions(uri: string): { enum: string[]; description?: string } {
  const schema = initRegistry().findHandler(uri)?.invokeSchema as
    | { properties: { action: { enum: string[]; description?: string } } }
    | undefined;
  if (!schema) throw new Error(`no invokeSchema registered for ${uri}`);
  return schema.properties.action;
}

describe('defineActions', () => {
  const table = defineActions<number>({
    double: {
      description: 'Twice n.',
      run: (n) => ({ content: [{ type: 'text', text: `${2 * n}` }] }),
    },
    bare: () => ({ content: [{ type: 'text', text: 'bare' }] }),
  });

  it('derives the enum from the table, in declaration order', () => {
    expect(table.schema.enum).toEqual(['double', 'bare']);
    expect(table.names).toEqual(['double', 'bare']);
  });

  it('dispatches a declared action and refuses an undeclared one by listing the table', async () => {
    expect(text(await table.dispatch('double', 21))).toBe('42');
    const refused = await table.dispatch('triple', 1);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('Unknown action "triple". Supported: double, bare.');
  });

  it('does not treat prototype keys as actions', async () => {
    expect(table.has('constructor')).toBe(false);
    expect((await table.dispatch('toString', 1)).isError).toBe(true);
  });

  it('summarizes only the documented entries', () => {
    expect(summarizeActions(table)).toBe('double: Twice n.');
  });
});

describe('app storage actions', () => {
  it('are what the composite yaar://apps/* schema offers after the app-level ones', async () => {
    const advertised = advertisedActions('yaar://apps/notes');
    expect(advertised.enum).toEqual([...appActions.names, ...appStorageActions.names]);
    for (const name of appStorageActions.names) expect(advertised.description).toContain(name);
  });

  it('are what the storage root describes', async () => {
    const r = await describeStorage('yaar://apps/notes/storage/');
    const described = JSON.parse(text(r!)) as { invokeActions: Record<string, string> };
    expect(Object.keys(described.invokeActions)).toEqual(appStorageActions.names);
  });

  it('each reaches a case — none falls through to the unknown refusal', async () => {
    const { invokeStorage } = await import('../handlers/apps/storage-resource.js');
    const resolved = { sourceUri: 'yaar://apps/notes/storage/' } as Parameters<
      typeof invokeStorage
    >[0];
    for (const action of appStorageActions.names) {
      const r = await invokeStorage(resolved, { action, pattern: 'x' });
      expect(text(r!)).not.toContain('Unknown storage action');
    }
    const unknown = await invokeStorage(resolved, { action: 'edit' });
    expect(text(unknown!)).toContain('Unknown storage action "edit"');
  });
});

describe('browser actions', () => {
  it('are what yaar://session/browser advertises', async () => {
    expect(advertisedActions('yaar://session/browser').enum).toEqual(BROWSER_ACTIONS);
  });

  it('are all dispatched — an undeclared name is refused before any provider is touched', async () => {
    const r = await runBrowserAction({} as BrowserProvider, 'bogus', '0', {});
    expect(text(r)).toBe('Unknown action "bogus".');
    expect(isMutatingAction('__proto__')).toBe(false);
  });
});

describe('handlers whose enum used to be hand-written beside a switch', () => {
  const cases: Array<[uri: string, names: string[]]> = [
    ['yaar://session/agents/session', ['interrupt', 'relay', 'audit', 'coordinate', 'query']],
    ['yaar://session/monitors/0', ['suspend', 'resume', 'interrupt']],
    ['yaar://mcp', ['add', 'remove', 'reload', 'refresh']],
  ];

  for (const [uri, names] of cases) {
    it(`${uri} still advertises the same actions, each documented`, async () => {
      const advertised = advertisedActions(uri);
      expect(advertised.enum).toEqual(names);
      for (const name of names) expect(advertised.description).toContain(`${name}: `);
    });
  }
});
