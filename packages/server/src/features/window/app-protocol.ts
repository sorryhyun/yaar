/**
 * App protocol logic (app_query and app_command).
 */

import type { AppProtocolRequest, AppProtocolResponse } from '@yaar/shared';
import { isPreviewAppId } from '@yaar/shared';
import type { ContentBlock, VerbResult } from '../../handlers/uri-registry.js';
import { isContentBlocks } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { ok, error, getActiveSessionId } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { valueOf, type PendingOutcome } from '../../session/pending-store.js';
import { deadlines } from '../../config.js';
import { enrichManifestWithUris } from './manifest-utils.js';
import { beginRequest, endRequest } from './protocol-log.js';

/** Max text size for app protocol results (bytes). Keeps tool output under Claude Code limits. */
const MAX_TEXT_BYTES = 400_000;

// The deadlines this file waits on — `deadlines.appQueryMs` (reading state is near-instant),
// `deadlines.appCommandMs` (commands do real work: devtools' compile/deploy shells out), and
// `deadlines.appCommandMinMs` (the floor under a caller's own timeout) — live in config.ts,
// so a liveness test can shrink them to tens of milliseconds. Read at call time, never
// captured into a module constant.

/** Ceiling for a caller-supplied command timeout. Must fit inside MAX_REQUEST_DEADLINE_MS. */
export const MAX_COMMAND_TIMEOUT_MS = 180_000;

/** Truncate text to MAX_TEXT_BYTES, appending a note if truncated. */
function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_BYTES) return text;
  return (
    text.slice(0, MAX_TEXT_BYTES) + `\n... (truncated, ${(text.length / 1024).toFixed(0)}KB total)`
  );
}

/**
 * Wrap an app protocol value into a VerbResult.
 *
 * Apps can return content blocks directly for fine-grained control:
 *   [{type:'text', text:'...'}, {type:'image', data:'base64', mimeType:'image/webp'}]
 *
 * Plain values (strings, objects) are auto-wrapped and truncated.
 */
function wrapAppValue(value: unknown): VerbResult {
  if (value === undefined || value === null) return ok('Done.');

  // Content blocks — pass through directly
  if (isContentBlocks(value)) {
    // Truncate text/resource blocks, pass image/resource_link blocks as-is
    const content = value.map((block): ContentBlock => {
      if (block.type === 'text') return { ...block, text: truncateText(block.text) };
      if (block.type === 'resource' && 'text' in block.resource) {
        return {
          type: 'resource',
          resource: { ...block.resource, text: truncateText(block.resource.text) },
        };
      }
      return block;
    });
    return { content };
  }

  // Plain string
  if (typeof value === 'string') return ok(truncateText(value));

  // Object → a JSON text block for the model/logs PLUS a lossless
  // `structuredContent` copy for programmatic consumers (app→app SDK calls,
  // non-model MCP clients). The text block stays truncated for token budget and
  // log readability; the structured copy is the full, untruncated value so a
  // truncated preview never costs a downstream reader real data. Trade-off: the
  // payload rides the wire twice — accepted for the typed-access guarantee.
  //
  // `structuredContent` is object-only (MCP contract), so bare arrays get the
  // text-only shape and still round-trip via `toEnvelope`'s tryParseJson.
  if (typeof value === 'object') {
    const content = [{ type: 'text' as const, text: truncateText(JSON.stringify(value, null, 2)) }];
    return Array.isArray(value)
      ? { content }
      : { content, structuredContent: value as Record<string, unknown> };
  }

  return ok(String(value));
}

/**
 * Ensure app protocol is ready, waiting if needed. Returns error on timeout.
 *
 * `windowKey` must be the resolved window key (`win.id`), not the raw AI-facing id.
 * Readiness is tracked per session *and* per window: a raw id names one window per
 * monitor (so the same app on two monitors would share a key), and a window key names one
 * window per *session* (so two browsers on the same YAAR would share one). Both scopes are
 * needed — the second one is why a fresh session used to find an app "already ready" that
 * had never registered in it, and send its first command into an iframe that was not
 * listening.
 *
 * The fast path stays fast: a window this session has already seen register carries
 * `appProtocol` in its own registry, so a re-entrant command never re-enters the wait.
 */
