/**
 * The app agent's storage door: every app holds it, and what it costs stops at the commons.
 *
 * An app agent holds the four `storage:*` built-ins and the relative `storage/...`
 * spelling on `query` because its app exists — not because `app.json` declares anything.
 * Two trees are behind that: its own (`yaar://apps/{id}/storage/`, which no permission
 * governs) and the commons (`yaar://storage/shared/`, which `permissionsAllow` grants to
 * every app for being an app). Both are already reachable from the app's **iframe** via
 * `@bundled/yaar`, so a gate on the agent side split one app in half rather than
 * separating an app from anything outside it.
 *
 * It was gated, for one release: an app declaring nothing under `yaar://storage/` was
 * refused all four, its own tree included. The rule read well — a capability the author
 * never declared is not one the agent should hold — and cost more than it bought, because
 * no manifest ever declares the app's own tree (there is nothing to declare; it needs no
 * permission), so the apps it disarmed were the ones that had done nothing unusual. The
 * prompt sections were suppressed under the same predicate, so the agent could not tell
 * "not permitted" from "no such thing" without trying it.
 *
 * What survived the removal is the part that draws a real boundary, and it is pinned
 * below: everything past the commons is still `permissionsAllow`, per path and per verb,
 * so a declaration still buys the shared tree and a narrow one still means what it says.
 *
 * Layers: the **prompt** documents the door (also pinned in `app-agent-manifest.test.ts`)
 * and the **handler** enforces the shared-tree permission. The `query`/`command` tool
 * descriptions carry no third copy — pinned here, because a description is written once
 * for every caller and could never render one app's declared reach.
 */
import { describe, expect, it } from 'bun:test';
import { sharedStorageGrants, authorizeSharedStorage } from '../mcp/app-agent/shared-storage.js';
import {
  APP_TOOL_DESCRIPTIONS,
  storageWriteAnswer,
  storageDeleteAnswer,
} from '../mcp/app-agent/index.js';
import { buildAppAgentProfile } from '../agents/profiles/app-agent/index.js';
import { permissionsAllow, type PermissionEntry } from '../http/access.js';

/** memo, browser, dock, session-logs and process-explorer declare no storage entry. */
const UNDECLARED = ['memo', 'browser', 'dock', 'session-logs', 'process-explorer'];
/** devtools, lab, search and storage are the four bundled apps that declare one. */
const DECLARING = ['devtools', 'lab', 'search', 'storage'];

describe('the door every app holds', () => {
  const APP_SCOPED = '## App Storage';
  const SHARED = '## Shared Storage (`yaar://storage/`)';

  it('is documented for an app that declares no storage permission', async () => {
    // The regression this file replaces: memo's agent could not write memo's own storage,
    // and its prompt never mentioned that a storage door existed at all.
    const { systemPrompt } = await buildAppAgentProfile('memo');

    expect(systemPrompt).toContain(APP_SCOPED);
    expect(systemPrompt).toContain(SHARED);
    // The spellings, not just the heading — a section naming no tool call is not a door.
    expect(systemPrompt).toContain('query(stateKey: "storage/path/to/file.json")');
    expect(systemPrompt).toContain('storage:write');
    expect(systemPrompt).toContain('storage:delete');
    expect(systemPrompt).toContain('storage:list');
  });

  it('says the own tree needs nothing declared, rather than leaving it to be inferred', async () => {
    const { systemPrompt } = await buildAppAgentProfile('memo');
    expect(systemPrompt).toContain('no permission, no');
    expect(systemPrompt).not.toContain('Your app.json declares storage, so you hold');
  });

  it('reaches an app whose own `agent/prompt.md` replaces the base prompt', async () => {
    // Both storage sections are appended above the branch, so a `prompt.md` app gets them
    // too — the bug that first put them there, and the reason the append is unconditional
    // at one site rather than repeated per branch.
    for (const appId of ['devtools', 'session-logs']) {
      const { systemPrompt } = await buildAppAgentProfile(appId);
      expect(systemPrompt).toContain(APP_SCOPED);
      expect(systemPrompt).toContain(SHARED);
    }
  });

  it('states each door exactly once, app-scoped first', async () => {
    // The shared section opens by contrasting itself with "the app-scoped one above".
    for (const appId of ['memo', 'devtools']) {
      const { systemPrompt } = await buildAppAgentProfile(appId);
      expect(systemPrompt.split(APP_SCOPED).length - 1).toBe(1);
      expect(systemPrompt.split(SHARED).length - 1).toBe(1);
      expect(systemPrompt.indexOf(APP_SCOPED)).toBeLessThan(systemPrompt.indexOf(SHARED));
    }
  });
});

