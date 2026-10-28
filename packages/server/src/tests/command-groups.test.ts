/**
 * Command groups — a command key may be `group/name`, and every door that lists commands
 * shows a grouped app as a table of contents (group → command names) whose chapters open
 * in full.
 *
 * What is pinned, against a real fixture app on disk (the house pattern — see
 * `app-protocol-doors.test.ts`):
 *
 *  1. The key is the name. `…/commands/files/edit` reads `files/edit`; there is no bare
 *     `edit`, and a miss names the groups rather than listing every key.
 *  2. A group is a chapter: `read`/`describe({ group })` serve every command in it with
 *     its schema and full description; `list` answers with one link per group.
 *  3. The app agent's prompt carries group names and command keys — not the grouped
 *     commands' prose — and still carries the ungrouped commands in full.
 *  4. An app with no grouped key is untouched: no `groups` field anywhere.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { USER_APPS_DIR } from '../features/apps/roots.js';
import { invalidateAppsCache } from '../features/apps/discovery.js';
import { describeApp } from '../features/apps/describe.js';
import { registerAppsHandlers } from '../handlers/apps/register.js';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import type { VerbResult } from '../lib/verb-result.js';
import type { ResolvedUri } from '../handlers/uri-resolve.js';
import { findProtocolCommand, findProtocolGroup } from '../handlers/apps/protocol-resource.js';
import { buildProtocolIndex, commandsInGroup } from '../lib/protocol-index.js';
import { buildAppAgentProfile } from '../agents/profiles/app-agent/index.js';

const APP_ID = 'command-groups-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);

const EDIT_PROSE = 'Edit a file in place. Three modes, and line numbers go stale after any write.';

const PROTOCOL = {
  $defs: {
    span: {
      type: 'object',
      properties: { from: { type: 'number' }, to: { type: 'number' } },
      required: ['from', 'to'],
    },
  },
  state: { project: { description: 'The active project.' } },
  commands: {
    ping: { description: 'Answer pong. Used to check the app is alive.' },
    'files/edit': {
      description: EDIT_PROSE,
      params: {
        type: 'object',
        properties: { path: { type: 'string' }, range: { $ref: '#/$defs/span' } },
        required: ['path'],
      },
    },
    'files/read': { description: 'Read a file. Line-numbered.' },
    'build/compile': { description: 'Compile the project.' },
  },
};

let registry: ResourceRegistry;

function handler() {
  const found = registry.findHandler(`yaar://apps/${APP_ID}`);
  if (!found) throw new Error('apps handler not registered');
  return found;
}

const at = (uri: string) => ({ sourceUri: uri }) as ResolvedUri;
const base = `yaar://apps/${APP_ID}/protocol`;

type Block = { type?: string; text?: unknown; uri?: unknown; name?: unknown };

function textOf(result: VerbResult): string {
  return (result.content as Block[])
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

function jsonOf(result: VerbResult): Record<string, unknown> {
  const block = (result.content as Block[]).find(
    (b) => typeof b.text === 'string' && b.text.startsWith('{'),
  );
  if (!block) throw new Error(`no JSON block in result: ${textOf(result)}`);
  return JSON.parse(block.text as string);
}

function linksOf(result: VerbResult): Array<{ uri: string; name: string; description?: string }> {
  return (result.content as Array<Block & { description?: string }>)
    .filter((b) => b.type === 'resource_link')
    .map((b) => ({ uri: b.uri as string, name: b.name as string, description: b.description }));
}

beforeAll(() => {
  mkdirSync(join(appDir, 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'app.json'), JSON.stringify({ name: 'Command Groups Fixture' }));
  writeFileSync(join(appDir, 'dist', 'protocol.json'), JSON.stringify(PROTOCOL));
  invalidateAppsCache();
  registry = new ResourceRegistry();
  registerAppsHandlers(registry);
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
  invalidateAppsCache();
});

describe('protocol index', () => {
  test('a grouped app gets a table of contents and rows only for the ungrouped rest', () => {
    const index = buildProtocolIndex(PROTOCOL, PROTOCOL.$defs);
    expect(index.groups).toEqual({
      files: ['files/edit', 'files/read'],
      build: ['build/compile'],
    });
    expect(index.commands).toEqual(['ping — Answer pong.']);
  });

  test('a flat app is unchanged — no groups field', () => {
    const index = buildProtocolIndex({ commands: { ping: { description: 'Pong.' } } });
    expect(index).toEqual({ state: [], commands: ['ping — Pong.'] });
  });

  test('commandsInGroup answers only for a real group', () => {
    expect(commandsInGroup(PROTOCOL.commands, 'files')).toEqual(['files/edit', 'files/read']);
    expect(commandsInGroup(PROTOCOL.commands, 'ping')).toEqual([]);
    expect(commandsInGroup(undefined, 'files')).toEqual([]);
  });
});

describe('yaar://apps/{id}/protocol with groups', () => {
  test('list answers with ungrouped rows and one link per group', async () => {
    const result = await handler().list!(at(base));
    const links = linksOf(result!);
    const names = links.map((l) => l.name);
    expect(names).toContain('commands/ping');
    expect(names).toContain('commands/files');
    expect(names).toContain('commands/build');
    expect(names).not.toContain('commands/files/edit');
    const files = links.find((l) => l.name === 'commands/files')!;
    expect(files.uri).toBe(`${base}/commands/files`);
    expect(files.description).toContain('files/edit');
    expect(files.description).toContain('files/read');
  });

  test('list of a group answers with its commands as index rows', async () => {
    const result = await handler().list!(at(`${base}/commands/files`));
    const names = linksOf(result!).map((l) => l.name);
    expect(names).toEqual(['commands/files/edit', 'commands/files/read']);
  });

  test('read of a group is the chapter — every command, full prose, self-contained schema', async () => {
    const result = await handler().read!(at(`${base}/commands/files`));
    expect(result!.isError).toBeFalsy();
    const doc = jsonOf(result!) as {
      group: string;
      commands: Array<{ name: string; description: string; params?: { $defs?: unknown } }>;
    };
    expect(doc.group).toBe('files');
    expect(doc.commands.map((c) => c.name)).toEqual(['files/edit', 'files/read']);
    const edit = doc.commands[0];
    expect(edit.description).toBe(EDIT_PROSE);
    expect(edit.params?.$defs).toEqual({ span: PROTOCOL.$defs.span });
    expect(JSON.stringify(edit)).toContain('yaar://windows/{windowId}/commands/files/edit');
  });

  test('read of group/name is that one command — the key includes the group', async () => {
    const result = await handler().read!(at(`${base}/commands/files/edit`));
    expect(result!.isError).toBeFalsy();
    expect(jsonOf(result!).name).toBe('files/edit');
  });

  test('a bare leaf is not a command, and the miss names the groups', async () => {
    const result = await handler().read!(at(`${base}/commands/edit`));
    expect(result!.isError).toBe(true);
    const text = textOf(result!);
    expect(text).toContain('files/{edit, read}');
    expect(text).toContain('"group/name"');
  });

  test('a path deeper than group/name is refused', async () => {
    const result = await handler().read!(at(`${base}/commands/files/edit/more`));
    expect(result!.isError).toBe(true);
    expect(textOf(result!)).toContain('too deep');
  });

  test('state keys still take one segment', async () => {
    const result = await handler().read!(at(`${base}/state/project/extra`));
    expect(result!.isError).toBe(true);
  });

  test('describe of a group names its commands and the door that serves them', async () => {
    const result = await handler().describe!(at(`${base}/commands/files`));
    const doc = jsonOf(result!);
    expect(doc.group).toBe('files');
    expect(doc.commands).toEqual(['files/edit', 'files/read']);
  });
});

describe('app agent doors', () => {
  test('findProtocolGroup serves the chapter with the caller-rendered call', async () => {
    const doc = (await findProtocolGroup(APP_ID, 'files', (name) => `command("${name}")`)) as {
      commands: Array<{ name: string; call: string }>;
    };
    expect(doc.commands.map((c) => c.call)).toEqual([
      'command("files/edit")',
      'command("files/read")',
    ]);
    expect(await findProtocolGroup(APP_ID, 'nope', () => '')).toBeNull();
  });

  test('findProtocolCommand finds group/name and refuses the bare leaf', async () => {
    expect('descriptor' in (await findProtocolCommand(APP_ID, 'files/edit'))).toBe(true);
    const miss = await findProtocolCommand(APP_ID, 'edit');
    expect('content' in miss && miss.isError).toBe(true);
  });

  test('describeApp lists groups at both detail levels', async () => {
    const names = (await describeApp(APP_ID))!.protocol as Record<string, unknown>;
    expect(names.commands).toEqual(['ping']);
    expect(names.groups).toEqual({ files: ['files/edit', 'files/read'], build: ['build/compile'] });
    expect(String(names.group)).toContain(`${base}/commands/{group}`);

    const index = (await describeApp(APP_ID, { protocol: 'index' }))!.protocol as Record<
      string,
      unknown
    >;
    expect(index.commands).toEqual(['ping — Answer pong.']);
    expect(String(index.group)).toContain('describe({ group:');
  });

  test('the prompt carries the table of contents, not the grouped prose', async () => {
    const { systemPrompt } = await buildAppAgentProfile(APP_ID);
    expect(systemPrompt).toContain('- **files**: `files/edit`, `files/read`');
    expect(systemPrompt).toContain('- **build**: `build/compile`');
    expect(systemPrompt).toContain('describe({ group: "name" })');
    expect(systemPrompt).not.toContain(EDIT_PROSE);
    // The ungrouped command is still listed in full.
    expect(systemPrompt).toContain('`ping`: Answer pong. Used to check the app is alive.');
  });
});