async function requireAppReady(
  windowState: WindowStateRegistry,
  windowKey: string,
  sessionId?: string,
): Promise<VerbResult | null> {
  const win = windowState.getWindow(windowKey);
  if (win && !win.appProtocol) {
    // The session named here must be the one the `windowState` above came from —
    // `getActiveSessionId()` resolves it the same way (`getWindowState()` in mcp/server.ts
    // and handlers/index.ts do): agent context first, default session outside a turn.
    // Anything else would gate the readiness check on a *different* session's desktop.
    const ready = await actionEmitter.waitForAppReady(
      sessionId ?? getActiveSessionId(),
      windowKey,
      deadlines.appReadyMs,
    );
    if (!ready) return error('App did not register with the App Protocol (timeout).');
  }
  return null;
}

/** Send a request to an app, recording both it and its outcome in the protocol log. */
async function request(
  windowKey: string,
  req: AppProtocolRequest,
  timeoutMs: number,
  sessionId?: string,
): Promise<PendingOutcome<AppProtocolResponse>> {
  const entry = beginRequest(windowKey, req);
  const started = Date.now();
  const outcome = await actionEmitter.emitAppProtocolRequest(windowKey, req, timeoutMs, sessionId);
  endRequest(entry, valueOf(outcome) ?? null, Date.now() - started);
  return outcome;
}

/**
 * Read every declared state key for a handoff snapshot.
 *
 * This is server lifecycle work, not an agent tool call: it names the session explicitly
 * and returns `null` unless the whole snapshot is authoritative. A partial snapshot could
 * turn one timed-out key into a false "state changed" notice on the next invocation.
 */
export async function captureDeclaredAppState(
  windowState: WindowStateRegistry,
  windowId: string,
  stateKeys: readonly string[],
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const win = windowState.getWindow(windowId);
  if (!win || win.content.renderer !== 'iframe') return null;

  const key = win.id;
  const readyErr = await requireAppReady(windowState, key, sessionId);
  if (readyErr) return null;

  const entries = await Promise.all(
    [...stateKeys].sort().map(async (stateKey) => {
      const outcome = await request(
        key,
        { kind: 'query', stateKey },
        deadlines.appQueryMs,
        sessionId,
      );
      if (!outcome.ok) return null;
      const response = outcome.value;
      if (response.kind !== 'query' || response.error) return null;
      return [stateKey, response.data] as const;
    }),
  );
  if (entries.some((entry) => entry === null)) return null;
  return Object.fromEntries(entries as Array<readonly [string, unknown]>);
}

/** The message an agent sees when an app never answered. */
function noAnswer(outcome: { ok: false; reason: 'timeout' | 'cancelled' }, what: string): string {
  return outcome.reason === 'cancelled'
    ? `The session ended before the app answered the ${what}.`
    : `App did not respond to the ${what} (timeout).`;
}

/** Handle app_query: query app state or manifest via the app protocol. */
export async function handleAppQuery(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  // Address the window by its resolved key (monitor-scoped), never the raw id the
  // caller passed: the frontend routes a raw id by whichever monitor the *user* is
  // looking at, which is not necessarily the monitor of the agent that asked.
  const key = win.id;
  const stateKey = (payload.stateKey as string) || 'manifest';

  // '__console' is a built-in state key answered by the injected app-protocol
  // script (reads the console-capture buffer) — it works even when the app
  // never called app.register(), so don't wait for app-ready.
  if (stateKey !== '__console') {
    const readyErr = await requireAppReady(windowState, key);
    if (readyErr) return readyErr;
  }

  if (stateKey === 'manifest') {
    const outcome = await request(key, { kind: 'manifest' }, deadlines.appQueryMs);
    if (!outcome.ok) return error(noAnswer(outcome, 'manifest request'));
    const response = outcome.value;
    if (response.kind !== 'manifest') return error('Unexpected response kind.');
    if (response.error) return error(response.error);
    if (response.manifest) enrichManifestWithUris(response.manifest, win.id, windowState.handleMap);
    return wrapAppValue(response.manifest);
  }

  const outcome = await request(key, { kind: 'query', stateKey }, deadlines.appQueryMs);
  if (!outcome.ok) return error(noAnswer(outcome, `query "${stateKey}"`));
  const response = outcome.value;
  if (response.kind !== 'query') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  return wrapAppValue(response.data);
}