describe('what the prompt says a given app reaches', () => {
  it('renders a declaring app’s own entries', async () => {
    const { systemPrompt } = await buildAppAgentProfile('devtools');
    expect(systemPrompt).toContain('Your app.json reaches further into the same tree');
    expect(systemPrompt).toContain('`yaar://storage/` — ');
  });

  it('tells an undeclared app the commons is its whole reach', async () => {
    // The unevaluable conditional this replaced: "open to you only if your app.json
    // declares a permission covering it", which never said whether this app's did — so
    // the agent found out by trying and reading a refusal.
    const { systemPrompt } = await buildAppAgentProfile('memo');
    expect(systemPrompt).toContain('Your app.json declares nothing further');
    expect(systemPrompt).not.toContain('Your app.json reaches further into the same tree');
    expect(systemPrompt).not.toContain('only if your app.json declares');
  });

  it('is presentation, not permission — the grant list admits nothing', async () => {
    // `sharedStorageGrants` used to be a gate (emptiness decided exposure). It is back to
    // describing only: empty means "the commons and no further", not "no door".
    for (const appId of UNDECLARED) expect(await sharedStorageGrants(appId)).toEqual([]);
    for (const appId of DECLARING) expect((await sharedStorageGrants(appId)).length > 0).toBe(true);
    expect(await sharedStorageGrants('no-such-app')).toEqual([]);
  });
});

describe('the tool descriptions', () => {
  it('say nothing about storage, for any app', () => {
    // One source, and it is the system prompt — the only layer that can render *this*
    // app's declared reach. A description is built once for every caller.
    for (const text of Object.values(APP_TOOL_DESCRIPTIONS)) {
      expect(text).not.toContain('storage');
    }
    // What remains is each tool's actual job.
    expect(APP_TOOL_DESCRIPTIONS.command).toContain('Send a command to the app.');
    expect(APP_TOOL_DESCRIPTIONS.query).toContain('Query the app state.');
    expect(APP_TOOL_DESCRIPTIONS.commandParam).toContain('Command name to execute.');
    expect(APP_TOOL_DESCRIPTIONS.queryParam).toContain('State key to query');
  });
});

describe('the boundary that survived', () => {
  it('gives every app the commons, on all four verbs', async () => {
    for (const verb of ['read', 'list', 'invoke', 'delete'] as const) {
      expect(permissionsAllow([], 'memo', 'yaar://storage/shared/memo/out.md', verb)).toBe(true);
    }
  });

  it('still refuses the shared tree past the commons to an undeclared app', async () => {
    // The one refusal the removal did not touch, and the reason `authorizeSharedStorage`
    // is still asked on every shared-tree call.
    const denied = await authorizeSharedStorage('memo', 'reports/x.md', 'invoke');
    expect(denied).toContain('not permitted: invoke yaar://storage/reports/x.md');
    // And it points at the tree that *is* open, so the model is not left guessing.
    expect(denied).toContain('storage/reports/x.md');
  });

  it('still refuses another app’s private tree, in either spelling', async () => {
    for (const uri of [
      'yaar://storage/apps/vault/secrets.json',
      'yaar://apps/vault/storage/secrets.json',
    ]) {
      expect(permissionsAllow([], 'memo', uri, 'read')).toBe(false);
    }
  });

  it('honours a narrow declaration verb by verb', async () => {
    // A declaration is not a blanket grant: `storage:write` is charged as `invoke` and
    // `storage:delete` as `delete`, the same verbs the verbs door charges for that work.
    const narrow: PermissionEntry[] = [{ uri: 'yaar://storage/reports/', verbs: ['read', 'list'] }];

    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/reports/x.md', 'read')).toBe(true);
    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/reports/x.md', 'invoke')).toBe(false);
    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/reports/x.md', 'delete')).toBe(false);
    // And nothing outside the prefix it named.
    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/files/tax.pdf', 'read')).toBe(false);
  });
});

describe('the built-in answer', () => {
  // #91: an app that overrides `storage:write` answers with its own JSON, and the built-in
  // used to answer `"Written to yaar://..."` — so a caller had to know which door it went
  // through before it could read the reply. Both trees now answer one structured shape.
  it('is structured, and names both the path spelled and the uri resolved', () => {
    expect(
      storageWriteAnswer(
        'yaar://storage/shared/memo/a.md',
        'yaar://storage/shared/memo/a.md',
        'héllo',
      ),
    ).toEqual({
      uri: 'yaar://storage/shared/memo/a.md',
      path: 'yaar://storage/shared/memo/a.md',
      written: true,
      bytes: 6,
    });
    expect(storageDeleteAnswer('yaar://apps/memo/storage/a.md', 'a.md')).toEqual({
      uri: 'yaar://apps/memo/storage/a.md',
      path: 'a.md',
      deleted: true,
    });
  });
});
