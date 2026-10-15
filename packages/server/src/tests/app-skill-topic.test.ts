/**
 * An app agent looking for its own manual, and for its own commands (issue #182, gaps 13–14).
 *
 * 14: a fresh app agent whose app ships `agent/SKILL.md` and nothing under `agent/docs/`
 * ran `describe({ topic: "skill" })` and was told the app "ships no topic docs at all" —
 * true of the topic tier, and read as "there is no documentation". The monitor had pointed
 * it at `yaar://apps/{id}/skill`, a URI an app agent holds no `read` for. The topic door
 * now answers "skill" with the SKILL.md, and every miss on either topic door names it.
 *
 * 13: agents called app commands as MCP tools (`mcp__app__inspect`). That refusal is
 * written by the provider CLI before any YAAR code sees the call, so it cannot be made to
 * point anywhere; the Available Commands section says it up front instead.
 *
 * Runs against a real fixture app on disk, the house pattern (`app-docs-doors.test.ts`).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { USER_APPS_DIR } from '../features/apps/roots.js';
import { invalidateAppsCache } from '../features/apps/discovery.js';
import { isSkillTopicName } from '../features/apps/docs.js';
import { describeAppTopic } from '../mcp/app-agent/index.js';
import { buildAppAgentProfile } from '../agents/profiles/app-agent/index.js';
import { registerAppsHandlers } from '../handlers/apps/register.js';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import type { VerbResult } from '../lib/verb-result.js';
import type { ResolvedUri } from '../handlers/uri-resolve.js';

/** SKILL.md only — the debug-board shape. */
const SKILL_ONLY = 'skill-topic-fixture';
/** A topic doc and a SKILL.md. */
const BOTH = 'skill-topic-fixture-both';
/** Neither. */
const BARE = 'skill-topic-fixture-bare';

const SKILL = '# Debug board\n\nPost a hypothesis before re-running a scenario.\n';
const TOPIC = `---
description: Read before changing the board layout.
audience: agent
---

Columns are fixed.
`;

const PROTOCOL = {
  commands: { inspect: { description: 'Inspect the board.' } },
};

let registry: ResourceRegistry;

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

function handler() {
  const found = registry.findHandler(`yaar://apps/${SKILL_ONLY}`);
  if (!found) throw new Error('apps handler not registered');
  return found;
}

function writeApp(id: string, files: Record<string, string>) {
  const dir = join(USER_APPS_DIR, id);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

beforeAll(() => {
  writeApp(SKILL_ONLY, {
    'app.json': JSON.stringify({ name: 'Skill Topic Fixture' }),
    'dist/protocol.json': JSON.stringify(PROTOCOL),
    'agent/SKILL.md': SKILL,
  });
  writeApp(BOTH, {
    'app.json': JSON.stringify({ name: 'Skill Topic Fixture Both' }),
    'agent/SKILL.md': SKILL,
    'agent/docs/layout.md': TOPIC,
  });
  writeApp(BARE, { 'app.json': JSON.stringify({ name: 'Skill Topic Fixture Bare' }) });
  invalidateAppsCache();

  registry = new ResourceRegistry();
  registerAppsHandlers(registry);
});

afterAll(() => {
  for (const id of [SKILL_ONLY, BOTH, BARE]) {
    rmSync(join(USER_APPS_DIR, id), { recursive: true, force: true });
  }
  invalidateAppsCache();
});

describe('isSkillTopicName', () => {
  test('the spellings a caller reaches for', () => {
    for (const name of ['skill', 'SKILL', 'Skill', 'SKILL.md', 'skill.md']) {
      expect(isSkillTopicName(name)).toBe(true);
    }
    for (const name of ['skills', 'skill-notes', 'layout']) {
      expect(isSkillTopicName(name)).toBe(false);
    }
  });
});

describe("the app agent's describe({ topic })", () => {
  test('"skill" answers with the SKILL.md when no topic docs exist', async () => {
    const result = await describeAppTopic(SKILL_ONLY, 'skill');
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(SKILL);
  });

  test('"skill" answers with the SKILL.md beside topic docs too', async () => {
    const result = await describeAppTopic(BOTH, 'SKILL.md');
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(SKILL);
  });

  test('a real topic is still served by name', async () => {
    const result = await describeAppTopic(BOTH, 'layout');
    expect(textOf(result)).toContain('Columns are fixed.');
  });

  test('a miss on a SKILL.md-only app names the skill, not "no docs at all"', async () => {
    const result = await describeAppTopic(SKILL_ONLY, 'workflow');
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).not.toContain('at all');
    expect(text).toContain('SKILL.md');
    expect(text).toContain('describe({ topic: "skill" })');
  });

  test('a miss on a foreign app keeps the appId in the suggested call', async () => {
    const result = await describeAppTopic(BOTH, 'nope', BOTH);
    const text = textOf(result);
    expect(text).toContain('Declared: layout.');
    expect(text).toContain(`describe({ topic: "skill", appId: "${BOTH}" })`);
  });

  test('an app with neither says so plainly', async () => {
    const result = await describeAppTopic(BARE, 'skill');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no SKILL.md either');
  });
});

describe('the verbs door on …/docs', () => {
  test('an app with no topic docs points at its skill URI', async () => {
    const result = await handler().list!(at(`yaar://apps/${SKILL_ONLY}/docs`));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`read("yaar://apps/${SKILL_ONLY}/skill")`);
  });

  test('an unknown topic names the skill beside the declared ones', async () => {
    const result = await handler().read!(at(`yaar://apps/${BOTH}/docs/skill`));
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Declared: layout.');
    expect(text).toContain(`read("yaar://apps/${BOTH}/skill")`);
  });

  test('an app with neither keeps the describe pointer', async () => {
    const result = await handler().list!(at(`yaar://apps/${BARE}/docs`));
    expect(textOf(result)).toContain(`describe("yaar://apps/${BARE}")`);
  });
});

describe('the Available Commands section', () => {
  test('says app commands are not MCP tools, and names the call that runs them', async () => {
    const { systemPrompt } = await buildAppAgentProfile(SKILL_ONLY);
    const section = systemPrompt.slice(systemPrompt.indexOf('## Available Commands'));
    expect(section).toContain('not tools');
    expect(section).toContain('mcp__app__{name}');
    expect(section).toContain('command({ command: "name", params:');
  });
});
