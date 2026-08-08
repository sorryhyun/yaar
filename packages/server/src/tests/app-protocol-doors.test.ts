/**
 * `yaar://apps/{id}/protocol` — the doors that split an app's manual from its manifest.
 *
 * The incident these close: `describe('yaar://apps/{id}')` answered with the whole of
 * `dist/protocol.json`, and for a 52-command app the result crossed the size at which the
 * Claude CLI stops delivering a tool result inline and substitutes a path on disk — a path
 * a monitor agent, holding five `yaar://` verbs and no filesystem tools, cannot open. The
 * failure is total rather than gradual, so the properties worth pinning are about *which
 * answer each door gives*, not about a byte count that a future app will move anyway:
 *
 *  1. `describe` on the app no longer carries the manifest, and names the doors that do.
 *  2. Each verb on `…/protocol` answers its own question (resource / index / manifest).
 *  3. A per-command read stands alone — its schema brings the `$defs` it points at.
 *  4. The invariant the split had to not break: `yaar://apps/{id}/commands/…` stays
 *     refused, because a *command* belongs to a running window even though its
 *     *documentation* belongs to the installed app.
 *  5. An unknown sub-path is refused rather than silently answered as the bare app.
 *
 * Runs against a real fixture app on disk (the house pattern — see `personas.test.ts`)
 * rather than a module mock, so `listApps`, the discovery cache, and the composite's
 * dispatch order are all the real ones.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { USER_APPS_DIR } from '../features/apps/roots.js';
import { invalidateAppsCache } from '../features/apps/discovery.js';
import { describeApp } from '../features/apps/describe.js';
import { registerAppsHandlers } from '../handlers/apps/register.js';
import { ResourceRegistry, type VerbResult } from '../handlers/uri-registry.js';
import type { ResolvedUri } from '../handlers/uri-resolve.js';
import { parseAppProtocolPath } from '../handlers/apps/paths.js';
import { findProtocolCommand, commandDocument } from '../handlers/apps/protocol-resource.js';
import { renderPayloadExample } from '../lib/command-signature.js';

const APP_ID = 'protocol-doors-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);

/**
 * A protocol with the two shapes that matter: a command whose param is behind a `$ref`
 * into the manifest's `$defs` (so a slice that forgets the table is provably corrupt),
 * and multi-sentence prose (so the index rule has something to summarize).
 */
const PROTOCOL = {
  $defs: {
    vec3: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
    },
  },
  state: {
    selection: { description: 'The ids currently selected. Empty when nothing is picked.' },
  },
  commands: {
    moveNode: {
      description: 'Move a node to a point. Undo history records exactly one step for this.',
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, to: { $ref: '#/$defs/vec3' } },
        required: ['id', 'to'],
      },
      returns: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
    clearScene: { description: 'Remove every node.' },
  },
};

const SKILL = '# Fixture\n\nWorkflows a generated protocol cannot state.\n';

let registry: ResourceRegistry;

/** The composite handler, called the way the registry calls it — no access layer. */
function handler() {
  const found = registry.findHandler(`yaar://apps/${APP_ID}`);
  if (!found) throw new Error('apps handler not registered');
  return found;
}

const at = (uri: string) => ({ sourceUri: uri }) as ResolvedUri;

/** A content block, read structurally — the union's exact shape is the SDK's business. */
type Block = { text?: unknown; resource?: { text?: unknown } };

/** The text of a result, whichever block kind it used. */
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

/** The JSON an `okJson` result carries. */
function jsonOf(result: VerbResult): Record<string, unknown> {
  const block = (result.content as Block[]).find(
    (b) => typeof b.text === 'string' && b.text.startsWith('{'),
  );
  if (!block) throw new Error(`no JSON block in result: ${textOf(result)}`);
  return JSON.parse(block.text as string);
}

beforeAll(() => {
  mkdirSync(join(appDir, 'dist'), { recursive: true });
  mkdirSync(join(appDir, 'agent'), { recursive: true });
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({ name: 'Protocol Doors Fixture', permissions: ['yaar://apps/self/db/'] }),
  );
  writeFileSync(join(appDir, 'dist', 'protocol.json'), JSON.stringify(PROTOCOL));
  writeFileSync(join(appDir, 'agent', 'SKILL.md'), SKILL);
  invalidateAppsCache();

  registry = new ResourceRegistry();
  registerAppsHandlers(registry);
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
  invalidateAppsCache();
});

