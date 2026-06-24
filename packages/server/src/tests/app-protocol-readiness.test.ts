/**
 * Regression tests for app-protocol readiness key reconciliation.
 *
 * The frontend reports APP_PROTOCOL_READY with the monitor-scoped window key
 * (e.g. "0/ai-chat", taken from the window element's data-window-id), while
 * app_query/app_command wait on the raw AI-facing id ("ai-chat"). The server's
 * READY handler must normalize the scoped key to the raw id before calling
 * setAppProtocol()/notifyAppReady(), otherwise windows stored under their raw id
 * (e.g. devtools preview windows created via the iframe-SDK proxy, which have no
 * monitor context at create time) never register as ready and every subsequent
 * app_query/app_command times out.
 */

import { describe, it, expect } from 'bun:test';
import { WindowStateRegistry } from '../session/window-state.js';
import type { OSAction } from '@yaar/shared';

function createIframeWindow(reg: WindowStateRegistry, windowId: string, monitorId?: string) {
  const action = {
    type: 'window.create',
    windowId,
    title: windowId,
    bounds: { x: 0, y: 0, w: 500, h: 400 },
    content: { renderer: 'iframe', data: 'https://example.test/app.html' },
  } as unknown as OSAction;
  reg.handleAction(action, monitorId);
}

describe('app-protocol readiness key reconciliation', () => {
  it('marks a raw-stored window ready when READY arrives with the scoped key', () => {
    const reg = new WindowStateRegistry();
    // Preview window: created without a monitor context (iframe-SDK proxy) → stored under raw id.
    createIframeWindow(reg, 'ai-chat');

    // The buggy path: setAppProtocol with the scoped key is a no-op (no handle mapping exists).
    reg.setAppProtocol('0/ai-chat');
    expect(reg.getWindow('ai-chat')?.appProtocol ?? false).toBe(false);

    // The fix: normalize the scoped key to the raw id first.
    const rawId = reg.handleMap.getRawWindowId('0/ai-chat');
    expect(rawId).toBe('ai-chat');
    reg.setAppProtocol(rawId);
    expect(reg.getWindow('ai-chat')?.appProtocol).toBe(true);
  });

  it('still marks a monitor-scoped window ready after normalization', () => {
    const reg = new WindowStateRegistry();
    // Normal app window: created with a monitor context → stored under a scoped handle.
    createIframeWindow(reg, 'dock', '0');

    const rawId = reg.handleMap.getRawWindowId('0/dock');
    expect(rawId).toBe('dock');
    reg.setAppProtocol(rawId);
    // Resolvable by both the raw id and the scoped handle.
    expect(reg.getWindow('dock')?.appProtocol).toBe(true);
    expect(reg.getWindow('0/dock')?.appProtocol).toBe(true);
  });

  it('getRawWindowId is a no-op for an already-raw id', () => {
    const reg = new WindowStateRegistry();
    expect(reg.handleMap.getRawWindowId('ai-chat')).toBe('ai-chat');
  });
});
