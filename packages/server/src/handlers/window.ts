/**
 * Window domain handlers for the verb layer.
 *
 * Maps window operations to the verb layer:
 *
 *   list('yaar://windows/')               → list all windows
 *   invoke('yaar://windows/', ...)        → create window (windowId auto-derived from payload)
 *   describe('yaar://windows/{w}')        → this instance's manual (its live protocol)
 *   read('yaar://windows/{w}')            → view window content/metadata
 *   list('yaar://windows/{w}')            → this window's state keys and commands
 *   invoke('yaar://windows/{w}', ...)     → update, manage, app_query, app_command, app_eval, message
 *   delete('yaar://windows/{w}')          → close window
 *
 *   read('yaar://windows/{w}/state/{k}')       → one state value
 *   invoke('yaar://windows/{w}/commands/{k}')  → run one command (payload = its params)
 *   describe('yaar://windows/{w}/{state,commands}/{k}') → that key's documentation
 *
 * The sub-path URIs are not new promises: `enrichManifestWithUris` has been stamping
 * them onto every key of every live manifest since before any handler implemented
 * them, and a read of one silently returned the whole window.
 */

import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri, ResolvedWindow } from './uri-resolve.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import {
  ok,
  okJson,
  okJsonResource,
  okLinks,
  error,
  getActiveSession,
  assertUri,
  requireAction,
} from './utils.js';
import { formatWindowFlags } from '../features/window/helpers.js';
import { handleCreate } from '../features/window/create.js';
import { handleUpdate } from '../features/window/update.js';
import { handleManage, handleGeometry } from '../features/window/manage.js';
import {
  handleAppQuery,
  handleAppCommand,
  handleAppEval,
  handleAppDescribe,
  fetchLiveManifest,
} from '../features/window/app-protocol.js';
import { listApps } from '../features/apps/discovery.js';
import { buildWindowResourceUri, parseWindowResourceUri } from '../lib/yaar-uri-server.js';
import {
  handleSubscribe,
  handleUnsubscribe,
  handleAppSubscribe,
} from '../features/window/subscribe.js';
import { getMonitorId, requireMonitorId } from '../agents/agent-context.js';
import { actionEmitter } from '../session/action-emitter.js';
import { genId } from '../lib/ids.js';
import { valueOf } from '../session/pending-store.js';
import { defineActions } from './define-actions.js';

function isWindowCollection(resolved: ResolvedUri): resolved is ResolvedWindow & { windowId: '' } {
  return resolved.kind === 'window' && (resolved as ResolvedWindow).windowId === '';
}

/**
 * What a window URI's sub-path names.
 *
 * `enrichManifestWithUris` has been stamping `yaar://windows/{id}/{state,commands}/{key}`
 * onto every key of every live manifest, and no handler implemented it — a read of one
 * of those URIs silently returned the whole window. This is the type that makes the
 * promise real, and `invalid` is why it is three cases rather than two: a sub-path that
 * parses as neither must be refused, not quietly treated as the bare window.
 */
type WindowTarget =
  | { kind: 'window' }
  | { kind: 'resource'; resourceType: 'state' | 'commands'; key: string }
  | { kind: 'invalid'; subPath: string };

function windowTarget(resolved: ResolvedWindow): WindowTarget {
  if (!resolved.subPath) return { kind: 'window' };
  const parsed = parseWindowResourceUri(resolved.sourceUri);
  if (!parsed || !parsed.key) return { kind: 'invalid', subPath: resolved.subPath };
  return { kind: 'resource', resourceType: parsed.resourceType, key: parsed.key };
}

/**
 * The actions that mean something on a window that already exists and has no protocol.
 *
 * Subtracted from the action table rather than listed beside it, for the same reason
 * the schema enum is derived from it: a hand-kept list goes quietly wrong when an
 * action is renamed, and here "quietly wrong" means a markdown window's manual
 * advertises something it cannot do — or omits something it can. `create` is not an
 * operation on a window that already exists; everything app-shaped needs a protocol.
 *
 * Filtering at all is what keeps that manual from carrying the ~3.7KB `invokeSchema`,
 * most of which cannot apply to it.
 */
