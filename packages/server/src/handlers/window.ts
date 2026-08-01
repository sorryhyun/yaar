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
 *
 * Three of those state keys belong to the *window* rather than to the app inside it —
 * `__content`, `__screenshot`, `__console` (see BUILTIN_STATE). They are what a window
 * with no protocol has to list, and what a bare read of an app window is composed of.
 */

import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri, ResolvedWindow } from './uri-resolve.js';
import type { WindowState, WindowStateRegistry } from '../session/window-state.js';
import {
  ok,
  okJson,
  okJsonResource,
  okLinks,
  error,
  prependNote,
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
  RESERVED_COMMAND_KEYS,
  declaredParamNames,
  renderSignature,
} from '../lib/command-signature.js';
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

/**
 * The state keys a *window* answers for, as opposed to the ones the app inside it answers.
 *
 * `__console` is the precedent: a key that has always been addressable, answered without the
 * app's involvement, and documented nowhere but in one param description. Making the set
 * explicit is what lets `list` on a window with no protocol return what it *has* instead of an
 * error about what it lacks — a markdown window is not a failed collection, it is a window
 * whose only addressable value is its content.
 *
 * `__content` and `__screenshot` are answered here, from the registry and from a capture round
 * trip; `__console` is listed here and dispatched to the app path, since the injected
 * app-protocol script is what holds the buffer. The `__` prefix is reserved for this: an app
 * declaring one of these names is shadowed, not merged, because a window's own content is not
 * something the app inside it gets to redefine.
 */
const BUILTIN_STATE = {
  __content: {
    description:
      "This window's content, exactly as the registry holds it — no capture, no round trip " +
      'to the app. This is the field a bare read omits when it returns a screenshot instead.',
    iframeOnly: false,
  },
  __screenshot: {
    description:
      'A capture of what this window is showing right now. Iframe windows only — it is what ' +
      'a bare read of one returns alongside its metadata.',
    iframeOnly: true,
  },
  __console: {
    description:
      "The iframe's captured console output. Answered by the injected app-protocol script, so " +
      'it works before — and without — the app ever registering.',
    iframeOnly: true,
  },
} as const;

type BuiltinStateKey = keyof typeof BUILTIN_STATE;

function isBuiltinStateKey(key: string): key is BuiltinStateKey {
  return Object.prototype.hasOwnProperty.call(BUILTIN_STATE, key);
}

/** The built-in keys that apply to one window — two of the three need an iframe to answer. */
function builtinStateFor(win: WindowState): BuiltinStateKey[] {
  const isIframe = win.content.renderer === 'iframe';
  return (Object.keys(BUILTIN_STATE) as BuiltinStateKey[]).filter(
    (key) => isIframe || !BUILTIN_STATE[key].iframeOnly,
  );
}

/** The built-ins as `list` links — the same shape a protocol state key gets. */
function builtinLinks(windowId: string, win: WindowState) {
  return builtinStateFor(win).map((key) => ({
    uri: buildWindowResourceUri(windowId, 'state', key),
    name: `state/${key}`,
    description: BUILTIN_STATE[key].description,
  }));
}

/**
 * The built-ins as a `describe` section — carried *beside* an app's manifest, never merged
 * into it. Merging would make the app's own manual claim keys the app never declared; the
 * point of naming them is that `describe` and `list` agree on which keys exist, which is
 * exactly the disagreement this section exists to close.
 */