/**
 * Window ids devtools gives its preview windows (`apps/devtools/src/preview.ts`).
 * The id is monitor-scoped by the time it reaches us (`0/devtools-preview-x`), so
 * match the last segment, not the whole string.
 */
const PREVIEW_WINDOW_PREFIX = 'devtools-preview-';

/**
 * Whether a window is a devtools preview — the only kind `app_eval` may touch.
 *
 * Two conditions, both required, because either alone is forgeable by an ordinary
 * app: any app can ask for a window named `devtools-preview-x`, and a window can
 * carry no appId at all (devtools' own scratch preview does). So the id must look
 * like a preview *and* the identity must not be a real app's — a window claiming
 * the preview name while running as `notes` is exactly the confusion this rejects.
 */
export function isPreviewWindow(win: { id: string; appId?: string }): boolean {
  const segment = win.id.slice(win.id.lastIndexOf('/') + 1);
  if (!segment.startsWith(PREVIEW_WINDOW_PREFIX)) return false;
  return win.appId === undefined || isPreviewAppId(win.appId);
}

/**
 * Handle app_eval: evaluate an expression inside a devtools preview iframe.
 *
 * Scoped hard to preview windows. A preview is a disposable sandbox devtools just
 * built from source it is already editing, so eval there grants an agent nothing it
 * could not get by editing the source and recompiling — it only saves the four-step
 * loop (plant debug command → compile → read → remove → recompile) that asking a
 * running app a one-off question otherwise costs. That reasoning does not extend to
 * a user's real, installed apps holding real data, which is why this is not a
 * general app-protocol verb and why the guard is a hard refusal rather than a
 * permission an app could be granted.
 */
export async function handleAppEval(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  if (!isPreviewWindow(win)) {
    return error(
      `app_eval is refused for window "${windowId}": it is not a devtools preview. ` +
        'Arbitrary evaluation is allowed only in the throwaway preview windows devtools ' +
        'builds from source (window id "devtools-preview-{projectId}"). To drive a real ' +
        'app, use its declared commands via app_command.',
    );
  }

  const expression = payload.expression;
  if (typeof expression !== 'string' || !expression.trim()) {
    return error('"expression" (non-empty string) is required for app_eval.');
  }

  // No requireAppReady: the eval responder is part of the injected app-protocol
  // script and answers whether or not the app ever called app.register(). Waiting
  // on readiness would make eval unusable for exactly the broken-app case it is
  // most useful for. (Same reasoning as the built-in `__console` state key.)
  const outcome = await request(win.id, { kind: 'eval', expression }, deadlines.appQueryMs);
  if (!outcome.ok) return error(noAnswer(outcome, 'eval request'));
  const response = outcome.value;
  if (response.kind !== 'eval') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  return ok(response.value ?? 'undefined');
}

/** Handle app_command: send a command to an app via the app protocol. */
export async function handleAppCommand(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  if (!payload.command) return error('"command" is required for app_command.');

  // See handleAppQuery: address the window by its monitor-scoped key, not the raw id.
  const key = win.id;
  const readyErr = await requireAppReady(windowState, key);
  if (readyErr) return readyErr;

  const req: AppProtocolRequest = {
    kind: 'command',
    command: payload.command as string,
    params: payload.params as Record<string, unknown> | undefined,
  };

  const requested = payload.timeoutMs as number | undefined;
  const timeoutMs =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.min(Math.max(requested, deadlines.appCommandMinMs), MAX_COMMAND_TIMEOUT_MS)
      : deadlines.appCommandMs;

  const outcome = await request(key, req, timeoutMs);
  if (!outcome.ok) {
    if (outcome.reason === 'cancelled')
      return error('The session ended before the app answered the command.');
    return error(
      `App did not respond within ${(timeoutMs / 1000).toFixed(0)}s. If this command is ` +
        `legitimately slow, retry with a larger timeoutMs (max ${MAX_COMMAND_TIMEOUT_MS / 1000}s).`,
    );
  }
  const response = outcome.value;
  if (response.kind !== 'command') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  windowState.recordAppCommand(key, req);
  return wrapAppValue(response.result);
}