describe('parseAppProtocolPath', () => {
  test('claims the protocol sub-path and returns the tail unsplit', () => {
    expect(parseAppProtocolPath('yaar://apps/notes/protocol')).toEqual({
      appId: 'notes',
      rest: '',
    });
    expect(parseAppProtocolPath('yaar://apps/notes/protocol/')).toEqual({
      appId: 'notes',
      rest: '',
    });
    expect(parseAppProtocolPath('yaar://apps/notes/protocol/commands/moveNode')).toEqual({
      appId: 'notes',
      rest: 'commands/moveNode',
    });
  });

  test('declines everything else, including the refused instance sub-paths', () => {
    expect(parseAppProtocolPath('yaar://apps/notes')).toBeNull();
    expect(parseAppProtocolPath('yaar://apps/notes/commands/moveNode')).toBeNull();
    expect(parseAppProtocolPath('yaar://apps/notes/storage/x')).toBeNull();
  });
});

describe('describe on the app names the protocol instead of carrying it', () => {
  test('the manifest tables are gone; the command names and the doors are there', async () => {
    const facts = await describeApp(APP_ID);
    const protocol = facts?.protocol as Record<string, unknown>;

    // The tables themselves — the 41.8 KB half — are not in this answer.
    expect(protocol.state).toBeUndefined();
    expect(protocol.commands).toEqual(['moveNode', 'clearScene']);
    expect(protocol.stateKeys).toEqual(['selection']);
    expect(protocol.uri).toBe(`yaar://apps/${APP_ID}/protocol`);

    // SKILL.md is what describe is *for*, and it stays whole.
    expect(facts?.skill).toBe(SKILL);

    // Each follow-up door is named with the verb that opens it.
    expect(String(protocol.index)).toContain(`list("yaar://apps/${APP_ID}/protocol")`);
    expect(String(protocol.one)).toContain('/protocol/commands/{name}');
    expect(String(protocol.full)).toContain(`read("yaar://apps/${APP_ID}/protocol")`);
  });

  test('index detail renders signatures inline, for a caller that holds no verbs', async () => {
    // The app agent's `describe` tool: four scoped tools, no `read`, so a URI is a dead
    // end and the index has to arrive in the answer itself.
    const facts = await describeApp(APP_ID, { protocol: 'index' });
    const protocol = facts?.protocol as Record<string, unknown>;
    expect(protocol.commands).toEqual([
      'moveNode(id: string, to: object) — Move a node to a point.',
      'clearScene — Remove every node.',
    ]);
    expect(String(protocol.one)).toContain('describe({ command:');
  });
});

