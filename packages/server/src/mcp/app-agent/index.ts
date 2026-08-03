/**
 * MCP tools for app agents — scoped tools for app protocol communication.
 *
 * Four tools:
 * - describe: read an app's protocol (state keys + commands)
 * - query: read app state via app protocol (also handles app-scoped storage reads)
 * - command: send commands to the app via app protocol (also handles storage write/delete/list)
 * - relay: hand off a message to the monitor agent
 *
 * Storage access is built-in: query/command with storage paths are intercepted server-side
 * and resolved against the app's scoped storage (storage/apps/{appId}/...) automatically.
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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleAppQuery, handleAppCommand } from '../../features/window/app-protocol.js';
import { resolveAppWindowOnMonitor } from '../../features/window/resolve-app-window.js';
import { getWindowId, getMonitorId } from '../../agents/agent-context.js';
import { getActiveSession, getActivePool, ok, okJson, error } from '../../handlers/utils.js';
import { scopedAppStoragePath } from '../../handlers/apps.js';

/**
 * The URI that names what a `storage/...` tool argument actually resolved to.
 *
 * `storage/x` is silently rewritten to this app's own storage. Reporting the
 * resolved URI is what makes the rewrite visible: an agent that asked for
 * `storage/reports/x` and got "not found" otherwise has no way to see that it
 * looked under its own app, not the shared root.
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
 * per door, and this door's is app-relative.
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
import type { VerbResult } from '../../handlers/uri-registry.js';
import { describeApp } from '../../features/apps/describe.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
} from '../../storage/storage-manager.js';
import type { StorageListResult } from '../../storage/types.js';

export const APP_TOOL_NAMES = [
  'mcp__app__query',
  'mcp__app__command',
  'mcp__app__relay',
  'mcp__app__describe',
] as const;

/**
 * Rejection for a storage path that leaves this app's subtree. Worded as the prompt's own
 * promise ("Storage is scoped to this app") so the model reads it as the rule, not a bug.
 */
const STORAGE_PATH_ERROR =
  'invalid storage path. Storage is scoped to this app — paths are relative to your own ' +
  'storage root and may not contain "..".';

/** Resolve the appId for the current window context. */
function getAppId(windowState: WindowStateRegistry, windowId: string): string | undefined {
  return windowState.getAppIdForWindow(windowId);
}

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

export function registerAppAgentTools(server: McpServer): void {
  const getWindowState = (): WindowStateRegistry => getActiveSession().windowState;

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
      description:
        'Query the app state. Pass a stateKey to read specific state, or omit for the app manifest. ' +
        'Use stateKey starting with "storage/" to read from app-scoped storage (e.g. "storage/config.json"). ' +
        'Storage is always YOUR app\'s — "storage/x" resolves to yaar://apps/{yourApp}/storage/x, never the shared root.',
      inputSchema: {
        stateKey: z
          .string()
          .optional()
          .describe(
            'State key to query (omit for manifest). Use "storage/{path}" to read app storage — ' +
              'resolved under your own app, not the shared storage root.',
          ),
        appId: z
          .string()
          .optional()
          .describe(
            'Target another app you are permitted to control (via "controls"). Omit to read your own app.',
          ),
      },
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) return error('no active window context.');

      const windowState = getWindowState();

      // Intercept storage reads — storage is app-scoped, so only your own app.
      if (args.stateKey?.startsWith('storage/') || args.stateKey === 'storage') {
        if (args.appId)
          return error("storage is app-scoped; you cannot read another app's storage.");
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
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
          return error(`${result.error ?? 'read failed.'} (resolved to ${uri})`);
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
      description:
        'Send a command to the app. Specify the command name and optional parameters. ' +
        'Built-in storage commands: "storage:write" (params: {path, content}), ' +
        '"storage:delete" (params: {path}), "storage:list" (params: {path?}). Every storage ' +
        "path — argument and listed result alike — is relative to your own app's storage " +
        'root, so a path from storage:list can be read back as query("storage/{path}").',
      inputSchema: {
        command: z
          .string()
          .describe(
            'Command name to execute. Use "storage:write", "storage:delete", or "storage:list" for app storage.',
          ),
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
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) return error('no active window context.');

      const windowState = getWindowState();

      // Intercept storage commands — storage is app-scoped, so only your own app.
      if (args.command.startsWith('storage:')) {
        if (args.appId)
          return error("storage is app-scoped; you cannot modify another app's storage.");
        const appId = getAppId(windowState, windowId);
        if (!appId) return error('could not resolve appId for this window.');
        const subCommand = args.command.slice('storage:'.length);
        const path = (args.params?.path as string) ?? '';
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
        "An app's manual — its protocol (every state key and command, with schemas) plus its " +
        'SKILL.md if it ships one. The same answer describe("yaar://apps/{id}") gives. ' +
        'Omit appId to describe your own app; pass appId to inspect another app you are permitted to control.',
      inputSchema: {
        appId: z
          .string()
          .optional()
          .describe(
            'App to describe (omit for your own app). Other apps require "controls" permission.',
          ),
      },
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

      // One shape for one verb: this is `describeApp`, the same builder behind
      // describe("yaar://apps/{id}"). It used to assemble a third shape of its own here
      // — distinct from both the verbs door and `read` — so the same question answered
      // differently depending on which tool asked it.
      const facts = await describeApp(targetAppId);
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
          type: 'monitor',
          messageId,
          content: args.message,
          monitorId: getMonitorId(),
        })
        .catch((err) => {
          console.error('[AppAgent] Relay error:', err);
        });

      return ok('Message relayed to monitor agent.');
    },
  );
}
