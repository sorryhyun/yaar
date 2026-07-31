/**
 * describe = the manual. read = the current value. list = what's addressable.
 *
 * Three of those were false for apps and windows, and each falsehood had the same
 * shape: a verb that answered confidently about something it had not looked at.
 * `describe` answered about the URI *pattern*, so a typo'd id and a live resource
 * produced byte-identical successes. `read('yaar://apps/{id}')` returned a generated
 * reference doc — the same *kind* of thing `describe` returned, which is why the
 * monitor prompt could only offer "read **or** describe". And `list` on a storage path
 * that did not exist returned an empty collection.
 *
 * These rows are the unit-testable half (Phases 0, 1 and 1b). The window sub-paths
 * exercise a real iframe round trip and live in `tests/loopback/`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { initRegistry } from '../handlers/index.js';
import type { VerbResult, Verb } from '../handlers/uri-registry.js';
import { appActions } from '../handlers/apps/app-resource.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';
import { invalidateAppsCache } from '../features/apps/discovery.js';
import { storageWrite, storageDelete } from '../storage/storage-manager.js';
import { _resetAppGrantsForTest, saveAppGrant } from '../storage/app-grants.js';

const APP_ID = 'verb-semantics-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);

/** The app declares more than the user granted — the gap `read` must report. */
const MANIFEST = {
  name: 'Verb Semantics Fixture',
  description: 'A fixture app.',
  icon: '🧪',
  permissions: ['yaar://apps/self/db/'],
  subagents: { max: 5 },
  streams: ['agents'],
};

const PROTOCOL = {
  state: { rows: { description: 'Every row.' } },
  commands: { save: { description: 'Persist the rows.' } },
};

const SKILL = '# Fixture\n\nCall `save` only after the user has confirmed.\n';

const text = (r: VerbResult) => {
  const first = r.content[0];
  if (first.type === 'text') return first.text;
  if (first.type === 'resource' && 'text' in first.resource) return first.resource.text;
  return '';
};
const json = (r: VerbResult) => JSON.parse(text(r));

