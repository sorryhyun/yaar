/**
 * App protocol logic (app_query and app_command).
 */

import type { AppProtocolRequest } from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { okJson, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { enrichManifestWithUris } from './manifest-utils.js';

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
    if (response.manifest) enrichManifestWithUris(response.manifest, win.id);
    return okJson(response.manifest);
  }

  const response = await actionEmitter.emitAppProtocolRequest(
    windowId,
    { kind: 'query', stateKey },
    5000,
  );
  if (!response) return error('App did not respond (timeout).');
  if (response.kind !== 'query') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  return okJson(response.data);
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
  return okJson(response.result);
}
