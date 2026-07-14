/**
 * App protocol logic (app_query and app_command).
 */

import type { AppProtocolRequest, AppProtocolResponse } from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { valueOf, type PendingOutcome } from '../../session/pending-store.js';
import { enrichManifestWithUris } from './manifest-utils.js';
import { beginRequest, endRequest } from './protocol-log.js';

/** Max text size for app protocol results (bytes). Keeps tool output under Claude Code limits. */
const MAX_TEXT_BYTES = 400_000;

/**
 * Reading state is expected to be near-instant, so a short timeout keeps a wedged app
 * from stalling the agent.
 */
const QUERY_TIMEOUT_MS = 5_000;

/**
 * Commands do real work — devtools' `compile`/`typecheck`/`deploy` shell out and routinely
 * run past 5s. The old 5s cap fired first and surfaced a slow build as "App did not respond
 * (timeout)", masking the actual compile error. Callers can raise this per command (see
 * MAX_COMMAND_TIMEOUT_MS); a wedged app still fails, just not prematurely.
 */
const COMMAND_TIMEOUT_MS = 30_000;

/** Ceiling for a caller-supplied command timeout. Must fit inside MAX_REQUEST_DEADLINE_MS. */
export const MAX_COMMAND_TIMEOUT_MS = 180_000;

/** Truncate text to MAX_TEXT_BYTES, appending a note if truncated. */
function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_BYTES) return text;
  return (
    text.slice(0, MAX_TEXT_BYTES) + `\n... (truncated, ${(text.length / 1024).toFixed(0)}KB total)`
  );
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'resource';
      resource:
        | { uri: string; text: string; mimeType?: string }
        | { uri: string; blob: string; mimeType?: string };
    }
  | { type: 'resource_link'; uri: string; name: string; description?: string; mimeType?: string };

/** Check if a value is an array of MCP content blocks. */
function isContentBlocks(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      (((item as Record<string, unknown>).type === 'text' &&
        typeof (item as Record<string, unknown>).text === 'string') ||
        ((item as Record<string, unknown>).type === 'image' &&
          typeof (item as Record<string, unknown>).data === 'string') ||
        ((item as Record<string, unknown>).type === 'resource' &&
          typeof (item as Record<string, unknown>).resource === 'object') ||
        ((item as Record<string, unknown>).type === 'resource_link' &&
          typeof (item as Record<string, unknown>).uri === 'string')),
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

  // Object → JSON text
  if (typeof value === 'object') return ok(truncateText(JSON.stringify(value, null, 2)));

  return ok(String(value));
}

/**
 * Ensure app protocol is ready, waiting if needed. Returns error on timeout.
 *
 * `windowKey` must be the resolved window key (`win.id`), not the raw AI-facing id.
 * Readiness is tracked per window, and a raw id names one window per *monitor* — the
 * same app open on two monitors shares a raw id, so a raw key would let one monitor's
 * registration mark the other's window ready (and vice versa).
 */
async function requireAppReady(
  windowState: WindowStateRegistry,
  windowKey: string,
): Promise<VerbResult | null> {
  const win = windowState.getWindow(windowKey);
  if (win && !win.appProtocol) {
    const ready = await actionEmitter.waitForAppReady(windowKey, 5000);
    if (!ready) return error('App did not register with the App Protocol (timeout).');
  }
  return null;
}

/** Send a request to an app, recording both it and its outcome in the protocol log. */
async function request(
  windowKey: string,
  req: AppProtocolRequest,
  timeoutMs: number,
): Promise<PendingOutcome<AppProtocolResponse>> {
  const entry = beginRequest(windowKey, req);
  const started = Date.now();
  const outcome = await actionEmitter.emitAppProtocolRequest(windowKey, req, timeoutMs);
  endRequest(entry, valueOf(outcome) ?? null, Date.now() - started);
  return outcome;
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
    const outcome = await request(key, { kind: 'manifest' }, QUERY_TIMEOUT_MS);
    if (!outcome.ok) return error(noAnswer(outcome, 'manifest request'));
    const response = outcome.value;
    if (response.kind !== 'manifest') return error('Unexpected response kind.');
    if (response.error) return error(response.error);
    if (response.manifest) enrichManifestWithUris(response.manifest, win.id, windowState.handleMap);
    return wrapAppValue(response.manifest);
  }

  const outcome = await request(key, { kind: 'query', stateKey }, QUERY_TIMEOUT_MS);
  if (!outcome.ok) return error(noAnswer(outcome, `query "${stateKey}"`));
  const response = outcome.value;
  if (response.kind !== 'query') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  return wrapAppValue(response.data);
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
      ? Math.min(Math.max(requested, 1_000), MAX_COMMAND_TIMEOUT_MS)
      : COMMAND_TIMEOUT_MS;

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
