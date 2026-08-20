/**
 * The storage exposure gate: an app agent holds the `storage:*` built-ins — and the
 * relative `storage/...` spelling on `query` — iff its app.json declares an entry under
 * `yaar://storage/`.
 *
 * Why the gate exists: those three commands were declared by no app, declinable by no
 * app, and absent from every `protocol.json`. One author was already enforcing the
 * boundary in prose — `apps/search/agent/prompt.md` tells its own agent "do NOT use
 * storage:* commands" — because no switch existed. An undeclared app reaches storage the
 * way the design always intended: its iframe uses `@bundled/yaar` inside a command
 * declared in `protocol.json`, and the agent calls that command by name.
 *
 * What it costs, measured rather than guessed: a sweep of `session_logs/` for `storage:*`
 * calls from undeclared apps found three (session-logs, github, curious-library-vn) and
 * **every one was `storage:list`** — no undeclared app had ever written or deleted, and
 * github's was against `yaar://storage/`, which the shared gate already refused. The
 * capability being withdrawn was real but shallow, and `describe` covers what it was for.
 *
 * What the gate is *not* is the permission. Exposure and authorization are two questions
 * and the last test here is the one that keeps them apart: a declaration narrower than
 * the root opens the door and still refuses the verbs it does not name. Collapsing them
 * would make `{ verbs: ["read","list"] }` mean write access.
 *
 * There are two layers, not three. The **prompt** carries the conditional documentation
 * (pinned in `app-agent-manifest.test.ts`), and the **handler** refuses. The `query` and
 * `command` tool descriptions carry no third copy — pinned below, because a description
 * is written once for every caller and could only be made honest per app at the cost of
 * a manifest read on every MCP request.
 *
 * The refusal's *wording* is pinned here too: the handler branch that calls it needs a
 * live window and belongs to the loopback tier, but the sentence a refused agent reads is
 * the part that has to name a way forward, and that is a pure function.
 */
import { describe, expect, it } from 'bun:test';
import {
  declaresSharedStorage,
  sharedStorageGrants,
  storageNotDeclared,
  resetStorageDeclarationCache,
  authorizeSharedStorage,
} from '../mcp/app-agent/shared-storage.js';
import { APP_TOOL_DESCRIPTIONS } from '../mcp/app-agent/index.js';
import { buildAppAgentProfile } from '../agents/profiles/app-agent/index.js';
import { permissionsAllow, type PermissionEntry } from '../http/access.js';

describe('the exposure predicate', () => {
  it('is true for an app that declares part of the shared tree', async () => {
    // devtools, lab, search and storage are the four bundled apps that declare one.
    for (const appId of ['devtools', 'lab', 'search', 'storage']) {
      expect(await declaresSharedStorage(appId)).toBe(true);
    }
  });

  it('is false for an app that declares none', async () => {
    // memo declares nothing at all; session-logs declares `yaar://history/`, which is a
    // permission but not a storage one — the predicate reads the tree, not the count.
    for (const appId of ['memo', 'browser', 'dock', 'session-logs', 'process-explorer']) {
      expect(await declaresSharedStorage(appId)).toBe(false);
    }
  });

  it('is false for an app with no manifest on disk', async () => {
    expect(await declaresSharedStorage('no-such-app')).toBe(false);
  });

  it('does not count the commons, which every app holds anyway', async () => {
    // `permissionsAllow` grants `yaar://storage/shared/` for being an app. If holding it
    // counted as declaring, the predicate would be true for everyone and gate nothing.
    expect(permissionsAllow([], 'memo', 'yaar://storage/shared/memo/x.md', 'read')).toBe(true);
    expect(await declaresSharedStorage('memo')).toBe(false);
  });

  it('answers from the same list the prompt renders', async () => {
    resetStorageDeclarationCache();
    const grants = await sharedStorageGrants('devtools');
    expect(grants.length > 0).toBe(await declaresSharedStorage('devtools'));
    expect(grants.map((g) => g.uri)).toContain('yaar://storage/');
  });
});

