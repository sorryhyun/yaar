/**
 * MCP tools for app agents — scoped tools for app protocol communication.
 *
 * Four tools:
 * - describe: read an app's protocol (state keys + commands)
 * - query: read app state via app protocol (also handles app-scoped storage reads)
 * - command: send commands to the app via app protocol (also handles storage write/delete/list)
 * - relay: hand off a message to the monitor agent
 *
 * Storage access is built in, for every app. `query`/`command` intercept storage paths
 * server-side and resolve a relative one against the app's scoped storage
 * (storage/apps/{appId}/...), which needs no permission — it is the app's own tree, the
 * same one its iframe writes through `@bundled/yaar`. A path spelled as a
 * `yaar://storage/...` URI names the *shared* tree instead, and is permission-checked per
 * verb: the commons (`yaar://storage/shared/`) is granted for being an app, and anything
 * past it costs an entry in app.json. See ./shared-storage.ts for why the shared door
 * exists, why the built-ins are no longer declaration-gated, and why the shared tree is a
 * URI rather than a second relative spelling.
 *
 * A third spelling is accepted rather than merely printed: `yaar://apps/{id}/storage/...`,
 * the dialect this door emits on every app-scoped result. `appNamespaceStorage` normalizes
 * it into one of the two above — the app's own id or `self` collapses to the relative
 * form, another app's flattens to the URI its grant is written in — so a model that reads
 * a listing and asks for an entry by the name it was shown reaches storage rather than
 * failing as an unknown state key. Accept-only, exactly as at the verb doors: what the
 * branches below then compare, authorize and report is unchanged.
 *
 * Cross-app control: describe/query/command take an optional `appId`. Omitting it (or passing
 * your own id) targets your own window — no permission needed. Passing another app's id targets
 * that app, gated by the caller's app.json `controls` list (and, for command, its command list).
 *
 * ── Why the storage dispatch below is NOT shared with `handlers/apps.ts` ──
 *
 * They look like the same code and are not. `handlers/apps.ts` serves the *verbs* door, where
 * the caller names the appId in the URI and the access chokepoint decides whether they may;
 * this file serves app agents, whose only tools are the four below (see APP_AGENT_TOOL_NAMES)
 * and whose appId is taken from their own window and therefore cannot be named or forged.
 * Different key, different threat model — and every leaf differs accordingly:
 *
 *   - shape:  this door returns raw text/JSON to a model (`ok`/`okJson`); the verbs door
 *             returns resource links, embedded resources with MIME, and base64 image/binary
 *             content items (`okLinks`/`okResource`/`okWithImages`).
 *   - notify: the verbs door calls `subscriptionRegistry.notifyChange`; this one does not.
 *   - grep / base64 `encoding` exist only on the verbs door.
 *   - the two doors' required-path checks and error wordings differ throughout.
 *
 * Only the on-disk layout is genuinely common, so only that is shared: `scopedAppStoragePath`
 * (`appStoragePath` + the `..` guard this door's raw tool arguments need — the verbs door
 * validates earlier, in `parseAppStoragePath`).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { handleAppQuery, handleAppCommand } from '../../features/window/app-protocol.js';
import {
  findStorageOverride,
  overrideNote,
  STORAGE_VERBS,
  type StorageVerb,
} from './storage-override.js';
import { resolveAppWindowOnMonitor } from '../../features/window/resolve-app-window.js';
import { getWindowId, getMonitorId } from '../../agents/agent-context.js';
import { getActiveSession, getActivePool, ok, okJson, error } from '../../handlers/utils.js';
import { scopedAppStoragePath } from '../../handlers/apps.js';

/**
 * The URI that names what a relative `storage/...` tool argument actually resolved to.
 *
 * `storage/x` is rewritten to this app's own storage. Reporting the resolved URI is
 * what makes the rewrite visible: an agent that asked for `storage/reports/x` and got
 * "not found" otherwise has no way to see that it looked under its own app, not the
 * shared root. `sharedStorageHint` is the other half — when the app *may* reach the
 * shared root, a miss here says so instead of leaving the caller to infer it.
 */
function resolvedStorageUri(appId: string, relativePath: string): string {
  return `yaar://apps/${appId}/storage/${relativePath}`;
}