function builtinManual(windowId: string, win: WindowState): Record<string, unknown> {
  return Object.fromEntries(
    builtinStateFor(win).map((key) => [
      key,
      {
        uri: buildWindowResourceUri(windowId, 'state', key),
        description: BUILTIN_STATE[key].description,
      },
    ]),
  );
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
    app_query: ({ windowId, p }) => queryWindowState(windowId, p),
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
   * Ask the frontend for a capture of this window.
   *
   * Addressed by the *window's* monitor, never the caller's: an iframe-SDK read (agentId
   * `iframe:*`, e.g. devtools' viewPreview) carries no monitor of its own, so a capture sent
   * out on the caller's monitor goes unaddressed and its feedback never comes back — which
   * left the one tool that builds a window as the only tool that could not look at it.
   *
   * A failure names its cause: a capture that failed because the canvas was tainted is
   * unfixable by retrying, while one that timed out may well succeed on the next call.
   * Reported as the same empty result, both looked like "it may not have painted yet".
   */
  async function captureWindow(
    win: WindowState,
  ): Promise<{ imageData?: string; captureFailure?: string }> {
    const outcome = await actionEmitter.emitActionWithFeedback(
      { type: 'window.capture', windowId: win.id },
      5000,
      undefined,
      getWindowState().getMonitorForWindow(win.id),
    );
    const feedback = valueOf(outcome);
    if (feedback?.success && feedback.imageData) return { imageData: feedback.imageData };
    return { captureFailure: feedback?.captureFailure };
  }

  /**
   * `read` of a built-in state key.
   *
   * Returns null only for `__console`, whose buffer lives in the injected script — that one
   * falls through to the app path like any declared key. The other two are answered here, and
   * deliberately *before* the app is consulted: a markdown window has no app to ask, and an
   * iframe whose app never registered would otherwise wait out the readiness deadline to be
   * told it cannot answer for a value the OS was holding all along.
   */
  async function readBuiltinState(
    windowId: string,
    win: WindowState,
    key: BuiltinStateKey,
  ): Promise<VerbResult | null> {
    if (!builtinStateFor(win).includes(key)) {
      return error(
        `"${key}" needs an iframe; window "${windowId}" is a ${win.content.renderer} window. ` +
          `list("yaar://windows/${windowId}") shows what this one has.`,
      );
    }

    if (key === '__content') {
      return okJsonResource(buildWindowResourceUri(windowId, 'state', key), {
        renderer: win.content.renderer,
        content: win.content.data,
      });
    }

    if (key === '__screenshot') {
      const { imageData, captureFailure } = await captureWindow(win);
      if (!imageData) {
        return error(
          `Could not capture window "${windowId}"${captureFailure ? ` (${captureFailure})` : ''}.`,
        );
      }
      return { content: [{ type: 'image', data: imageData, mimeType: 'image/webp' }] };
    }

    return null;
  }

  /**
   * One door for `app_query` and for a `state/{key}` read.
   *
   * The invoke schema calls the two equivalent, and they are — so a built-in that answered on
   * only one of them would make that documentation a lie for exactly the keys the app cannot
   * answer for itself.
   */
  async function queryWindowState(
    windowId: string,
    payload: Record<string, unknown>,
  ): Promise<VerbResult> {
    const stateKey = typeof payload.stateKey === 'string' ? payload.stateKey : '';
    if (isBuiltinStateKey(stateKey)) {
      const win = getWindowState().getWindow(windowId);
      if (!win) return error(`Window "${windowId}" not found.`);
      const builtin = await readBuiltinState(windowId, win, stateKey);
      if (builtin) return builtin;
    }
    return handleAppQuery(getWindowState(), windowId, payload);
  }

  /**
   * The manifest entry for one command of one window — the running registration first, the
   * app's shipped `protocol.json` second, and `undefined` when neither knows the name.
   *
   * Same two sources, same order, and the same reason as `describe`: the two diverge after
   * a deploy without a reload, and the live one is what the call is about to reach.
   */
  async function commandDescriptor(windowId: string, command: string): Promise<unknown> {
    // An alias is a name the iframe resolves to a canonical command, so it is not a key of
    // the table — looked up by key alone, every aliased command would look undeclared, and
    // the caller would be refused for a param the command really does declare.
    const lookup = (commands?: Record<string, unknown>): unknown => {
      if (!commands) return undefined;
      const direct = commands[command];
      if (direct) return direct;
      return Object.values(commands).find((entry) =>
        (entry as { aliases?: unknown } | undefined)?.aliases instanceof Array
          ? ((entry as { aliases: unknown[] }).aliases as unknown[]).includes(command)
          : false,
      );
    };

    const live = await fetchLiveManifest(getWindowState(), windowId);
    const fromLive = lookup(live?.commands);
    if (fromLive) return fromLive;

    const win = getWindowState().getWindow(windowId);
    if (!win?.appId) return undefined;
    const app = (await listApps()).find((a) => a.id === win.appId);
    return lookup(app?.protocol?.commands as Record<string, unknown> | undefined);
  }

  /**
   * `invoke` on `yaar://windows/{id}/commands/{key}` — the URI names the command, so
   * the payload is the command's params and nothing else.
   *
   * One spelling, deliberately. `action` and a nested `params` are both refused rather
   * than accepted-and-guessed: two ways to write one call, with unclear precedence
   * between them, is exactly how `invokeActions` drifted from what it dispatched.
   * `timeoutMs` is consumed as transport for the same reason — it is the deadline this
   * call waits on, not something the app was asked.
   *
   * **Unless the command declares one of those names as a param of its own.** The three
   * were reserved on the key name alone, which made every command whose schema declares
   * `params` unreachable through this spelling — `studio-3d.setGeometryParams(id, params,
   * points)` and `devtools.previewCommand(command, params, timeoutMs)` are the two in the
   * tree — and, worse, made `devtools.previewEval(expression, timeoutMs, …)` *silently*
   * wrong: its `timeoutMs` says how long the preview may take to settle, and this function
   * ate it as the transport deadline and told the app nothing. So the reservation is now
   * conditional on the schema, and the schema is only consulted when one of the three
   * names is actually present — the ordinary call pays for no lookup.
   *
   * A command the manifest cannot account for (an app that never registered and ships no
   * protocol.json) keeps the old refusals: a guess in the app's favour would send an
   * undeclared key to a bridge that rejects the whole command for it.
   */
  async function invokeSubResource(
    resolved: ResolvedWindow,
    target: { resourceType: 'state' | 'commands'; key: string },
    payload?: Record<string, unknown>,
  ): Promise<VerbResult> {
    if (target.resourceType === 'state') {
      return error(
        `State is read, not invoked. Use read("${resolved.sourceUri}") for its value. ` +
          'To change it, invoke the command that changes it — ' +
          `list("yaar://windows/${resolved.windowId}") shows them.`,
      );
    }

    const p = { ...(payload ?? {}) };
    const declared = RESERVED_COMMAND_KEYS.some((key) => key in p)
      ? new Set(declaredParamNames(await commandDescriptor(resolved.windowId, target.key)))
      : new Set<string>();

    if ('action' in p && !declared.has('action')) {
      return error(
        `invoke("${resolved.sourceUri}") takes no "action" — the URI already names the ` +
          "command. Pass the command's params directly, or use " +
          `invoke("yaar://windows/${resolved.windowId}", { action: "app_command", command: "${target.key}", params: {…} }).`,
      );
    }
    if ('params' in p && !declared.has('params')) {
      return error(
        `invoke("${resolved.sourceUri}") takes the command's params directly — the payload ` +
          '*is* `params`. Drop the wrapper: { …params } rather than { params: { …params } }. ' +
          `("${target.key}" declares no param of that name — describe("${resolved.sourceUri}") ` +
          'lists the ones it does.)',
      );
    }

    // Transport, unless the command declared a `timeoutMs` of its own — in which case it is
    // both, and deliberately: the app is told how long it may take, and the server waits at
    // least that long rather than cutting off a call it just authorized.
    const timeoutMs = p.timeoutMs;
    if (!declared.has('timeoutMs')) delete p.timeoutMs;

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
      'yaar://windows/{windowId}/commands/{key} to run one command (payload = its params; ' +
      'pass an ARRAY of params to run it once per element, in order, as one call). ' +
      'Every window also answers three state keys of its own, whatever it renders: ' +
      '__content (its content, no capture), __screenshot and __console (iframe windows). ' +
      'A bare read of an iframe window is __content + __screenshot, the screenshot winning. ' +
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
            'which returns the whole protocol. The window\'s own built-ins ("__content", ' +
            '"__screenshot", "__console") are readable here too. Equivalent to ' +
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
        // A built-in is documented here, not asked of the app: the app has never heard of
        // these keys and would answer "unknown state key" for one it does not own.
        if (target.resourceType === 'state' && isBuiltinStateKey(target.key)) {
          if (!builtinStateFor(win).includes(target.key)) {
            return error(
              `"${target.key}" needs an iframe; window "${resolved.windowId}" is a ` +
                `${win.content.renderer} window.`,
            );
          }
          return okJson({
            uri: resolved.sourceUri,
            doc: BUILTIN_STATE[target.key].description,
            source: 'window',
          });
        }
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
      // It still has the window's own state keys, so `list` is a verb it answers.
      if (win.content.renderer !== 'iframe' || !win.appId) {
        return okJson({
          uri: resolved.sourceUri,
          kind: 'window',
          renderer: win.content.renderer,
          title: win.title,
          verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
          actions: nonAppActions(windowActions.names),
          builtinState: builtinManual(resolved.windowId, win),
          note:
            'Not an app window — it has no protocol, so it has no commands and no state ' +
            "beyond the window's own (below).",
        });
      }

      const live = await fetchLiveManifest(getWindowState(), resolved.windowId);
      if (live) {
        return okJson({
          uri: resolved.sourceUri,
          source: 'live',
          ...live,
          builtinState: builtinManual(resolved.windowId, win),
        });
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
          builtinState: builtinManual(resolved.windowId, win),
          note: 'The app has not registered with the App Protocol and ships no protocol.json.',
        });
      }
      return okJson({
        uri: resolved.sourceUri,
        source: 'manifest',
        appId: win.appId,
        name: app.name,
        ...app.protocol,
        builtinState: builtinManual(resolved.windowId, win),
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

      // Every window has the built-ins, so "no protocol" is no longer a failed list — it is
      // a list of what this window does hold. Both of these used to be errors, which made
      // `list` the one verb that answered a question about the app when it was asked a
      // question about the window.
      const builtins = builtinLinks(resolved.windowId, win);
      if (win.content.renderer !== 'iframe') {
        return prependNote(
          okLinks(builtins),
          `a ${win.content.renderer} window — no app, so no protocol state or commands`,
        );
      }

      const live = await fetchLiveManifest(getWindowState(), resolved.windowId);
      const apps = live ? [] : await listApps();
      const fallback = win.appId ? apps.find((a) => a.id === win.appId)?.protocol : undefined;
      const manifest = live ?? fallback;
      if (!manifest) {
        return prependNote(
          okLinks(builtins),
          'the app has not registered with the App Protocol and ships no protocol.json, so ' +
            "only the window's own keys are addressable",
        );
      }

      const links = [
        ...builtins,
        // `__`-named app keys are shadowed by the built-ins, so they are dropped here rather
        // than listed twice under one URI that answers as the window.
        ...Object.entries(manifest.state ?? {})
          .filter(([key]) => !isBuiltinStateKey(key))
          .map(([key, desc]) => ({
            uri: buildWindowResourceUri(resolved.windowId, 'state', key),
            name: `state/${key}`,
            description: (desc as { description?: string }).description,
          })),
        // A command's name is not enough to call it, and `list` is the door an agent
        // reaches for first. The signature rides in `description` rather than in a field
        // of its own because that is the part of a `resource_link` a model is certain to
        // read — and the round trip it saves (a `describe` spent only on learning param
        // names) is the whole point. `renderSignature` returns the bare name when the
        // command declares no schema, so nothing is invented for one that documents none.
        ...Object.entries(manifest.commands ?? {}).map(([key, desc]) => {
          const signature = renderSignature(key, desc);
          const description = (desc as { description?: string }).description;
          return {
            uri: buildWindowResourceUri(resolved.windowId, 'commands', key),
            name: `commands/${key}`,
            description:
              signature === key
                ? description
                : `${signature}${description ? ` — ${description}` : ''}`,
          };
        }),
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
      if (target.kind === 'resource' && target.resourceType === 'commands') {
        return error(
          `Commands are invoked, not read. Use invoke("${resolved.sourceUri}", { …params }), ` +
            `or describe("${resolved.sourceUri}") for what it does.`,
        );
      }

      // Resolved before the sub-path is dispatched, not after: a state key on a window that
      // does not exist should say so here, where the message points at `list`, rather than
      // reach the app path to be told the same thing less usefully.
      const win = getWindowState().getWindow(resolved.windowId);
      if (!win) {
        return error(`Window "${resolved.windowId}" not found. Use list to see available windows.`);
      }

      if (target.kind === 'resource') {
        return queryWindowState(resolved.windowId, { stateKey: target.key });
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

      // A bare read of an iframe window is the composition `__content` + `__screenshot`, with
      // the screenshot winning: the raw content of an app window is a compiled HTML blob, and
      // a picture of what it rendered is the more useful answer by a wide margin.
      //
      // The composition is *named* rather than implied. It used to drop `content` silently
      // whenever a capture happened to succeed, so the shape of "the window's current value"
      // depended on whether the frontend answered in time — and the half that was dropped was
      // addressable by nothing. `__content` is that half, and this says where it went.
      if (win.content.renderer === 'iframe') {
        const { imageData, captureFailure } = await captureWindow(win);
        if (imageData) {
          const { content: _content, ...infoWithoutContent } = windowInfo;
          return {
            content: [
              {
                type: 'resource',
                resource: {
                  uri: resolved.sourceUri,
                  text: JSON.stringify(
                    {
                      ...infoWithoutContent,
                      contentOmitted: `The screenshot below is this window's content. For the raw value, read("${buildWindowResourceUri(resolved.windowId, 'state', '__content')}").`,
                    },
                    null,
                    2,
                  ),
                  mimeType: 'application/json',
                },
              },
              { type: 'image', data: imageData, mimeType: 'image/webp' },
            ],
          };
        }
        if (captureFailure) {
          windowInfo.captureFailure = captureFailure;
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

    /**
     * `delete` closes a window — the *whole* window, which is why a sub-path has to be
     * refused rather than ignored.
     *
     * This was the one verb that never asked what the URI named. Every other one branches
     * on `windowTarget`; `delete` read `resolved.windowId` and closed it, so
     * `delete("yaar://windows/studio-3d/nodes/sleeveL")` — an agent reaching for one node
     * of a 3D scene, addressing it the way `state/{key}` and `commands/{key}` had taught it
     * to — closed the editor. Nothing said no, and the result read as success: the node was
     * gone, along with everything else.
     *
     * The refusals say what delete *does*, not only that the URI is wrong. A message that
     * merely offered `state/{key}` and `commands/{key}` would send an agent that wants one
     * node deleted to `delete("yaar://windows/studio-3d")`, which is the same window close
     * one step later — so both point at the command that removes the thing instead, and
     * name the window close as the separate, deliberate act it is.
     */
    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      if (isWindowCollection(resolved)) {
        return error(
          'delete needs a window URI (yaar://windows/{windowId}) — there is no "close every ' +
            'window" verb. list("yaar://windows") shows the open ones.',
        );
      }

      assertUri(resolved, 'window');
      const target = windowTarget(resolved);
      if (target.kind === 'resource') {
        return error(
          `delete("yaar://windows/${resolved.windowId}") closes the window — it does not remove ` +
            `things inside it, so "${target.resourceType}/${target.key}" cannot be deleted. To ` +
            'remove something the app is holding, invoke the command that removes it: ' +
            `list("yaar://windows/${resolved.windowId}") shows them.`,
        );
      }
      if (target.kind === 'invalid') {
        return error(
          `"${target.subPath}" is not a window sub-resource, and delete on a window URI closes ` +
            'the whole window — so this is refused rather than run against ' +
            `"${resolved.windowId}". To remove something the app is holding, invoke the command ` +
            `that removes it; list("yaar://windows/${resolved.windowId}") shows the commands and ` +
            `state keys it has. To close the window itself: delete("yaar://windows/${resolved.windowId}").`,
        );
      }

      return handleManage(getWindowState(), resolved.windowId, 'close');
    },
  };
  registry.register('yaar://windows/*', windowHandler);
}