describe('the three verbs on …/protocol', () => {
  test('describe answers with counts and doors, never with content', async () => {
    const result = await handler().describe!(at(`yaar://apps/${APP_ID}/protocol`));
    const json = jsonOf(result);
    expect(json.commands).toBe(2);
    expect(json.stateKeys).toBe(1);
    expect(json.sharedSchemas).toBe(1);
    expect(json.bytes).toBe(JSON.stringify(PROTOCOL).length);
    // Counts, not tables — this is the answer that can never be too large to deliver.
    expect(textOf(result)).not.toContain('Undo history');
  });

  test('list is the index: one row per entry, summarized to the first sentence', async () => {
    const result = await handler().list!(at(`yaar://apps/${APP_ID}/protocol`));
    const links = result.structuredContent?.items as Array<{ uri: string; description: string }>;

    expect(links.map((l) => l.uri)).toEqual([
      `yaar://apps/${APP_ID}/protocol/state/selection`,
      `yaar://apps/${APP_ID}/protocol/commands/moveNode`,
      `yaar://apps/${APP_ID}/protocol/commands/clearScene`,
    ]);
    expect(links[1].description).toBe('moveNode(id: string, to: object) — Move a node to a point.');
    // The second sentence is what `read` on the row's own URI is for.
    expect(links[1].description).not.toContain('Undo history');
    expect(textOf(result)).toContain('summarized to their first sentence');
  });

  test('read is the manifest verbatim, and says the index exists', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/protocol`));
    const json = jsonOf(result);
    expect(json.commands).toEqual(PROTOCOL.commands);
    expect(json.state).toEqual(PROTOCOL.state);
    expect(json.$defs).toEqual(PROTOCOL.$defs);
    expect(textOf(result)).toContain('the full manifest');
  });
});

describe('a per-command read stands on its own', () => {
  test('the slice brings the $defs its schema points at', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/protocol/commands/moveNode`));
    const json = jsonOf(result);

    expect(json.signature).toBe('moveNode(id: string, to: object)');
    // The whole description, not the summary — this is the door the index points at.
    expect(json.description).toContain('Undo history');

    const params = json.params as Record<string, unknown>;
    const defs = params.$defs as Record<string, unknown>;
    expect(defs.vec3).toEqual(PROTOCOL.$defs.vec3);
    // Attached, not inlined: inlining re-creates the duplication the compiler removed and
    // has no form at all for a recursive schema.
    expect((params.properties as Record<string, unknown>).to).toEqual({ $ref: '#/$defs/vec3' });

    // The example names the door a command actually runs at.
    expect(String(json.call)).toContain('yaar://windows/{windowId}/commands/moveNode');
  });

  test('the app agent reaches the same document in its own vocabulary', async () => {
    // Its `describe({ command })` is built from `findProtocolCommand` + `commandDocument`,
    // differing only in the rendered call — it holds no `invoke` verb, so an example
    // naming a window URI would be the dead end this split exists to remove.
    const found = await findProtocolCommand(APP_ID, 'moveNode');
    if ('content' in found) throw new Error(textOf(found));

    const payload = renderPayloadExample(found.descriptor, found.defs);
    const doc = commandDocument('moveNode', found.descriptor, found.defs, {
      call: `command("moveNode", ${payload})`,
    });

    expect(doc.signature).toBe('moveNode(id: string, to: object)');
    expect((doc.params as Record<string, unknown>).$defs).toEqual(PROTOCOL.$defs);
    expect(doc.call).toBe('command("moveNode", { id: <string>, to: <object> })');
  });

  test('a wrong command name is answered with the declared ones', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/protocol/commands/moveNoed`));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('moveNode, clearScene');
  });

  test('a section that does not exist is named as such', async () => {
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/protocol/hamsters`));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"state" and "commands"');
  });
});

describe('a protocol is documentation', () => {
  test('invoke is refused, and points at the window that can run a command', async () => {
    const result = await handler().invoke!(at(`yaar://apps/${APP_ID}/protocol/commands/moveNode`), {
      id: 'a',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('yaar://windows/{windowId}/commands/{name}');
  });

  test('delete is refused, and distinguishes itself from uninstalling', async () => {
    const result = await handler().delete!(at(`yaar://apps/${APP_ID}/protocol`));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`delete("yaar://apps/${APP_ID}")`);
  });
});

describe('the invariants the split had to not break', () => {
  test('yaar://apps/{id}/commands/… stays refused on every verb', async () => {
    const uri = `yaar://apps/${APP_ID}/commands/moveNode`;
    for (const verb of ['describe', 'read', 'list', 'invoke', 'delete'] as const) {
      const run = handler()[verb] as (r: ResolvedUri, p?: unknown) => Promise<VerbResult>;
      const result = await run(at(uri), {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('belong to a running window');
      // …and the refusal now names where the *documentation* does live.
      expect(textOf(result)).toContain('/protocol/commands/{key}');
    }
  });

  test('an unknown sub-path is refused, not silently answered as the bare app', async () => {
    // `extractIdFromUri` matches the first segment only, so every unclaimed sub-path used
    // to return the app's effective manifest — a false success with nothing to see.
    const result = await handler().read!(at(`yaar://apps/${APP_ID}/hamsters`));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not addressable');
  });

  test('a launch parameter is not read as a sub-path', async () => {
    // `yaar://apps/memo?file=yaar://storage/x` names the app itself, and the `/` inside the
    // parameter must not be mistaken for a sub-path separator — `uri-resolve.ts` records
    // the same bug class from the window.create side. The refusal must not fire here.
    //
    // (It still fails, for an older and unrelated reason: `extractIdFromUri` does not strip
    // a query string either, so the terminal reads the app id as `memo?file=yaar:`. That is
    // pre-existing and out of this change's scope — asserted as-is so the day it is fixed,
    // this test says so rather than silently passing for a new reason.)
    const result = await handler().read!(at(`yaar://apps/${APP_ID}?file=yaar://storage/x.txt`));
    expect(textOf(result)).not.toContain('not addressable');
    expect(textOf(result)).toContain('not found');
  });
});
