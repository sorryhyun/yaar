/**
 * `yaar://apps/{id}/docs` — the doors onto the app docs tier (`agent/docs/*.md`).
 *
 * The tier exists so app knowledge has a third size between always-loaded prompt prose
 * and monolithic SKILL.md: topics pulled by trigger, with only the *index* — one scent
 * line per topic — riding in the always-loaded and describe channels. The properties
 * worth pinning are about which answer each door gives and which topics each door
 * indexes, not about byte counts:
 *
 *  1. `describe` on the app carries the docs index rows, audience-filtered, beside the
 *     protocol's table of contents — and each detail level names the door its caller
 *     can actually open.
 *  2. Each verb on `…/docs` answers its own question (resource / index / one topic).
 *  3. A `dev` topic is unindexed at runtime but readable by name — unindexed, not secret.
 *  4. The app agent's prompt appendix is generated from the same frontmatter, so it
 *     cannot drift from what `describe({ topic })` will answer.
 *  5. Docs are documentation: invoke and delete are refused with the write path named.
 *
 * Runs against a real fixture app on disk (the house pattern — see
 * `app-protocol-doors.test.ts`) rather than a module mock.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { USER_APPS_DIR } from '../features/apps/roots.js';
import { invalidateAppsCache } from '../features/apps/discovery.js';
import { describeApp } from '../features/apps/describe.js';
import { loadAppDocs, loadAppDocTopic, agentDocsFilesFor } from '../features/apps/docs.js';
import { buildAppAgentProfile } from '../agents/profiles/app-agent/index.js';
import { registerAppsHandlers } from '../handlers/apps/register.js';
import { ResourceRegistry, type VerbResult } from '../handlers/uri-registry.js';
import type { ResolvedUri } from '../handlers/uri-resolve.js';
import { parseAppDocsPath } from '../handlers/apps/paths.js';

const APP_ID = 'docs-doors-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);
const docsDir = join(appDir, 'agent', 'docs');

const GOTCHAS = `---
name: solid-gotchas
description: Read before writing reactive view code — the traps are silent.
audience: agent
covers:
  - src/view.ts
---

## Solid gotchas

A derived value computed outside a thunk does not update.
`;

/** No description in frontmatter: the runtime falls back to the body's first line. */
const HISTORY = `---
audience: both
---

Deploys keep every prior version; roll back with versionRestore.
`;

/** A dev topic: for whoever edits the source, reached through the clone. */
const BUILD_NOTES = `---
description: Read before touching the build pipeline.
audience: dev
---

The compile step re-runs schema folding.
`;

let registry: ResourceRegistry;

function handler() {
  const found = registry.findHandler(`yaar://apps/${APP_ID}`);
  if (!found) throw new Error('apps handler not registered');
  return found;
}

const at = (uri: string) => ({ sourceUri: uri }) as ResolvedUri;

type Block = { text?: unknown; resource?: { text?: unknown } };

function textOf(result: VerbResult): string {
  return (result.content as Block[])
    .map((block) =>
      typeof block.text === 'string'
        ? block.text
        : typeof block.resource?.text === 'string'
          ? block.resource.text
          : '',
    )
    .join('\n');
}

function jsonOf(result: VerbResult): Record<string, unknown> {
  const block = (result.content as Block[]).find(
    (b) => typeof b.text === 'string' && b.text.startsWith('{'),
  );
  if (!block) throw new Error(`no JSON block in result: ${textOf(result)}`);
  return JSON.parse(block.text as string);
}

beforeAll(() => {
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(appDir, 'app.json'), JSON.stringify({ name: 'Docs Doors Fixture' }));
  writeFileSync(join(docsDir, 'solid-gotchas.md'), GOTCHAS);
  writeFileSync(join(docsDir, 'version-history.md'), HISTORY);
  writeFileSync(join(docsDir, 'build-notes.md'), BUILD_NOTES);
  writeFileSync(join(appDir, 'agent', 'src-view.txt'), 'not a topic'); // ignored: not in docs/
  mkdirSync(join(appDir, 'src'), { recursive: true });
  writeFileSync(join(appDir, 'src', 'view.ts'), 'export {}');
  invalidateAppsCache();

  registry = new ResourceRegistry();
  registerAppsHandlers(registry);
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
  invalidateAppsCache();
});

describe('loadAppDocs', () => {
  test('parses frontmatter, falls back where the runtime should be tolerant', async () => {
    const topics = await loadAppDocs(APP_ID);
    expect(topics.map((t) => t.name)).toEqual(['build-notes', 'solid-gotchas', 'version-history']);

    const gotchas = topics.find((t) => t.name === 'solid-gotchas')!;
    expect(gotchas.description).toBe(
      'Read before writing reactive view code — the traps are silent.',
    );
    expect(gotchas.audience).toBe('agent');
    expect(gotchas.covers).toEqual(['src/view.ts']);
    expect(gotchas.body).toContain('A derived value computed outside a thunk');
    expect(gotchas.body).not.toContain('---'); // frontmatter stripped

    // No description declared: the body's first non-heading line stands in.
    const history = topics.find((t) => t.name === 'version-history')!;
    expect(history.description).toBe(
      'Deploys keep every prior version; roll back with versionRestore.',
    );
    expect(history.audience).toBe('both');
  });

  test('one topic by slug, or null', async () => {
    expect((await loadAppDocTopic(APP_ID, 'solid-gotchas'))?.name).toBe('solid-gotchas');
    expect(await loadAppDocTopic(APP_ID, 'no-such-topic')).toBeNull();
  });

  test('agentDocsFilesFor enumerates what clone and deploy must carry', async () => {
    expect(await agentDocsFilesFor(appDir)).toEqual([
      'agent/docs/build-notes.md',
      'agent/docs/solid-gotchas.md',
      'agent/docs/version-history.md',
    ]);
  });
});