/**
 * The app's own tree, spelled so it cannot be read as the commons.
 *
 * Both trees take a relative path, and only one of them announced which it was: the
 * commons answered `shared/...` and the app's own answered a bare `reports/x.md`, so a
 * listing, a write receipt and a delete receipt all named a file without naming the tree
 * it is in. An agent holding two such paths has nothing in the strings to tell them
 * apart, and a bare path *looks* like a root-relative one — which is what the shared
 * door's paths actually are.
 *
 * So every app-scoped path this door **emits** carries the `app/` prefix that
 * {@link expandStorageShortcut} already accepts on the way back in. It is a spelling of
 * the same relative path, not a folder: `app/reports/x.md` resolves to `reports/x.md`
 * under this app's root, and reads back through either tool unchanged. A bare relative
 * argument still means the same thing it always did — this changes what is printed, not
 * what is accepted.
 */
export function appScopedRef(relativePath: string): string {
  return relativePath ? `app/${relativePath}` : 'app';
}

/**
 * A listing whose paths can be handed straight back to `storage/{path}`.
 *
 * `storageList` answers in storage-root coordinates (`apps/notes/reports/x.md`)
 * because that is the tree it walks, while every path *argument* on this door is
 * relative to the app's own root (`reports/x.md`). So a caller that listed a
 * directory and read one of the results back got "not found" for a file it had just
 * been shown, and had to strip a prefix nothing told it about. One coordinate system
 * per *spelling*: a relative argument is answered app-relative, and the shared
 * `yaar://storage/...` one is answered in root coordinates, which is what it is already
 * written in. Either way, a listed path reads back exactly as it was printed.
 *
 * The app-relative half is printed as `app/{path}` ({@link appScopedRef}) so that the
 * two coordinate systems are told apart by the path itself: `app/reports/x.md` is this
 * app's, `shared/notes.md` is the commons, and neither can be mistaken for the other or
 * for a root-relative path. `expandStorageShortcut` strips the prefix on the way back
 * in, so the round trip is unchanged.
 */
/**
 * An app's storage namespace exists from the moment the app does; the directory on
 * disk is only created by the first write. So a root listing of an app that has never
 * written anything is empty, not missing — {@link StorageListResult.notFound} is the
 * genuine answer for a named subfolder that isn't there, and this is where the root
 * opts out of it.
 */
function emptyIfRootMissing(result: StorageListResult, isRoot: boolean): StorageListResult {
  return !result.success && result.notFound && isRoot ? { success: true, entries: [] } : result;
}

export function appRelativeEntries(appId: string, result: StorageListResult): StorageListResult {
  if (!result.entries) return result;
  const prefix = `apps/${appId}/`;
  return {
    ...result,
    entries: result.entries.map((e) =>
      e.path.startsWith(prefix) ? { ...e, path: appScopedRef(e.path.slice(prefix.length)) } : e,
    ),
  };
}
import type { WindowStateRegistry } from '../../session/window-state.js';
import { genId } from '../../lib/ids.js';
import { getAppMeta, type ControlEntry } from '../../features/apps/discovery.js';
import type { Verb, VerbResult } from '../../handlers/uri-registry.js';
import { describeApp } from '../../features/apps/describe.js';
import { loadAppDocs } from '../../features/apps/docs.js';
import { findProtocolCommand, commandDocument } from '../../handlers/apps/protocol-resource.js';
import { renderPayloadExample } from '../../lib/command-signature.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
} from '../../storage/storage-manager.js';
import type { StorageListResult } from '../../storage/types.js';
import {
  appNamespaceStorage,
  namesSharedStorage,
  sharedStoragePath,
  sharedStorageUri,
  expandStorageShortcut,
  namesCommons,
  authorizeSharedStorage,
  sharedStorageHint,
} from './shared-storage.js';
import { createLogger } from '../../observability/log.js';
import { LARGE_RESULT_META } from '../result-size.js';

const log = createLogger('AppAgent');

export const APP_TOOL_NAMES = [
  'mcp__app__query',
  'mcp__app__command',
  'mcp__app__relay',
  'mcp__app__describe',
] as const;

/**
 * Rejection for a storage path that leaves this app's subtree. Worded as the prompt's own
 * promise ("a relative path is scoped to this app") so the model reads it as the rule, not
 * a bug — and pointing at the spelling that does leave the subtree, since `storage/../x` is
 * what an agent looking for the shared tree types before it knows the URI form exists.
 */
const STORAGE_PATH_ERROR =
  'invalid storage path. Your own tree is "app/{path}" — a relative path is resolved under ' +
  'your own storage root and may not contain "..". The commons is "shared/{path}" (the same ' +
  'as "yaar://storage/shared/{path}") and needs no permission; any other part of the shared ' +
  'tree is named by URI ("yaar://storage/{path}") and requires a covering permission in ' +
  'your app.json.';

