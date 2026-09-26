/**
 * The three doors onto an installed app agree about *which* app it is.
 *
 * `describe`, `read` and `list` each answer a different question — the manual's front
 * page, the effective manifest, the index — but all three open onto the same record
 * (`AppInfo`), so the identity half is one fact told three times. It drifted: `describe`
 * carried `name` and nothing else, so an agent that had just deployed 1.11.1 and wanted
 * to confirm the install had no way to ask this door. The reported workaround was a full
 * re-clone of the app's source to read one line of `app.json` (issue #110).
 *
 * What is pinned here is the agreement, not the field list: a future field added to one
 * answer and forgotten in another is the same bug again.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { USER_APPS_DIR } from '../features/apps/roots.js';
import { invalidateAppsCache } from '../features/apps/discovery.js';
import { describeApp } from '../features/apps/describe.js';
import {
  appsListHandler,
  describeApplication,
  readApplication,
} from '../handlers/apps/app-resource.js';
import type { ResolvedUri } from '../handlers/uri-resolve.js';
import type { VerbResult } from '../lib/verb-result.js';

const APP_ID = 'identity-agreement-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);

const MANIFEST = {
  name: 'Identity Agreement Fixture',
  description: 'An app with a version, so a deploy can be verified.',
  version: '1.11.1',
  author: 'Fixture Author',
};

const at = (uri: string) => ({ sourceUri: uri }) as ResolvedUri;

type Block = { text?: unknown };

/** The JSON an `okJson` result carries. */
function jsonOf(result: VerbResult): Record<string, unknown> {
  const block = (result.content as Block[]).find(
    (b) => typeof b.text === 'string' && b.text.startsWith('{'),
  );
  if (!block) throw new Error('no JSON block in result');
  return JSON.parse(block.text as string);
}

beforeAll(() => {
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'app.json'), JSON.stringify(MANIFEST));
  invalidateAppsCache();
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
  invalidateAppsCache();
});

/** Every key the three doors are expected to agree on where they both carry it. */
const IDENTITY = ['id', 'name', 'version', 'author', 'kind', 'source'] as const;

describe('describe, read and list agree on an app’s identity', () => {
  test('describe carries the version that verifies a deploy', async () => {
    const facts = (await describeApp(APP_ID))!;
    expect(facts.id).toBe(APP_ID);
    expect(facts.version).toBe('1.11.1');
    expect(facts.author).toBe('Fixture Author');
    expect(facts.kind).toBe('app');
    expect(facts.source).toBe('user');
  });

  test('the app agent’s door (protocol: index) carries it too', async () => {
    const facts = (await describeApp(APP_ID, { protocol: 'index' }))!;
    expect(facts.version).toBe('1.11.1');
    expect(facts.id).toBe(APP_ID);
  });

  test('no identity key that describe and read both carry disagrees', async () => {
    const uri = `yaar://apps/${APP_ID}`;
    const described = jsonOf(await describeApplication(at(uri)));
    const readBack = jsonOf(await readApplication(at(uri)));

    for (const key of IDENTITY) {
      expect(described[key]).toBeDefined();
      expect([key, described[key]]).toEqual([key, readBack[key]]);
    }
  });

  test('the list row agrees with both', async () => {
    const links = (await appsListHandler.list!(at('yaar://apps'))).content.filter(
      (b) => b.type === 'resource_link',
    ) as unknown as Array<Record<string, unknown>>;
    const row = links.find((l) => l.uri === `yaar://apps/${APP_ID}`);
    expect(row).toBeDefined();

    const described = jsonOf(await describeApplication(at(`yaar://apps/${APP_ID}`)));
    for (const key of ['name', 'version', 'kind'] as const) {
      expect([key, row![key]]).toEqual([key, described[key]]);
    }
  });

  test('an app without a version says so by omission, in every answer', async () => {
    const bare = 'identity-agreement-bare';
    const bareDir = join(USER_APPS_DIR, bare);
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(join(bareDir, 'app.json'), JSON.stringify({ name: 'Bare' }));
    invalidateAppsCache();
    try {
      const facts = (await describeApp(bare))!;
      expect('version' in facts).toBe(false);
      expect('author' in facts).toBe(false);
      expect(facts.kind).toBe('app');
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      invalidateAppsCache();
    }
  });
});