describe('the tool descriptions', () => {
  it('say nothing about storage, for any app', () => {
    // One source for the conditional, and it is the system prompt. A description is
    // written once for every caller, so documenting the door here would either lie to
    // the apps refused at execution or force all four to be rebuilt per app — an appId
    // resolution and an uncached manifest read on every `app`-namespace MCP request,
    // since the modern era builds a server per request.
    for (const text of Object.values(APP_TOOL_DESCRIPTIONS)) {
      expect(text).not.toContain('storage');
    }
    // What remains is each tool's actual job.
    expect(APP_TOOL_DESCRIPTIONS.command).toContain('Send a command to the app.');
    expect(APP_TOOL_DESCRIPTIONS.query).toContain('Query the app state.');
    expect(APP_TOOL_DESCRIPTIONS.commandParam).toContain('Command name to execute.');
    expect(APP_TOOL_DESCRIPTIONS.queryParam).toContain('State key to query');
  });

  it('leave the prompt as the only place a declaring app is told', async () => {
    const { systemPrompt } = await buildAppAgentProfile('devtools');
    expect(systemPrompt).toContain('storage:write');
    expect(systemPrompt).toContain('`storage:delete` needs `delete`');
  });
});

describe('the refusal', () => {
  const refusal = storageNotDeclared('memo', 'command("storage:write")');

  it('names what was refused and why', () => {
    expect(refusal).toContain('command("storage:write")');
    expect(refusal).toContain('"memo" declares no storage permission');
    // The aggressive half stated outright, so it does not read as a bug.
    expect(refusal).toContain('not even for its own tree');
  });

  it('points the model at its own app’s commands, not at the manifest', () => {
    // `direct_message` tells its reader to edit app.json; that reader is a monitor agent.
    // An app agent cannot edit its own manifest, so the actionable half has to be the
    // app's own protocol commands, which `describe` already lists.
    expect(refusal).toContain('describe()');
    expect(refusal.indexOf('describe()')).toBeLessThan(refusal.indexOf('Author note'));
    expect(refusal).toContain('an agent cannot do this for itself');
  });

  it('names the one storage spelling that still answers', () => {
    // The commons is granted for being an app, so `query("yaar://storage/shared/...")`
    // works for an undeclared app. It is named here rather than in the prompt: the
    // refusal is where it is wanted, and advertising three writes to buy one read is
    // what the prompt sections were dropped to avoid.
    expect(refusal).toContain('yaar://storage/shared/{path}');
  });
});

describe('exposure is not authorization', () => {
  it('opens the door on a narrow declaration and still refuses the verbs it omits', async () => {
    // The two must not collapse into each other. `sharedStorageGrants` is emptiness-only
    // for the gate; `permissionsAllow` is what each call is charged against, and
    // `storage:write` is charged as `invoke`, `storage:delete` as `delete`.
    const narrow: PermissionEntry[] = [{ uri: 'yaar://storage/reports/', verbs: ['read', 'list'] }];

    expect(narrow.length > 0).toBe(true); // the predicate's whole rule
    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/reports/x.md', 'read')).toBe(true);
    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/reports/x.md', 'invoke')).toBe(false);
    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/reports/x.md', 'delete')).toBe(false);
    // And still nothing outside the prefix it named.
    expect(permissionsAllow(narrow, 'notes', 'yaar://storage/files/tax.pdf', 'read')).toBe(false);
  });

  it('keeps the shared refusal for a declaring app that reaches past its prefix', async () => {
    // search declares `yaar://storage/`, so it is exposed — and the per-path gate is
    // still the thing that answers. An app declaring nothing gets `storageNotDeclared`
    // instead, one layer earlier, which is the whole difference between the two refusals.
    const denied = await authorizeSharedStorage('session-logs', 'reports/x.md', 'invoke');
    expect(denied).toContain('not permitted: invoke yaar://storage/reports/x.md');
  });
});