function nonAppActions(names: readonly string[]): string[] {
  return names.filter((n) => n !== 'create' && !n.startsWith('app_') && n !== 'message');
}

function badSubPath(resolved: ResolvedWindow, subPath: string): VerbResult {
  return error(
    `"${subPath}" is not a window sub-resource. Use yaar://windows/${resolved.windowId}/state/{key} ` +
      `or yaar://windows/${resolved.windowId}/commands/{key}; list("yaar://windows/${resolved.windowId}") ` +
      'shows both.',
  );
}

export function registerWindowHandlers(
  registry: ResourceRegistry,
  getWindowState: () => WindowStateRegistry,
): void {
  const listHandler: ResourceHandler = {
    description: 'List the open windows on your monitor.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      // The caller's monitor, not the session: an agent may only address windows on
      // the monitor it runs on, so listing another desktop's windows offers it URIs
      // that resolve to nothing. Outside a turn (no monitor in context) list them all.
      const windows = getWindowState().listWindows(getMonitorId());
      if (windows.length === 0) return okLinks([]);

      return okLinks(
        windows.map((win) => {
          const windowId = getWindowState().handleMap.getRawWindowId(win.id);
          const parts = [win.content.renderer, `${win.bounds.w}x${win.bounds.h}`];
          if (win.locked) parts.push('locked');
          if (win.minimized) parts.push('minimized');
          if (win.appId) parts.push(`app:${win.appId}`);
          return {
            uri: `yaar://windows/${windowId}`,
            name: win.title || windowId,
            description: parts.join(', '),
          };
        }),
      );
    },
  };
  registry.register('yaar://windows', listHandler);

  // The window actions. The `enum` the model sees is derived from these keys
  // (see invokeSchema below), so a case cannot exist undeclared and a declaration
  // cannot exist without a case.
  const windowActions = defineActions<{ windowId: string; p: Record<string, unknown> }>({
    create: ({ windowId, p }) => handleCreate(windowId, p),
    update: ({ windowId, p }) => handleUpdate(getWindowState(), windowId, p),
    close: ({ windowId }) => handleManage(getWindowState(), windowId, 'close'),
    lock: ({ windowId }) => handleManage(getWindowState(), windowId, 'lock'),
    unlock: ({ windowId }) => handleManage(getWindowState(), windowId, 'unlock'),
    move: ({ windowId, p }) => handleGeometry(getWindowState(), windowId, 'move', p),
    resize: ({ windowId, p }) => handleGeometry(getWindowState(), windowId, 'resize', p),
    app_query: ({ windowId, p }) => handleAppQuery(getWindowState(), windowId, p),
    app_command: ({ windowId, p }) => handleAppCommand(getWindowState(), windowId, p),
    app_eval: ({ windowId, p }) => handleAppEval(getWindowState(), windowId, p),
    message: ({ windowId, p }) => {
      const appId = getWindowState().getAppIdForWindow(windowId);
      if (!appId) return error(`Window "${windowId}" is not an app window.`);
      if (typeof p.message !== 'string' || !p.message)
        return error('"message" (string) is required for message action.');

      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return error('Session not initialized.');

      const messageId = genId('agent-msg');
      const monitorId = requireMonitorId();
      const taggedContent = `<monitor:${monitorId}>\n${p.message}\n</monitor:${monitorId}>`;
      const hook = p.hook === 'response' ? ('response' as const) : undefined;
      pool
        .handleTask({
          type: 'app',
          messageId,
          windowId,
          content: taggedContent,
          monitorId,
          hook,
        })
        .catch((err: unknown) => console.error('[window.message] Failed:', err));

      return ok(
        `Message sent to app "${appId}" via window "${windowId}" (messageId: ${messageId}).`,
      );
    },
    subscribe: ({ windowId, p }) => handleSubscribe(getWindowState(), windowId, p),
    unsubscribe: ({ p }) => handleUnsubscribe(p),
    app_subscribe: ({ windowId, p }) => handleAppSubscribe(getWindowState(), windowId, p),
    app_unsubscribe: ({ p }) => handleUnsubscribe(p),
  });

  /**
   * `invoke` on `yaar://windows/{id}/commands/{key}` — the URI names the command, so
   * the payload is the command's params and nothing else.
   *
   * One spelling, deliberately. `action` and a nested `params` are both refused rather
   * than accepted-and-guessed: two ways to write one call, with unclear precedence
   * between them, is exactly how `invokeActions` drifted from what it dispatched.
   * `timeoutMs` is the one reserved key, because it is transport, not a param.
   */
  function invokeSubResource(
    resolved: ResolvedWindow,
    target: { resourceType: 'state' | 'commands'; key: string },
    payload?: Record<string, unknown>,
  ): Promise<VerbResult> | VerbResult {
    if (target.resourceType === 'state') {
      return error(
        `State is read, not invoked. Use read("${resolved.sourceUri}") for its value. ` +
          'To change it, invoke the command that changes it — ' +
          `list("yaar://windows/${resolved.windowId}") shows them.`,
      );
    }

    const p = { ...(payload ?? {}) };
    if ('action' in p) {
      return error(
        `invoke("${resolved.sourceUri}") takes no "action" — the URI already names the ` +
          "command. Pass the command's params directly, or use " +
          `invoke("yaar://windows/${resolved.windowId}", { action: "app_command", command: "${target.key}", params: {…} }).`,
      );
    }
    if ('params' in p) {
      return error(
        `invoke("${resolved.sourceUri}") takes the command's params directly — the payload ` +
          '*is* `params`. Drop the wrapper: { …params } rather than { params: { …params } }.',
      );
    }

    const timeoutMs = p.timeoutMs;
    delete p.timeoutMs;
    return handleAppCommand(getWindowState(), resolved.windowId, {
      command: target.key,
      params: p,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  // ── yaar://windows/{windowId} — window operations ──
  const windowHandler: ResourceHandler = {
    description:
      'Window resource — a *running* instance (contrast yaar://apps/{id}, the installed app). ' +
      'Use yaar://windows/{windowId} to address windows (monitor is automatic). ' +
      "Describe for this window's manual (its live protocol), read to view content, list for its " +
      'addressable state keys and commands, invoke to create (on bare yaar://windows/), update, ' +
      'manage; delete to close. ' +
      'Sub-paths: read yaar://windows/{windowId}/state/{key} for one state value, invoke ' +
      'yaar://windows/{windowId}/commands/{key} to run one command (payload = its params). ' +
      'Invoke actions: create, update (requires operation), close, lock, unlock, move (x, y), resize (width, height), app_query, app_command, app_eval (devtools previews only), message.',
    verbs: ['describe', 'list', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: windowActions.schema,
        // create fields
        title: { type: 'string' },
        renderer: {
          type: 'string',
          enum: ['markdown', 'html', 'text', 'table', 'iframe', 'component'],
          description:
            'markdown also draws ```mermaid fenced blocks as diagrams — prefer it over describing a flow in prose.',
        },
        content: {},
        x: {
          type: 'number',
          description:
            'Optional. Omit both x and y (the normal case) to get centered, cascaded placement that avoids burying existing windows. Only set these to position a window deliberately.',
        },
        y: { type: 'number', description: 'Optional. See x — omit unless positioning on purpose.' },
        width: {
          type: 'number',
          description: 'Optional. Defaults to 640, or the app’s declared defaultWidth.',
        },
        height: {
          type: 'number',
          description: 'Optional. Defaults to 480, or the app’s declared defaultHeight.',
        },
        minimized: { type: 'boolean' },
        jsonfile: { type: 'string' },
        // update fields
        operation: {
          type: 'string',
          enum: ['append', 'prepend', 'replace', 'insertAt', 'clear'],
          description: 'Required for "update" action.',
        },
        position: { type: 'number' },
        // app_command / app_query fields — the three parameters that carry the entire
        // app protocol, and until now the three least documented in this schema.
        command: {
          type: 'string',
          description:
            "app_command only. A command name from the app's protocol. Discover them with " +
            'list("yaar://windows/{windowId}") or describe("yaar://windows/{windowId}"); ' +
            'describe("yaar://windows/{windowId}/commands/{name}") documents one.',
        },
        params: {
          type: 'object',
          description:
            "app_command only. The command's arguments, shaped by its declared params " +
            'schema (the app rejects a key it did not declare, naming the accepted ones). ' +
            'Omit for a command that takes none.',
        },
        stateKey: {
          type: 'string',
          description:
            'app_query only. A state key from the app\'s protocol; defaults to "manifest", ' +
            'which returns the whole protocol. "__console" is a built-in that returns the ' +
            "iframe's captured console output. Equivalent to " +
            'read("yaar://windows/{windowId}/state/{key}").',
        },
        // app_eval fields
        expression: {
          type: 'string',
          description:
            'app_eval only. JS expression evaluated in the iframe. Devtools preview ' +
            'windows only — refused elsewhere. Result is JSON-serialized, capped at 16KB.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'app_command and app_eval. How long to wait for the app (max 180s; default 30s ' +
            'for app_command, 5s for app_eval). Raise it for slow commands like compile or ' +
            'deploy, and for an expression that awaits a promise or sleeps.',
        },
        // message fields
        message: {
          type: 'string',
          description: 'Message to send to the app agent (for message action)',
        },
        // subscribe fields
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['content', 'interaction', 'close', 'lock', 'unlock', 'move', 'resize', 'title'],
          },
          description: 'Event types to subscribe to (default: content, interaction, close).',
        },
        debounceMs: { type: 'number', description: 'Debounce interval in ms (default: 500).' },
        subscriptionId: { type: 'string', description: 'Subscription ID for unsubscribe.' },
        // app_subscribe fields (declarative app event channels)
        channels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'App event channels to subscribe to (app_subscribe). Use ["*"] for all declared channels. Discover channels via app_query manifest "events".',
        },
        mode: {
          type: 'string',
          enum: ['wake', 'buffer'],
          description:
            'app_subscribe delivery: "wake" (default, notify agent when event fires) or "buffer" (fold into next turn).',
        },
        hook: {
          type: 'string',
          enum: ['response'],
          description: 'Set to "response" to receive a notification when the app agent responds.',
        },
      },
    },

    /**
     * `describe` on a window is *this instance's* manual, not the URI pattern's.
     *
     * No `exists` hook: that one is for the auto-generated describe, and this handler
     * owns its own check below — a window id the caller's monitor does not hold is
     * `No resource at …`, the same answer the hook would have produced.
     *
     * Two protocol sources exist — `protocol.json` on disk and the iframe's own
     * registration — and they diverge after a deploy without a reload. `source` says
     * which one was read, because a describe that does not say makes that divergence
     * invisible: the agent reads a command list, calls a command the running iframe
     * has never heard of, and the error names neither cause.
     */
    async describe(resolved: ResolvedUri): Promise<VerbResult> {
      if (isWindowCollection(resolved)) {
        return okJson({
          uri: resolved.sourceUri,
          description: windowHandler.description,
          verbs: windowHandler.verbs,
          invokeSchema: windowHandler.invokeSchema,
        });
      }
      assertUri(resolved, 'window');

      const target = windowTarget(resolved);
      if (target.kind === 'invalid') return badSubPath(resolved, target.subPath);

      const win = getWindowState().getWindow(resolved.windowId);
      if (!win) {
        return error(`No resource at ${resolved.sourceUri}. Use list to see available windows.`);
      }

      if (target.kind === 'resource') {
        return handleAppDescribe(
          getWindowState(),
          resolved.windowId,
          target.resourceType,
          target.key,
        );
      }

      // A non-app window has no protocol at all. Its manual is the action set, filtered
      // to what this renderer can actually answer — `create` is not an operation on a
      // window that exists, and `jsonfile`/`minimized`/`position` are create-time fields.
      if (win.content.renderer !== 'iframe' || !win.appId) {
        return okJson({
          uri: resolved.sourceUri,
          kind: 'window',
          renderer: win.content.renderer,
          title: win.title,
          verbs: ['describe', 'read', 'invoke', 'delete'],
          actions: nonAppActions(windowActions.names),
          note: 'Not an app window — it has no protocol, so it has no state or command sub-paths.',
        });
      }

      const live = await fetchLiveManifest(getWindowState(), resolved.windowId);
      if (live) {
        return okJson({ uri: resolved.sourceUri, source: 'live', ...live });
      }

      // The iframe has not registered (or did not answer). Fall back to what the app
      // shipped, and say so — a stale manual is useful; a manual that lies about being
      // current is not.
      const apps = await listApps();
      const app = apps.find((a) => a.id === win.appId);
      if (!app?.protocol) {
        return okJson({
          uri: resolved.sourceUri,
          source: 'manifest',
          appId: win.appId,
          state: {},
          commands: {},
          note: 'The app has not registered with the App Protocol and ships no protocol.json.',
        });
      }
      return okJson({
        uri: resolved.sourceUri,
        source: 'manifest',
        appId: win.appId,
        name: app.name,
        ...app.protocol,
        note:
          'Read from the app on disk — the iframe has not registered with the App Protocol, ' +
          'so a deploy since the window opened would not show here.',
      });
    },

    /**
     * `list` on a window is that window's addressable sub-resources.
     *
     * This is a behavior *change*, not only an addition: it used to ignore the window id
     * and return every window on the monitor, which is what `list("yaar://windows")`
     * already does.
     */
    async list(resolved: ResolvedUri): Promise<VerbResult> {
      if (isWindowCollection(resolved)) return listHandler.list!(resolved);
      assertUri(resolved, 'window');

      const target = windowTarget(resolved);
      if (target.kind === 'invalid') return badSubPath(resolved, target.subPath);
      if (target.kind === 'resource') {
        return error(
          `"${resolved.sourceUri}" is a single ${target.resourceType === 'state' ? 'state key' : 'command'}, not a collection. ` +
            `Use ${target.resourceType === 'state' ? 'read' : 'invoke'} on it, or describe for its documentation.`,
        );
      }

      const win = getWindowState().getWindow(resolved.windowId);
      if (!win) return error(`Window "${resolved.windowId}" not found.`);
      if (win.content.renderer !== 'iframe') {
        return error(
          `Window "${resolved.windowId}" is a ${win.content.renderer} window — it has no protocol, ` +
            'so nothing under it is addressable. Use read to see its content.',
        );
      }

      const live = await fetchLiveManifest(getWindowState(), resolved.windowId);
      const apps = live ? [] : await listApps();
      const fallback = win.appId ? apps.find((a) => a.id === win.appId)?.protocol : undefined;
      const manifest = live ?? fallback;
      if (!manifest) {
        return error(
          `Window "${resolved.windowId}" has no protocol — the app has not registered and ships no protocol.json.`,
        );
      }

      const links = [
        ...Object.entries(manifest.state ?? {}).map(([key, desc]) => ({
          uri: buildWindowResourceUri(resolved.windowId, 'state', key),
          name: `state/${key}`,
          description: (desc as { description?: string }).description,
        })),
        ...Object.entries(manifest.commands ?? {}).map(([key, desc]) => ({
          uri: buildWindowResourceUri(resolved.windowId, 'commands', key),
          name: `commands/${key}`,
          description: (desc as { description?: string }).description,
        })),
      ];
      return okLinks(links);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      // Collection-level: yaar://windows/ (bare, no windowId)
      if (isWindowCollection(resolved)) {
        const session = getActiveSession();
        const pool = session.getPool();
        if (!pool) return error('Session not initialized.');

        const monitorId = requireMonitorId();
        const stats = pool.getStats();
        const monitorHandles = new Set(getWindowState().handleMap.listByMonitor(monitorId));
        const windows = getWindowState()
          .listWindows()
          .filter((w) => monitorHandles.has(w.id));

        return okJsonResource('yaar://windows/', {
          monitorId,
          hasMonitorAgent: pool.hasMonitorAgent(monitorId),
          windows: windows.map((w) => ({
            id: w.id,
            title: w.title,
          })),
          stats: {
            totalAgents: stats.totalAgents,
            monitorQueueSize: stats.monitorQueueSize,
          },
        });
      }

      // Window resource: yaar://windows/{windowId}
      assertUri(resolved, 'window');

      const target = windowTarget(resolved);
      if (target.kind === 'invalid') return badSubPath(resolved, target.subPath);
      if (target.kind === 'resource') {
        if (target.resourceType === 'commands') {
          return error(
            `Commands are invoked, not read. Use invoke("${resolved.sourceUri}", { …params }), ` +
              `or describe("${resolved.sourceUri}") for what it does.`,
          );
        }
        return handleAppQuery(getWindowState(), resolved.windowId, { stateKey: target.key });
      }

      const win = getWindowState().getWindow(resolved.windowId);
      if (!win) {
        return error(`Window "${resolved.windowId}" not found. Use list to see available windows.`);
      }

      const windowInfo: Record<string, unknown> & { captureFailure?: string } = {
        id: win.id,
        title: win.title,
        renderer: win.content.renderer,
        content: win.content.data,
        position: { x: win.bounds.x, y: win.bounds.y },
        size: { width: win.bounds.w, height: win.bounds.h },
        locked: win.locked,
        lockedBy: win.lockedBy,
        ...formatWindowFlags(win),
      };

      // For iframe windows, capture a screenshot so the agent can see what's rendered.
      //
      // This used to be skipped for iframe-SDK reads (agentId `iframe:*`, e.g. devtools'
      // viewPreview) because such a read carries no monitor of its own, so the capture went
      // out unaddressed and its feedback never came back — leaving the one tool that builds
      // a window as the only tool that could not look at it. But the caller's monitor was
      // never the right one to ask: the window's own monitor is. Address the window by its
      // resolved, monitor-scoped key and deliver the capture there, exactly as handleAppQuery
      // does. The image itself already survives the trip — POST /api/verb lifts image blocks
      // into `envelope.images` and the iframe SDK hands them back (verb-sdk.ts).
      if (win.content.renderer === 'iframe') {
        const outcome = await actionEmitter.emitActionWithFeedback(
          { type: 'window.capture', windowId: win.id },
          5000,
          undefined,
          getWindowState().getMonitorForWindow(win.id),
        );
        const feedback = valueOf(outcome);
        if (feedback?.success && feedback.imageData) {
          // Omit raw content (compiled HTML blob) — the screenshot is more useful
          const { content: _content, ...infoWithoutContent } = windowInfo;
          return {
            content: [
              {
                type: 'resource',
                resource: {
                  uri: resolved.sourceUri,
                  text: JSON.stringify(infoWithoutContent, null, 2),
                  mimeType: 'application/json',
                },
              },
              { type: 'image', data: feedback.imageData, mimeType: 'image/webp' },
            ],
          };
        }
        // No image. Say why, in the metadata the caller gets anyway: a capture that
        // failed because the canvas was tainted is unfixable by retrying, and one
        // that timed out may well succeed on the next call. Reported as the same
        // empty result, both looked like "it may not have painted yet".
        if (feedback?.captureFailure) {
          windowInfo.captureFailure = feedback.captureFailure;
        }
      }

      return okJsonResource(resolved.sourceUri, windowInfo);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      // A sub-path URI names the command, so it carries no `action` — resolved before
      // requireAction, which would otherwise demand one that must not be there.
      if (!isWindowCollection(resolved)) {
        assertUri(resolved, 'window');
        const target = windowTarget(resolved);
        if (target.kind === 'invalid') return badSubPath(resolved, target.subPath);
        if (target.kind === 'resource') {
          return invokeSubResource(resolved, target, payload);
        }
      }

      const actionErr = requireAction(payload);
      if (actionErr) return actionErr;

      // payload is guaranteed non-undefined after requireAction
      const p = payload!;
      const action = p.action as string;

      // Collection-level invoke: only create (windowId derived from payload)
      if (isWindowCollection(resolved)) {
        if (action === 'create') return handleCreate('', p);
        return error(
          `Action "${action}" requires a window URI (yaar://windows/{windowId}). ` +
            'Only "create" can be invoked on a bare windows URI.',
        );
      }

      assertUri(resolved, 'window');
      return windowActions.dispatch(action, { windowId: resolved.windowId, p });
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'window');
      return handleManage(getWindowState(), resolved.windowId, 'close');
    },
  };
  registry.register('yaar://windows/*', windowHandler);
}
