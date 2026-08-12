/**
 * MCP tools for app agents — scoped tools for app protocol communication.
 *
 * Four tools:
 * - describe: read an app's protocol (state keys + commands)
 * - query: read app state via app protocol (also handles app-scoped storage reads)
 * - command: send commands to the app via app protocol (also handles storage write/delete/list)
 * - relay: hand off a message to the monitor agent
 *
 * Storage access is *declared*, not built in. `query`/`command` intercept storage paths
 * server-side and resolve a relative one against the app's scoped storage
 * (storage/apps/{appId}/...), but only for an app whose app.json declares an entry under
 * `yaar://storage/`; every other app is refused at the door and reaches storage through a
 * command its own `protocol.json` declares. A path spelled as a `yaar://storage/...` URI
 * names the *shared* tree instead, and is additionally permission-checked per verb — see
 * ./shared-storage.ts for the exposure/authorization split, why the shared door exists,
 * and why it is a URI rather than a second relative spelling.
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

function appRelativeEntries(appId: string, result: StorageListResult): StorageListResult {
  if (!result.entries) return result;
  const prefix = `apps/${appId}/`;
  return {
    ...result,
    entries: result.entries.map((e) =>
      e.path.startsWith(prefix) ? { ...e, path: e.path.slice(prefix.length) } : e,
    ),
  };
}
import type { WindowStateRegistry } from '../../session/window-state.js';
import { genId } from '../../lib/ids.js';
import { getAppMeta, type ControlEntry } from '../../features/apps/discovery.js';
import type { Verb, VerbResult } from '../../handlers/uri-registry.js';
import { describeApp } from '../../features/apps/describe.js';
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
  namesSharedStorage,
  sharedStoragePath,
  sharedStorageUri,
  authorizeSharedStorage,
  sharedStorageHint,
  declaresSharedStorage,
  storageNotDeclared,
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
  'invalid storage path. A relative path is scoped to this app — it is resolved under your ' +
  'own storage root and may not contain "..". To reach the shared storage tree, name it by ' +
  'URI ("yaar://storage/{path}"), which requires a covering permission in your app.json.';

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
 * intercept. Documenting it here meant documenting it for every app, including the ones
 * refused at execution, and the only fix from inside a description would have been to
 * build all four per app: an appId resolution and an uncached `getAppMeta` read on every
 * `app`-namespace MCP request, since the modern era builds a server per request.
 *
 * The conditional lives in the **system prompt** instead (`agents/profiles/app-agent.ts`),
 * where it is computed once per agent, from the same predicate, and where the door is
 * already described in full. So there is exactly one place that decides whether an agent
 * is told about storage, and these descriptions say nothing about it at all — for a
 * declaring app either, which is the point: two sources would be two things to keep true.
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
  const verbs: Record<string, Verb> = { write: 'invoke', delete: 'delete', list: 'list' };
  const verb = verbs[subCommand];
  if (!verb) {
    return error(
      `Unknown storage command: ${subCommand}. Use storage:write, storage:delete, or storage:list.`,
    );
  }

  const path = sharedStoragePath(arg);
  if (path === null) return error(SHARED_PATH_ERROR);
  const denied = await authorizeSharedStorage(appId, path, verb);
  if (denied) return error(denied);
  const uri = sharedStorageUri(path);

  switch (subCommand) {
    case 'write': {
      if (typeof content !== 'string') {
        return error('"content" (string) is required for storage:write.');
      }
      const result = await storageWrite(path, content);
      if (!result.success) return error(`${result.error ?? 'write failed.'} (resolved to ${uri})`);
      return ok(`Written to ${uri}`);
    }
    case 'delete': {
      if (!path) return error('"path" is required for storage:delete.');
      const result = await storageDelete(path);
      if (!result.success) return error(`${result.error ?? 'delete failed.'} (resolved to ${uri})`);
      return ok(`Deleted ${uri}`);
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

      // Intercept shared-tree reads — a `yaar://storage/...` URI names the storage root,
      // and is admitted only by what app.json declares. Checked before the relative
      // branch, which would otherwise never see it (a URI is not a `storage/` path).
      if (args.stateKey && namesSharedStorage(args.stateKey)) {
        if (args.appId)
          return error('shared storage is not addressed per app — drop appId to read it.');
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        const path = sharedStoragePath(args.stateKey);
        if (path === null) return error(SHARED_PATH_ERROR);
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
      if (args.stateKey?.startsWith('storage/') || args.stateKey === 'storage') {
        if (args.appId)
          return error("storage is app-scoped; you cannot read another app's storage.");
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        // The exposure gate. The relative spelling is gated as well as the `storage:*`
        // commands, or `query("storage")` — which falls through to a listing below —
        // would leave the door open for reads and make the gate cosmetic. The *shared*
        // branch above is deliberately not gated: the commons is granted for being an
        // app, and `authorizeSharedStorage` already refuses the rest of that tree by name.
        if (!(await declaresSharedStorage(appId))) {
          return error(storageNotDeclared(appId, `query("${args.stateKey}")`));
        }
        const relativePath =
          args.stateKey === 'storage' ? '' : args.stateKey.slice('storage/'.length);
        const scoped = scopedAppStoragePath(appId, relativePath);
        if (!scoped) return error(STORAGE_PATH_ERROR);
        const uri = resolvedStorageUri(appId, relativePath);
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
        stateKey: args.stateKey,
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

      // Intercept storage commands — a relative path is app-scoped, so only your own app;
      // a `yaar://storage/...` one names the shared tree and is gated on app.json.
      //
      // appId → exposure → spelling, in that order. The split on `namesSharedStorage`
      // used to come first, which put the app-scoped branch beyond any check at all; the
      // exposure gate governs both branches, so it has to be asked before the split.
      if (args.command.startsWith('storage:')) {
        if (args.appId)
          return error("storage is app-scoped; you cannot modify another app's storage.");
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        if (!(await declaresSharedStorage(appId))) {
          return error(storageNotDeclared(appId, `command("${args.command}")`));
        }
        const subCommand = args.command.slice('storage:'.length);
        const path = (args.params?.path as string) ?? '';
        if (namesSharedStorage(path)) {
          return sharedStorageCommand(appId, subCommand, path, args.params?.content);
        }
        const scoped = scopedAppStoragePath(appId, path);
        if (!scoped) return error(STORAGE_PATH_ERROR);
        const uri = resolvedStorageUri(appId, path);

        switch (subCommand) {
          case 'write': {
            const content = args.params?.content;
            if (typeof content !== 'string') {
              return error('"content" (string) is required for storage:write.');
            }
            const result = await storageWrite(scoped, content);
            if (!result.success) {
              return error(`${result.error ?? 'write failed.'} (resolved to ${uri})`);
            }
            return ok(`Written to ${uri}`);
          }
          case 'delete': {
            if (!path) return error('"path" is required for storage:delete.');
            const result = await storageDelete(scoped);
            if (!result.success) {
              return error(`${result.error ?? 'delete failed.'} (resolved to ${uri})`);
            }
            return ok(`Deleted ${uri}`);
          }
          case 'list': {
            const result = emptyIfRootMissing(await storageList(scoped), !path);
            return okJson({ uri, ...appRelativeEntries(appId, result) });
          }
          default:
            return error(
              `Unknown storage command: ${subCommand}. Use storage:write, storage:delete, or storage:list.`,
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
        "every state key and every command's call signature with its opening sentence. " +
        'Pass `command` to get one command in full instead, with its complete parameter schema — ' +
        'that is the door to use when a signature leaves you unsure, not a second full describe. ' +
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