/** Rejection for a `yaar://storage/...` argument that names no resource. */
const SHARED_PATH_ERROR =
  'invalid shared storage path: "yaar://storage/{path}" may not contain "..".';

/** Resolve the appId for the current window context. */
function getAppId(windowState: WindowStateRegistry, windowId: string): string | undefined {
  return windowState.getAppIdForWindow(windowId);
}

/**
 * The four descriptions the storage door used to appear in — and no longer does.
 *
 * `query` and `command` are the app *protocol* tools; storage is a door they happen to
 * intercept, and the spellings are long enough (three trees, four verbs, one permission
 * rule) that a description carrying them would be mostly storage.
 *
 * The **system prompt** documents it instead (`agents/profiles/app-agent/index.ts`),
 * where it is assembled once per agent and rendered with that app's own declared reach —
 * which a description, written once for every caller, could never show. So there is
 * exactly one place an agent is told about storage, and these descriptions say nothing
 * about it: two sources would be two things to keep true.
 */
export const APP_TOOL_DESCRIPTIONS = {
  command: 'Send a command to the app. Specify the command name and optional parameters.',
  commandParam: 'Command name to execute.',
  query:
    'Query the app state. Pass a stateKey to read specific state, or omit for the app manifest.',
  queryParam: 'State key to query (omit for manifest).',
} as const;

/**
 * Tell the model a window was opened on its behalf.
 *
 * Auto-open is silent otherwise: the tool answers exactly as it would have for an app
 * that was already running, so the model cannot tell the user why a window appeared, and
 * a `background` app's window is invisible besides. Prepended as its own block rather
 * than folded into the app's answer, which is the app's text and not ours to edit.
 */
function withLaunchNote(result: VerbResult, appId: string, windowId: string): VerbResult {
  return {
    ...result,
    content: [
      {
        type: 'text' as const,
        text: `(No window of "${appId}" was open on this monitor, so one was opened: ${windowId}.)`,
      },
      ...result.content,
    ],
  };
}

/**
 * Hand a relative-path storage call to the app's own override, when it declares one.
 *
 * Asked by both `query` (`storage/{path}` is `storage:read` by another spelling) and
 * `command`, after the path has been normalized to the app's own tree and *only* for
 * that tree or the commons — the gated shared tree never overrides (see
 * `storage-override.ts`). Null means
 * "no override; run the built-in". The app's answer is opened with a note naming the
 * door it went through, since it will not read like the built-in's.
 */
function isStorageVerb(name: string): name is StorageVerb {
  return (STORAGE_VERBS as readonly string[]).includes(name);
}

