/**
 * The install-time consent diff.
 *
 * `streams` and `personas` are granted by the install dialog and by nothing else —
 * `discovery.ts` reads the recorded answer back as a ceiling — so the question "does
 * this install need to ask?" is a security boundary, not a UX detail. It has one
 * non-obvious rule, and it is the whole reason this file exists: an update is diffed
 * against what the app **holds**, not against what its previous manifest **said**.
 *
 * Those two used to be the same thing, back when the manifest was the grant. They are
 * not the same for an install that predates grants: its app.json declares `personas`,
 * it holds none, and a manifest-to-manifest diff calls that "no change" and hands the
 * capability over without ever drawing the dialog.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  readAppCapabilities,
  heldCapabilities,
  addedCapabilities,
  formatCapabilities,
  grantFor,
  isEmpty,
  type AppCapabilities,
} from '../features/apps/capabilities.js';
import { APPS_DIR, USER_APPS_DIR } from '../features/apps/roots.js';
import { _resetAppGrantsForTest } from '../storage/app-grants.js';

const INSTALLED_ID = 'capability-fixture';
const BUNDLED_ID = 'capability-bundled-fixture';
const installedDir = join(USER_APPS_DIR, INSTALLED_ID);
const bundledDir = join(APPS_DIR, BUNDLED_ID);

const MANIFEST = {
  name: 'Capability Fixture',
  permissions: ['yaar://apps/self/db/'],
  bundles: ['yaar-web'],
  streams: ['agents'],
  subagents: { max: 4 },
};

beforeAll(() => {
  for (const dir of [installedDir, bundledDir]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.json'), JSON.stringify(MANIFEST));
  }
});

afterEach(() => {
  _resetAppGrantsForTest({});
});

afterAll(() => {
  rmSync(installedDir, { recursive: true, force: true });
  rmSync(bundledDir, { recursive: true, force: true });
  _resetAppGrantsForTest(null);
});

/** A capability set with the boring fields already empty. */
function caps(partial: Partial<AppCapabilities> = {}): AppCapabilities {
  return { permissions: [], bundles: [], streams: [], ...partial };
}

describe('reading a manifest', () => {
  it('reads all four capabilities off app.json', async () => {
    const read = await readAppCapabilities(installedDir);

    expect(read.permissions).toEqual(['yaar://apps/self/db/']);
    expect(read.bundles).toEqual(['yaar-web']);
    expect(read.streams).toEqual(['agents']);
    expect(read.subagents).toEqual({ max: 4 });
  });

  it('clamps the persona count to what will actually be granted', async () => {
    // The dialog states a number. If the parser would clamp 40 to 16, saying "40" is a
    // promise nothing downstream keeps and the user has no way to check.
    const greedyDir = join(USER_APPS_DIR, 'capability-greedy-fixture');
    mkdirSync(greedyDir, { recursive: true });
    writeFileSync(join(greedyDir, 'app.json'), JSON.stringify({ subagents: { max: 40 } }));
    try {
      expect((await readAppCapabilities(greedyDir)).subagents).toEqual({ max: 16 });
    } finally {
      rmSync(greedyDir, { recursive: true, force: true });
    }
  });

  it('reads nothing from a directory with no manifest', async () => {
    expect(isEmpty(await readAppCapabilities(join(USER_APPS_DIR, 'no-such-app')))).toBe(true);
  });
});

describe('what an installed app already holds', () => {
  it('counts streams and personas as held only when granted', async () => {
    _resetAppGrantsForTest({ [INSTALLED_ID]: { subagents: { max: 4 }, streams: ['agents'] } });
    const held = await heldCapabilities(installedDir, INSTALLED_ID);

    expect(held.streams).toEqual(['agents']);
    expect(held.subagents).toEqual({ max: 4 });
  });

  it('counts neither for an install that predates the grant file', async () => {
    // The regression this file is named for. The manifest says `personas`; the app has
    // never been granted them; "held" must say so or the dialog never appears.
    _resetAppGrantsForTest({});
    const held = await heldCapabilities(installedDir, INSTALLED_ID);

    expect(held.streams).toEqual([]);
    expect(held.subagents).toBeUndefined();
    // Permissions and bundles are unaffected — for those the manifest *is* the grant.
    expect(held.permissions).toEqual(['yaar://apps/self/db/']);
    expect(held.bundles).toEqual(['yaar-web']);
  });

  it('takes a bundled manifest at its word, grant file or not', async () => {
    _resetAppGrantsForTest({});
    const held = await heldCapabilities(bundledDir, BUNDLED_ID);

    expect(held.streams).toEqual(['agents']);
    expect(held.subagents).toEqual({ max: 4 });
  });
});

describe('the update diff', () => {
  it('asks for nothing when an update changes nothing', () => {
    const held = caps({ streams: ['agents'], subagents: { max: 4 }, bundles: ['yaar-web'] });
    expect(isEmpty(addedCapabilities(held, held))).toBe(true);
  });

  it('asks about a stream the app did not hold', () => {
    const asking = addedCapabilities(caps(), caps({ streams: ['agents'] }));
    expect(asking.streams).toEqual(['agents']);
    expect(isEmpty(asking)).toBe(false);
  });

  it('asks about a raised persona ceiling but not a lowered one', () => {
    expect(
      addedCapabilities(caps({ subagents: { max: 2 } }), caps({ subagents: { max: 4 } })).subagents,
    ).toEqual({ max: 4 });
    expect(
      addedCapabilities(caps({ subagents: { max: 4 } }), caps({ subagents: { max: 2 } })).subagents,
    ).toBeUndefined();
  });

  it('asks about personas an ungranted app already declared', async () => {
    // End to end over the two pieces: an app installed before grants existed, updating
    // to the same manifest. Diffed against the manifest this is a no-op; diffed against
    // the grant it is the first time anyone has been asked.
    _resetAppGrantsForTest({});
    const asking = addedCapabilities(
      await heldCapabilities(installedDir, INSTALLED_ID),
      await readAppCapabilities(installedDir),
    );

    expect(asking.subagents).toEqual({ max: 4 });
    expect(asking.streams).toEqual(['agents']);
    // ...and nothing it genuinely already holds.
    expect(asking.permissions).toEqual([]);
    expect(asking.bundles).toEqual([]);
  });
});

describe('the recorded grant', () => {
  it('records what was requested, so a dropped capability drops the grant', () => {
    expect(grantFor(caps({ streams: ['agents'], subagents: { max: 4 } }))).toEqual({
      subagents: { max: 4 },
      streams: ['agents'],
    });
    expect(grantFor(caps())).toEqual({});
  });
});

describe('the dialog text', () => {
  it('names every capability it is about to grant', () => {
    const text = formatCapabilities(
      caps({
        permissions: ['yaar://apps/self/db/'],
        bundles: ['yaar-web'],
        streams: ['agents'],
        subagents: { max: 4 },
      }),
    );

    expect(text).toContain('yaar://apps/self/db/');
    expect(text).toContain('drive a browser');
    expect(text).toContain('watch AI agents think');
    expect(text).toContain('up to 4 AI personas');
  });

  it('counts one persona in the singular', () => {
    expect(formatCapabilities(caps({ subagents: { max: 1 } }))).toContain('up to 1 AI persona of');
  });
});
