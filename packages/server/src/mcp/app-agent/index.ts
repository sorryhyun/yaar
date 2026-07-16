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
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleAppQuery, handleAppCommand } from '../../features/window/app-protocol.js';
import { handleCreate } from '../../features/window/create.js';
import { getWindowId, getMonitorId } from '../../agents/agent-context.js';
import { getActiveSession, getActivePool, ok, okJson, error } from '../../handlers/utils.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { genId } from '../../lib/ids.js';
import { getAppMeta, listApps, type ControlEntry } from '../../features/apps/discovery.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
} from '../../storage/storage-manager.js';

export const APP_TOOL_NAMES = [
  'mcp__app__query',
  'mcp__app__command',
  'mcp__app__relay',
  'mcp__app__describe',
] as const;

/** Resolve the appId for the current window context. */
function getAppId(windowState: WindowStateRegistry, windowId: string): string | undefined {
  return windowState.getAppIdForWindow(windowId);
}

/** Convert an app-relative path to the app-scoped storage path. */
function appStoragePath(appId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\//, '');
  return `apps/${appId}/${clean}`;
}

/**
 * Open a window for a controllable app that has no live window yet, so a
 * cross-app query/command has an iframe to talk to. Uses the appId as the
 * deterministic windowId (mirrors deriveWindowId) and blocks on iframe load
 * (handleCreate awaits load feedback). Returns the windowId, or undefined if
 * the app is unknown or the launch failed.
 */
async function launchControlledApp(appId: string): Promise<string | undefined> {
  const app = (await listApps()).find((a) => a.id === appId);
  if (!app) return undefined;
  const result = await handleCreate(appId, {
    title: app.name ?? appId,
    renderer: 'iframe',
    content: `yaar://apps/${appId}`,
    appId,
  });
  return result.isError ? undefined : appId;
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
    | { ok: true; windowId: string; ownAppId?: string; foreign: boolean; entry?: ControlEntry }
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
    // Resolve a live window for the target on the caller's own monitor: prefer one
    // the target's app agent has already touched, else any open window of that app
    // on this monitor, else launch a fresh one so the caller doesn't have to open it
    // manually first. Never reach across monitors — monitor N's apps are not monitor
    // M's to drive.
    const monitorId = session.windowState.getMonitorForWindow(ownWindowId);
    if (!monitorId) {
      return {
        ok: false,
        error: `could not resolve the monitor of your own window (${ownWindowId}); cannot target another app.`,
      };
    }
    let windowId =
      session.getPool()?.getActiveAppWindow(monitorId, targetAppId) ??
      session.windowState
        .listWindows()
        .find(
          (w) =>
            w.appId === targetAppId && session.windowState.getMonitorForWindow(w.id) === monitorId,
        )?.id;
    if (!windowId) {
      windowId = await launchControlledApp(targetAppId);
    }
    if (!windowId) {
      return { ok: false, error: `app "${targetAppId}" could not be opened to control.` };
    }
    return { ok: true, windowId, ownAppId, foreign: true, entry };
  };

  // query — query app state, manifest, or app-scoped storage
  server.registerTool(
    'query',
    {
      description:
        'Query the app state. Pass a stateKey to read specific state, or omit for the app manifest. ' +
        'Use stateKey starting with "storage/" to read from app-scoped storage (e.g. "storage/config.json").',
      inputSchema: {
        stateKey: z
          .string()
          .optional()
          .describe(
            'State key to query (omit for manifest). Use "storage/{path}" to read app storage.',
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
        if (!relativePath) {
          // List root storage
          const result = await storageList(appStoragePath(appId, ''));
          return okJson(result);
        }
        const result = await storageRead(appStoragePath(appId, relativePath));
        if (!result.success) return error(result.error ?? 'read failed.');
        return ok(result.content ?? '');
      }

      const target = await resolveTarget(windowId, args.appId);
      if (!target.ok) return error(target.error);

      return {
        ...(await handleAppQuery(windowState, target.windowId, {
          stateKey: args.stateKey,
        })),
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
        '"storage:delete" (params: {path}), "storage:list" (params: {path?}).',
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

        switch (subCommand) {
          case 'write': {
            const content = args.params?.content;
            if (typeof content !== 'string') {
              return error('"content" (string) is required for storage:write.');
            }
            const result = await storageWrite(appStoragePath(appId, path), content);
            if (!result.success) return error(result.error ?? 'write failed.');
            return ok(`Written to ${path}`);
          }
          case 'delete': {
            if (!path) return error('"path" is required for storage:delete.');
            const result = await storageDelete(appStoragePath(appId, path));
            if (!result.success) return error(result.error ?? 'delete failed.');
            return ok(`Deleted ${path}`);
          }
          case 'list': {
            const result = await storageList(appStoragePath(appId, path));
            return okJson(result);
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

      return {
        ...(await handleAppCommand(windowState, target.windowId, {
          command: args.command,
          params: args.params,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        })),
      };
    },
  );

  // describe — read an app's protocol (state + commands); own app by default,
  // or a controllable app when appId is passed and permitted.
  server.registerTool(
    'describe',
    {
      description:
        "Describe an app's protocol — its available state keys and commands. " +
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

      const apps = await listApps();
      const app = apps.find((a) => a.id === targetAppId);
      if (!app) return error(`app "${targetAppId}" not found.`);
      if (!app.protocol) return error(`app "${targetAppId}" exposes no protocol.`);
      return okJson({ appId: app.id, name: app.name, ...app.protocol });
    },
  );

  // relay — hand off to the monitor agent
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