beforeAll(async () => {
  mkdirSync(join(appDir, 'dist'), { recursive: true });
  mkdirSync(join(appDir, 'agent'), { recursive: true });
  writeFileSync(join(appDir, 'app.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(appDir, 'dist', 'protocol.json'), JSON.stringify(PROTOCOL));
  writeFileSync(join(appDir, 'dist', 'index.html'), '<html></html>');
  writeFileSync(join(appDir, 'agent', 'SKILL.md'), SKILL);
  invalidateAppsCache();

  // The user approved 2 sub-agents; the manifest asks for 5. An app holding
  // `yaar-dev` can rewrite its own app.json, so the grant is a ceiling, not a default.
  _resetAppGrantsForTest();
  await saveAppGrant(APP_ID, { subagents: { max: 2 }, streams: [] });
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
  invalidateAppsCache();
  _resetAppGrantsForTest();
});

describe('the apps/ boundary', () => {
  const VERBS: Verb[] = ['describe', 'read', 'list', 'invoke', 'delete'];

  it('refuses instance sub-paths on every verb', async () => {
    const registry = initRegistry();
    for (const verb of VERBS) {
      for (const sub of ['state/rows', 'commands/save']) {
        const uri = `yaar://apps/${APP_ID}/${sub}`;
        const result = await registry.execute(verb, uri, { action: 'set_badge' });
        expect(result.isError, `${verb} ${uri}`).toBe(true);
        // The refusal has to name the address that *does* work, or it is a dead end.
        expect(text(result)).toContain('yaar://windows/');
      }
    }
  });

  it('leaves storage, db and agents sub-paths addressable', async () => {
    const registry = initRegistry();
    for (const sub of ['storage/', 'db/notes', 'agents']) {
      const result = await registry.execute('describe', `yaar://apps/${APP_ID}/${sub}`);
      expect(result.isError, sub).toBeFalsy();
    }
  });
});

describe('describe on an app', () => {
  it('returns the protocol verbatim plus SKILL.md', async () => {
    const body = json(await initRegistry().execute('describe', `yaar://apps/${APP_ID}`));

    expect(body.uri).toBe(`yaar://apps/${APP_ID}`);
    expect(body.name).toBe('Verb Semantics Fixture');
    expect(body.icon).toBe('🧪');
    // Verbatim: a build artifact carries no drift risk, which is the whole reason it
    // can be returned whole where a hand-written restatement could not.
    expect(body.protocol).toEqual(PROTOCOL);
    expect(body.skill).toBe(SKILL);
    expect(body.permissions).toEqual(['yaar://apps/self/db/']);
  });

  it('derives invokeActions from the table that dispatches them', async () => {
    const body = json(await initRegistry().execute('describe', `yaar://apps/${APP_ID}`));

    // The list used to be written three times — describe advertised `set_badge` alone,
    // the switch implemented seven, and the schema enum named five including a `write`
    // that was never handled here. Deriving it is what makes that impossible.
    expect(Object.keys(body.invokeActions).sort()).toEqual([...appActions.names].sort());
    for (const name of appActions.names) {
      expect(body.invokeActions[name], name).toBeTruthy();
    }
  });

  it('errors for an app that is not installed', async () => {
    const result = await initRegistry().execute('describe', 'yaar://apps/no-such-app');
    expect(result.isError).toBe(true);
  });
});

describe('read on an app', () => {
  it('reports the granted ceiling, not the declared one', async () => {
    const body = json(await initRegistry().execute('read', `yaar://apps/${APP_ID}`));

    // The manifest asks for 5. Raw app.json would report 5 — and would report it for
    // an app installed before grants existed that in fact holds nothing.
    expect(MANIFEST.subagents.max).toBe(5);
    expect(body.subagents).toEqual({ max: 2 });
    // Declared `streams: ['agents']`, granted none.
    expect(body.streams).toBeUndefined();
  });

  it('carries what app.json cannot say', async () => {
    const body = json(await initRegistry().execute('read', `yaar://apps/${APP_ID}`));

    // `source` and `kind` are decided by which root the app was found in, so they are
    // in no file — which is the other half of why `read` is not the manifest verbatim.
    expect(body.source).toBe('user');
    expect(body.kind).toBe('app');
    expect(body.id).toBe(APP_ID);
    expect(body.hasProtocol).toBe(true);
  });

  it('is not the same shape as describe', async () => {
    const registry = initRegistry();
    const described = json(await registry.execute('describe', `yaar://apps/${APP_ID}`));
    const read = json(await registry.execute('read', `yaar://apps/${APP_ID}`));

    // The manual carries the protocol; the current value does not. Two verbs that
    // returned the same kind of thing are why the monitor prompt said "read or
    // describe" instead of instructing.
    expect(described.protocol).toBeDefined();
    expect(read.protocol).toBeUndefined();
    expect(read.installed).toBe(true);
    expect(described.installed).toBeUndefined();
  });
});

describe('describe on a storage path', () => {
  const DIR = 'verb-semantics';

  beforeAll(async () => {
    await storageWrite(`${DIR}/note.txt`, 'hello');
  });
  afterAll(async () => {
    await storageDelete(DIR);
  });

  it('describes a file, not the storage feature', async () => {
    const body = json(await initRegistry().execute('describe', `yaar://storage/${DIR}/note.txt`));
    expect(body.kind).toBe('file');
    expect(body.size).toBe(5);
    expect(body.modifiedAt).toBeTruthy();
    expect(body.verbs).not.toContain('list'); // a file is not a collection
  });

  it('describes a directory', async () => {
    const body = json(await initRegistry().execute('describe', `yaar://storage/${DIR}`));
    expect(body.kind).toBe('directory');
    expect(body.entries).toBe(1);
    expect(body.totalSize).toBe(5);
  });

  it('errors for a path that does not exist', async () => {
    const result = await initRegistry().execute('describe', `yaar://storage/${DIR}/ghost.txt`);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No resource at');
  });

  it('answers for the app-scoped spelling too', async () => {
    const registry = initRegistry();
    await storageWrite(`apps/${APP_ID}/config.json`, '{}');
    try {
      const body = json(
        await registry.execute('describe', `yaar://apps/${APP_ID}/storage/config.json`),
      );
      expect(body.kind).toBe('file');
      const missing = await registry.execute(
        'describe',
        `yaar://apps/${APP_ID}/storage/nowhere.json`,
      );
      expect(missing.isError).toBe(true);
    } finally {
      await storageDelete(`apps/${APP_ID}`);
    }
  });
});

describe('list on a missing directory', () => {
  it('is an error, not an empty collection', async () => {
    const result = await initRegistry().execute('list', 'yaar://storage/no-such-folder/');
    expect(result.isError).toBe(true);
  });

  it("still lists an app's untouched storage namespace as empty", async () => {
    // The namespace exists from the moment the app does; the directory is created by
    // the first write. An app calling appStorage.list() on first run must not throw.
    const result = await initRegistry().execute('list', `yaar://apps/${APP_ID}/storage/`);
    expect(result.isError).toBeFalsy();
  });
});

describe('describe on an unconfigured MCP server', () => {
  it('is an error, not a fabricated disconnected status', async () => {
    // `getStatus` fills in the blanks for any name it is handed, which the list path
    // relies on — so the guard is in the handler, and this is what it stops: a server
    // nobody configured reading as one that merely happens to be down.
    const result = await initRegistry().execute('describe', 'yaar://mcp/no-such-server');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no-such-server');
  });
});