async function routeStorageOverride(
  windowState: WindowStateRegistry,
  windowId: string,
  appId: string,
  verb: StorageVerb,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<VerbResult | null> {
  const canonical = await findStorageOverride(appId, verb);
  if (!canonical) return null;
  const result = await handleAppCommand(windowState, windowId, {
    command: canonical,
    params,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return {
    ...result,
    content: [{ type: 'text' as const, text: overrideNote(verb, canonical) }, ...result.content],
  };
}

/**
 * One command of an installed app, documented in full — the app agent's spelling of
 * `read('yaar://apps/{id}/protocol/commands/{name}')`.
 *
 * The document itself is the shared `commandDocument`; only the call example is rewritten
 * into this caller's vocabulary, because an app agent runs a command with its `command`
 * tool and has no `invoke` verb to point a window URI at. Rendering the example it *cannot*
 * use would be the same dead end at one remove.
 */
async function describeOneCommand(appId: string, name: string) {
  const found = await findProtocolCommand(appId, name);
  if ('content' in found) return found;

  const { descriptor, defs } = found;
  const payload = renderPayloadExample(descriptor, defs);
  const target = `"${name}"${payload ? `, ${payload}` : ''}`;
  return okJson({
    appId,
    ...commandDocument(name, descriptor, defs, { call: `command(${target})` }),
  });
}

/**
 * The built-in `storage:write` / `storage:delete` answers, one shape for both trees.
 *
 * An app that overrides these answers with its own JSON (`{ path, tree, bytes }` in
 * word-excel's case); the built-in used to answer `"Written to yaar://..."`, so an agent
 * had to know which door it went through before it could read the reply. Now the
 * built-in answers in kind: the `path` the caller spelled, the `uri` it resolved to, and
 * what happened — a caller branches on neither path spelling nor override to parse it.
 */
export function storageWriteAnswer(uri: string, path: string, content: string) {
  return { uri, path, written: true, bytes: Buffer.byteLength(content, 'utf8') };
}

export function storageDeleteAnswer(uri: string, path: string) {
  return { uri, path, deleted: true };
}

/**
 * `storage:write` / `storage:delete` / `storage:list` against the shared tree.
 *
 * A sibling of the app-scoped switch in `command` rather than a shared implementation:
 * the two differ in every leaf that matters — which verb each sub-command needs (the
 * app-scoped tree needs none), which coordinate system the listing answers in, and what
 * a failure is allowed to say. Only the layout is common, and neither door owns that.
 *
 * The verb per sub-command is the one the verbs door would charge for the same work, so
 * `{ "uri": "yaar://storage/reports/", "verbs": ["read", "list"] }` means here what it
 * means there: this app may look and may not write.
 */
async function sharedStorageCommand(
  appId: string,
  subCommand: string,
  arg: string,
  content: unknown,
) {
  const verbs: Record<string, Verb> = {
    read: 'read',
    write: 'invoke',
    delete: 'delete',
    list: 'list',
  };
  const verb = verbs[subCommand];
  if (!verb) {
    return error(
      `Unknown storage command: ${subCommand}. Use storage:read, storage:write, storage:delete, or storage:list.`,
    );
  }

  const path = sharedStoragePath(arg);
  if (path === null) return error(SHARED_PATH_ERROR);
  const denied = await authorizeSharedStorage(appId, path, verb);
  if (denied) return error(denied);
  const uri = sharedStorageUri(path);

  switch (subCommand) {
    case 'read': {
      if (!path) return error('"path" is required for storage:read.');
      const result = await storageRead(path);
      if (!result.success) {
        if (result.isDirectory) {
          const listDenied = await authorizeSharedStorage(appId, path, 'list');
          if (listDenied) return error(listDenied);
          return okJson({ uri, ...(await storageList(path)) });
        }
        return error(`${result.error ?? 'read failed.'} (resolved to ${uri})`);
      }
      return ok(result.content ?? '');
    }
    case 'write': {
      if (typeof content !== 'string') {
        return error('"content" (string) is required for storage:write.');
      }
      const result = await storageWrite(path, content);
      if (!result.success) return error(`${result.error ?? 'write failed.'} (resolved to ${uri})`);
      return okJson(storageWriteAnswer(uri, arg, content));
    }
    case 'delete': {
      if (!path) return error('"path" is required for storage:delete.');
      const result = await storageDelete(path);
      if (!result.success) return error(`${result.error ?? 'delete failed.'} (resolved to ${uri})`);
      return okJson(storageDeleteAnswer(uri, arg));
    }
    default: {
      // Root-relative entries, the coordinate system this spelling is already in: each
      // path reads back as `yaar://storage/{path}` with nothing to strip or prepend.
      return okJson({ uri, ...(await storageList(path)) });
    }
  }
}

export function registerAppAgentTools(server: McpServer): void {
  const getWindowState = (): WindowStateRegistry => getActiveSession().windowState;
  const docs = APP_TOOL_DESCRIPTIONS; // storage is documented in the prompt, not here

  /**
   * Resolve which window a query/command should target.
   * - No appId (or appId === own) → the caller's own window; no permission needed.
   * - A foreign appId → requires the caller's app.json to list it under "controls".
   *   Reuses an open window of that app if one exists, otherwise auto-launches one.
   */
  const resolveTarget = async (
    ownWindowId: string,
    targetAppId: string | undefined,
  ): Promise<
    | {
        ok: true;
        windowId: string;
        ownAppId?: string;
        foreign: boolean;
        entry?: ControlEntry;
        /** This call opened the window; the caller reports it (see withLaunchNote). */
        launched?: boolean;
      }
    | { ok: false; error: string }
  > => {
    const session = getActiveSession();
    const ownAppId = getAppId(session.windowState, ownWindowId);
    if (!targetAppId || targetAppId === ownAppId) {
      return { ok: true, windowId: ownWindowId, ownAppId, foreign: false };
    }
    if (!ownAppId) {
      return { ok: false, error: 'could not resolve your appId; cannot target another app.' };
    }
    const meta = await getAppMeta(ownAppId);
    const entry = meta?.controls?.find((c) => c.appId === targetAppId);
    if (!entry) {
      const allowed = (meta?.controls ?? []).map((c) => c.appId);
      return {
        ok: false,
        error:
          `app "${ownAppId}" is not permitted to control "${targetAppId}". ` +
          (allowed.length ? `Permitted apps: ${allowed.join(', ')}. ` : '') +
          `Add "${targetAppId}" to "controls" in ${ownAppId}'s app.json.`,
      };
    }
    // Resolve a live window for the target on the caller's own monitor, opening one if
    // it has none — the app agent holds no window verbs, so this is its only way to
    // reach an app the user has not already opened. Never reach across monitors:
    // monitor N's apps are not monitor M's to drive. Shared with `direct_message`, which
    // gates the launch differently; see resolve-app-window.ts.
    const monitorId = session.windowState.getMonitorForWindow(ownWindowId);
    if (!monitorId) {
      return {
        ok: false,
        error: `could not resolve the monitor of your own window (${ownWindowId}); cannot target another app.`,
      };
    }
    const resolved = await resolveAppWindowOnMonitor(session, monitorId, targetAppId, {
      launch: true,
      background: entry.background,
    });
    if (!resolved.found) {
      return { ok: false, error: `app "${targetAppId}" could not be opened to control.` };
    }
    return {
      ok: true,
      windowId: resolved.windowId,
      ownAppId,
      foreign: true,
      entry,
      launched: resolved.launched,
    };
  };

  // query — query app state, manifest, or app-scoped storage
  server.registerTool(
    'query',
    {
      description: docs.query,
      inputSchema: {
        stateKey: z.string().optional().describe(docs.queryParam),
        appId: z
          .string()
          .optional()
          .describe(
            'Target another app you are permitted to control (via "controls"). Omit to read your own app.',
          ),
      },
      _meta: LARGE_RESULT_META,
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) return error('no active window context.');

      const windowState = getWindowState();

      // Normalize the dialect this door *emits* into the two it already speaks. Every
      // app-scoped result names `yaar://apps/{id}/storage/{path}`, so that is the spelling
      // a model echoes back — and it used to reach neither branch below, falling through
      // to the app protocol to fail as an unknown state key. Rewriting here rather than
      // adding a third branch is deliberate: own tree becomes the relative form (no
      // permission, exposure-gated), another app's becomes the flat form its grant is
      // written in, and both are then handled by the code that already decides those cases.
      let stateKey = args.stateKey;
      // The two relative shortcuts, expanded before the URI dialect below so that only
      // the *typed* spelling is redirected: `storage/shared/x` is the commons, and
      // `storage/app/x` is the own tree (see `expandStorageShortcut`).
      if (stateKey?.startsWith('storage/')) {
        const expanded = expandStorageShortcut(stateKey.slice('storage/'.length));
        stateKey = namesSharedStorage(expanded)
          ? expanded
          : expanded
            ? `storage/${expanded}`
            : 'storage';
      }
      if (stateKey?.startsWith('yaar://apps/')) {
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        const target = appNamespaceStorage(stateKey, appId);
        if (target?.kind === 'invalid') return error(STORAGE_PATH_ERROR);
        if (target?.kind === 'own') stateKey = target.path ? `storage/${target.path}` : 'storage';
        if (target?.kind === 'foreign') stateKey = target.uri;
      }

      // Intercept shared-tree reads — a `yaar://storage/...` URI names the storage root,
      // and past the commons is admitted only by what app.json declares. Checked before the relative
      // branch, which would otherwise never see it (a URI is not a `storage/` path).
      if (stateKey && namesSharedStorage(stateKey)) {
        if (args.appId)
          return error('shared storage is not addressed per app — drop appId to read it.');
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        const path = sharedStoragePath(stateKey);
        if (path === null) return error(SHARED_PATH_ERROR);
        // The commons is ungated, so it is the app's to override like its own tree.
        if (namesCommons(sharedStorageUri(path))) {
          const overridden = await routeStorageOverride(
            windowState,
            windowId,
            appId,
            path === 'shared' ? 'list' : 'read',
            { path: sharedStorageUri(path) },
          );
          if (overridden) return { ...overridden };
        }
        // The root is a listing and a file is a read, so they are different verbs and an
        // app.json may well grant one without the other.
        const denied = await authorizeSharedStorage(appId, path, path ? 'read' : 'list');
        if (denied) return error(denied);
        const uri = sharedStorageUri(path);
        if (!path) {
          // Entries come back in storage-root coordinates, which is this spelling's own
          // coordinate system — each reads back directly as `yaar://storage/{path}`.
          return okJson({ uri, ...(await storageList('')) });
        }
        const result = await storageRead(path);
        if (!result.success) {
          // A directory is the wrong shape for this verb, not a missing file — and this
          // is how the tree gets walked, so dead-ending here made every subdirectory a
          // wall. `query` listed the root and nothing below it: the read said "use list
          // instead", naming a verb this door does not have, and descending meant
          // knowing to switch to `command storage:list`. Fall through to the listing,
          // re-authorized as `list` — a grant may cover one verb and not the other, so
          // the recovery has to ask the gate again rather than ride the `read` check.
          if (result.isDirectory) {
            const listDenied = await authorizeSharedStorage(appId, path, 'list');
            if (listDenied) return error(listDenied);
            return okJson({ uri, ...(await storageList(path)) });
          }
          return error(`${result.error ?? 'read failed.'} (resolved to ${uri})`);
        }
        return ok(result.content ?? '');
      }

      // Intercept storage reads — a relative path is app-scoped, so only your own app.
      if (stateKey?.startsWith('storage/') || stateKey === 'storage') {
        if (args.appId)
          return error("storage is app-scoped; you cannot read another app's storage.");
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        // No permission check on this branch, and none to add: a relative path is confined
        // to `storage/apps/{appId}/` by `scopedAppStoragePath` below, which is the app's
        // own tree — granted for being an app, exactly as it is for the app's iframe. The
        // *shared* branch above is where a permission is owed, and it asks for one.
        const relativePath = stateKey === 'storage' ? '' : stateKey.slice('storage/'.length);
        const scoped = scopedAppStoragePath(appId, relativePath);
        if (!scoped) return error(STORAGE_PATH_ERROR);
        const uri = resolvedStorageUri(appId, relativePath);
        const overridden = await routeStorageOverride(
          windowState,
          windowId,
          appId,
          relativePath ? 'read' : 'list',
          { path: relativePath },
        );
        if (overridden) return { ...overridden };
        if (!relativePath) {
          // List root storage
          const result = emptyIfRootMissing(await storageList(scoped), true);
          return okJson({ uri, ...appRelativeEntries(appId, result) });
        }
        const result = await storageRead(scoped);
        if (!result.success) {
          // Descend rather than dead-end, as on the shared branch above. No gate to
          // re-ask here: app-scoped storage is granted for being an app, so the same
          // caller that may read a file may list the folder holding it.
          if (result.isDirectory) {
            const listed = await storageList(scoped);
            return okJson({ uri, ...appRelativeEntries(appId, listed) });
          }
          const hint = await sharedStorageHint(appId, relativePath, 'read');
          return error(`${result.error ?? 'read failed.'} (resolved to ${uri})${hint}`);
        }
        return ok(result.content ?? '');
      }

      const target = await resolveTarget(windowId, args.appId);
      if (!target.ok) return error(target.error);

      const result = await handleAppQuery(windowState, target.windowId, {
        stateKey,
      });
      return {
        ...(target.launched ? withLaunchNote(result, args.appId!, target.windowId) : result),
      };
    },
  );

  // command — send a command to the app or manage app-scoped storage
  server.registerTool(
    'command',
    {
      description: docs.command,
      inputSchema: {
        command: z.string().describe(docs.commandParam),
        params: z.record(z.string(), z.unknown()).optional().describe('Command parameters'),
        appId: z
          .string()
          .optional()
          .describe(
            'Target another app you are permitted to control (via "controls"). Omit to drive your own app.',
          ),
        timeoutMs: z
          .number()
          .optional()
          .describe(
            'How long to wait for the app to respond. Defaults to 30s; raise it (max 180s) for ' +
              'commands that do real work, like a compile or a deploy.',
          ),
      },
      _meta: LARGE_RESULT_META,
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) return error('no active window context.');

      const windowState = getWindowState();

      // Intercept storage commands — a relative path is app-scoped, so only your own app
      // and no permission owed; a `yaar://storage/...` one names the shared tree, where
      // everything past the commons is gated on app.json by `sharedStorageCommand`.
      if (args.command.startsWith('storage:')) {
        if (args.appId)
          return error("storage is app-scoped; you cannot modify another app's storage.");
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        const subCommand = args.command.slice('storage:'.length);
        let path = (args.params?.path as string) ?? '';

        // `shared/x` is the commons and `app/x` the own tree, exactly as in `query`.
        if (!path.startsWith('yaar://')) path = expandStorageShortcut(path);

        // The same normalization `query` applies, for the same reason: `storage:list`
        // reports `yaar://apps/{id}/storage/{path}` as the `uri` of what it listed, and a
        // caller that writes back to a path it was shown must reach the tree it was shown.
        // Own tree collapses to the relative form the switch below already speaks;
        // another app's becomes the flat URI `sharedStorageCommand` authorizes.
        if (path.startsWith('yaar://apps/')) {
          const target = appNamespaceStorage(path, appId);
          if (target?.kind === 'invalid') return error(STORAGE_PATH_ERROR);
          if (target?.kind === 'own') path = target.path;
          if (target?.kind === 'foreign') path = target.uri;
        }

        if (namesSharedStorage(path)) {
          // Same door as the relative form for the commons — no gate there to guard.
          if (isStorageVerb(subCommand) && namesCommons(path)) {
            const overridden = await routeStorageOverride(
              windowState,
              windowId,
              appId,
              subCommand,
              { ...(args.params ?? {}), path },
              args.timeoutMs,
            );
            if (overridden) return { ...overridden };
          }
          return sharedStorageCommand(appId, subCommand, path, args.params?.content);
        }
        const scoped = scopedAppStoragePath(appId, path);
        if (!scoped) return error(STORAGE_PATH_ERROR);
        const uri = resolvedStorageUri(appId, path);

        if (isStorageVerb(subCommand)) {
          const overridden = await routeStorageOverride(
            windowState,
            windowId,
            appId,
            subCommand,
            { ...(args.params ?? {}), path },
            args.timeoutMs,
          );
          if (overridden) return { ...overridden };
        }

        switch (subCommand) {
          case 'read': {
            // `query(stateKey: "storage/{path}")` by its command name, so that the four
            // verbs are one vocabulary an app can override uniformly (see storage-override.ts).
            if (!path) return error('"path" is required for storage:read.');
            const result = await storageRead(scoped);
            if (!result.success) {
              if (result.isDirectory) {
                const listed = await storageList(scoped);
                return okJson({ uri, ...appRelativeEntries(appId, listed) });
              }
              const hint = await sharedStorageHint(appId, path, 'read');
              return error(`${result.error ?? 'read failed.'} (resolved to ${uri})${hint}`);
            }
            return ok(result.content ?? '');
          }
          case 'write': {
            const content = args.params?.content;
            if (typeof content !== 'string') {
              return error('"content" (string) is required for storage:write.');
            }
            const result = await storageWrite(scoped, content);
            if (!result.success) {
              return error(`${result.error ?? 'write failed.'} (resolved to ${uri})`);
            }
            return okJson(storageWriteAnswer(uri, appScopedRef(path), content));
          }
          case 'delete': {
            if (!path) return error('"path" is required for storage:delete.');
            const result = await storageDelete(scoped);
            if (!result.success) {
              return error(`${result.error ?? 'delete failed.'} (resolved to ${uri})`);
            }
            return okJson(storageDeleteAnswer(uri, appScopedRef(path)));
          }
          case 'list': {
            const result = emptyIfRootMissing(await storageList(scoped), !path);
            return okJson({ uri, ...appRelativeEntries(appId, result) });
          }
          default:
            return error(
              `Unknown storage command: ${subCommand}. Use storage:read, storage:write, storage:delete, or storage:list.`,
            );
        }
      }

      const target = await resolveTarget(windowId, args.appId);
      if (!target.ok) return error(target.error);
      if (
        target.foreign &&
        target.entry?.commands &&
        !target.entry.commands.includes(args.command)
      ) {
        return error(
          `app "${target.ownAppId}" is not permitted to run "${args.command}" on "${args.appId}". ` +
            `Permitted commands: ${target.entry.commands.join(', ')}.`,
        );
      }

      const result = await handleAppCommand(windowState, target.windowId, {
        command: args.command,
        params: args.params,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      });
      return {
        ...(target.launched ? withLaunchNote(result, args.appId!, target.windowId) : result),
      };
    },
  );

  // describe — read an app's protocol (state + commands); own app by default,
  // or a controllable app when appId is passed and permitted.
  server.registerTool(
    'describe',
    {
      description:
        "An app's manual — its SKILL.md if it ships one, plus an index of its protocol: " +
        "every state key and every command's call signature with its opening sentence, " +
        'and an index of its topic docs when it ships any. ' +
        'Pass `command` to get one command in full instead, with its complete parameter schema — ' +
        'that is the door to use when a signature leaves you unsure, not a second full describe. ' +
        'Pass `topic` to get one topic doc in full, by the name the index shows. ' +
        'Omit appId to describe your own app; pass appId to inspect another app you are permitted to control.',
      inputSchema: {
        appId: z
          .string()
          .optional()
          .describe(
            'App to describe (omit for your own app). Other apps require "controls" permission.',
          ),
        command: z
          .string()
          .optional()
          .describe(
            'One command to document in full (name as it appears in the index), instead of the whole manual.',
          ),
        topic: z
          .string()
          .optional()
          .describe(
            'One topic doc to read in full (name as it appears in the docs index), instead of the whole manual.',
          ),
      },
      _meta: LARGE_RESULT_META,
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) return error('no active window context.');
      const ownAppId = getAppId(getWindowState(), windowId);
      const targetAppId = args.appId ?? ownAppId;
      if (!targetAppId) return error('could not resolve appId.');

      // Describing a foreign app requires "controls" permission.
      if (args.appId && args.appId !== ownAppId) {
        const meta = ownAppId ? await getAppMeta(ownAppId) : null;
        if (!meta?.controls?.some((c) => c.appId === args.appId)) {
          return error(
            `app "${ownAppId ?? '?'}" is not permitted to describe "${args.appId}". ` +
              `Add it to "controls" in app.json.`,
          );
        }
      }

      // One command in full. An app agent holds four scoped tools and no `read` verb, so
      // the per-command URI the verbs door points at (`yaar://apps/{id}/protocol/
      // commands/{name}`) is a door it cannot open — this param is that door, reached
      // through the one tool it does hold, answering with the same builder.
      if (args.command) {
        return describeOneCommand(targetAppId, args.command);
      }

      // One topic doc in full — the app agent's spelling of
      // `read('yaar://apps/{id}/docs/{name}')`, for the same reason as `command` above:
      // this caller holds no `read` verb, so the URI the docs index would otherwise
      // point at is a door it cannot open. The lookup is against *all* topics, not the
      // runtime-filtered index: a `dev` topic asked for by name is answered, same as
      // the verbs door.
      if (args.topic) {
        const topics = await loadAppDocs(targetAppId);
        const topic = topics.find((t) => t.name === args.topic);
        if (!topic) {
          return error(
            `"${args.topic}" is not a doc topic of "${targetAppId}". ` +
              (topics.length
                ? `Declared: ${topics.map((t) => t.name).join(', ')}.`
                : 'It ships no topic docs at all.'),
          );
        }
        return ok(topic.body);
      }

      // One shape for one verb: this is `describeApp`, the same builder behind
      // describe("yaar://apps/{id}"). It used to assemble a third shape of its own here
      // — distinct from both the verbs door and `read` — so the same question answered
      // differently depending on which tool asked it.
      //
      // `protocol: 'index'` rather than the verbs door's 'names': that door's caller can
      // follow a URI to the index and this one cannot, and a pointer its holder cannot
      // follow is the exact dead end the protocol split exists to remove.
      const facts = await describeApp(targetAppId, { protocol: 'index' });
      if (!facts) return error(`app "${targetAppId}" not found.`);
      if (!facts.protocol && !facts.skill) {
        return error(`app "${targetAppId}" exposes no protocol and ships no SKILL.md.`);
      }
      return okJson({ uri: `yaar://apps/${targetAppId}`, appId: targetAppId, ...facts });
    },
  );

  // relay — hand off to the monitor agent.
  //
  // Not routed through `mcp/messaging`'s direct_message despite that file's header calling
  // itself a generalization of this tool: it is not a superset of this path, it is a
  // different one. `to: "monitor"` wraps the content in `<from:app:{id}>` attribution tags
  // before enqueueing it — this tool sends the message verbatim, so delegating would change
  // what the monitor agent's model actually reads. It also stamps a `dm` messageId (vs
  // `relay`) and returns different text to the caller's model. Sharing the 4 enqueue lines
  // under a `{ wrap, prefix }` flag would cost more than it saves.
  //
  // The real dedup here is deleting `relay` in favour of direct_message(to: "monitor",
  // end_turn: true) — but that removes a tool from the app agent's toolset and changes the
  // monitor's input, so it belongs in its own change, not a refactor.
  server.registerTool(
    'relay',
    {
      description:
        'Hand off a message to the monitor agent when the request is outside your app domain.',
      inputSchema: {
        message: z.string().describe('Message to send to the monitor agent'),
      },
    },
    async (args) => {
      const pool = getActivePool();
      if (!pool) return error('no active pool.');

      const messageId = genId('relay');
      pool
        .handleTask({
          requestedType: 'monitor',
          kind: 'relay',
          messageId,
          content: args.message,
          monitorId: getMonitorId(),
        })
        .catch((err) => {
          log.error('relay failed', { err });
        });

      return ok('Message relayed to monitor agent.');
    },
  );
}
