/**
 * App protocol logic (app_query and app_command).
 */

import type { AppProtocolRequest } from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { enrichManifestWithUris } from './manifest-utils.js';

/** Max text size for app protocol results (bytes). Keeps tool output under Claude Code limits. */
const MAX_TEXT_BYTES = 40_000;

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

/** Ensure app protocol is ready, waiting if needed. Returns error on timeout. */
async function requireAppReady(
  windowState: WindowStateRegistry,
  windowId: string,
): Promise<VerbResult | null> {
  const win = windowState.getWindow(windowId);
  if (win && !win.appProtocol) {
    const ready = await actionEmitter.waitForAppReady(windowId, 5000);
    if (!ready) return error('App did not register with the App Protocol (timeout).');
  }
  return null;
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

  const readyErr = await requireAppReady(windowState, windowId);
  if (readyErr) return readyErr;

  const stateKey = (payload.stateKey as string) || 'manifest';

  if (stateKey === 'manifest') {
    const response = await actionEmitter.emitAppProtocolRequest(
      windowId,
      { kind: 'manifest' },
      5000,
    );
    if (!response) return error('App did not respond to manifest request (timeout).');
    if (response.kind !== 'manifest') return error('Unexpected response kind.');
    if (response.error) return error(response.error);
    if (response.manifest) enrichManifestWithUris(response.manifest, win.id, windowState.handleMap);
    return wrapAppValue(response.manifest);
  }

  const response = await actionEmitter.emitAppProtocolRequest(
    windowId,
    { kind: 'query', stateKey },
    5000,
  );
  if (!response) return error('App did not respond (timeout).');
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

  const readyErr = await requireAppReady(windowState, windowId);
  if (readyErr) return readyErr;

  const request: AppProtocolRequest = {
    kind: 'command',
    command: payload.command as string,
    params: payload.params as Record<string, unknown> | undefined,
  };

  const response = await actionEmitter.emitAppProtocolRequest(windowId, request, 5000);
  if (!response) return error('App did not respond (timeout).');
  if (response.kind !== 'command') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  windowState.recordAppCommand(windowId, request);
  return wrapAppValue(response.result);
}