describe('describe on the app carries the docs index', () => {
  test('runtime topics only, with the door the caller can open', async () => {
    const facts = await describeApp(APP_ID);
    const docs = facts?.docs as Record<string, unknown>;
    expect(docs.uri).toBe(`yaar://apps/${APP_ID}/docs`);

    const topics = docs.topics as Array<{ name: string; description: string }>;
    // The dev topic is not indexed for a runtime caller.
    expect(topics.map((t) => t.name)).toEqual(['solid-gotchas', 'version-history']);
    expect(topics[0].description).toContain('Read before writing reactive view code');

    // The verbs caller is pointed at a URI it can read…
    expect(String(docs.one)).toContain(`read("yaar://apps/${APP_ID}/docs/{name}")`);

    // …the app agent, holding no verbs, at its own describe spelling.
    const agentFacts = await describeApp(APP_ID, { protocol: 'index' });
    const agentDocs = agentFacts?.docs as Record<string, unknown>;
    expect(String(agentDocs.one)).toContain('describe({ topic:');
  });
});

describe('the three verbs on …/docs', () => {
  test('describe answers with counts and doors, never with content', async () => {
    const result = await handler().describe!(at(`yaar://apps/${APP_ID}/docs`));
    const json = jsonOf(result);
    expect(json.topics).toBe(2);
    expect(String(json.devTopics)).toContain('1 more');
    expect(textOf(result)).not.toContain('derived value'); // no bodies here
  });

  test('list is the index: a scent line per runtime topic', async () => {
    const result = await handler().list!(at(`yaar://apps/${APP_ID}/docs`));
    const links = result.structuredContent?.items as Array<{ uri: string; name: string }>;
    expect(links.map((l) => l.name)).toEqual(['solid-gotchas', 'version-history']);
    expect(links[0].uri).toBe(`yaar://apps/${APP_ID}/docs/solid-gotchas`);
  });

  test('read is one topic body, markdown, frontmatter stripped', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/docs/solid-gotchas`));
    const text = textOf(result);
    expect(text).toContain('A derived value computed outside a thunk');
    expect(text).not.toContain('audience:');
  });

  test('a dev topic is unindexed but readable by name', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/docs/build-notes`));
    expect(textOf(result)).toContain('The compile step re-runs schema folding.');
  });

  test('read on the bare tier and list on one topic each point at the right verb', async () => {
    const bare = await handler().read!(at(`yaar://apps/${APP_ID}/docs`));
    expect(bare.isError).toBe(true);
    expect(textOf(bare)).toContain(`list("yaar://apps/${APP_ID}/docs")`);

    const one = await handler().list!(at(`yaar://apps/${APP_ID}/docs/solid-gotchas`));
    expect(one.isError).toBe(true);
    expect(textOf(one)).toContain(`read("yaar://apps/${APP_ID}/docs/solid-gotchas")`);
  });

  test('an unknown topic names the declared ones', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/docs/no-such`));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('solid-gotchas');
  });

  test('a too-deep address is refused with the one-topic rule', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/docs/a/b`));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('One topic per address');
  });

  test('invoke and delete are refused with the write path named', async () => {
    const invoked = await handler().invoke!(at(`yaar://apps/${APP_ID}/docs/solid-gotchas`), {
      action: 'write',
    });
    expect(invoked.isError).toBe(true);
    expect(textOf(invoked)).toContain('agent/docs/');

    const deleted = await handler().delete!(at(`yaar://apps/${APP_ID}/docs/solid-gotchas`));
    expect(deleted.isError).toBe(true);
  });
});

describe('parseAppDocsPath', () => {
  test('claims the docs sub-path and nothing else', () => {
    expect(parseAppDocsPath('yaar://apps/notes/docs')).toEqual({ appId: 'notes', rest: '' });
    expect(parseAppDocsPath('yaar://apps/notes/docs/')).toEqual({ appId: 'notes', rest: '' });
    expect(parseAppDocsPath('yaar://apps/notes/docs/solid-gotchas')).toEqual({
      appId: 'notes',
      rest: 'solid-gotchas',
    });
    expect(parseAppDocsPath('yaar://apps/notes')).toBeNull();
    expect(parseAppDocsPath('yaar://apps/notes/protocol')).toBeNull();
  });
});

describe('the app agent prompt appendix', () => {
  test('carries the runtime index, generated from the same frontmatter', async () => {
    const profile = await buildAppAgentProfile(APP_ID);
    expect(profile.systemPrompt).toContain('## App Docs');
    expect(profile.systemPrompt).toContain(
      '`solid-gotchas`: Read before writing reactive view code — the traps are silent.',
    );
    expect(profile.systemPrompt).toContain('`version-history`');
    // Dev topics serve whoever edits the source — never the runtime prompt.
    expect(profile.systemPrompt).not.toContain('build-notes');
    // The index is scent, never content.
    expect(profile.systemPrompt).not.toContain('A derived value computed outside a thunk');
  });
});
