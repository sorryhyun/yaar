/**
 * useMonitorSync — what a tab tells the server when it changes monitors.
 *
 * A switch retargets the connection's subscription (SUBSCRIBE_MONITOR) and sends
 * nothing else. Notably no RESYNC: the snapshot mints fresh iframe tokens, which
 * remounts every app iframe, and the remount replays that window's app commands —
 * side-effectful commands (memo's addMemo) would run again on every switch.
 * Window state and agent streams cross monitors server-side instead (see
 * monitorEventScope in LiveSession), so a switch has nothing to catch up on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook } from '@testing-library/react';
import type { ClientEvent } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import { useMonitorSync } from '@/hooks/use-agent-connection/useMonitorSync';
import { wsManager } from '@/hooks/use-agent-connection/transport-manager';

function fakeOpenSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    sent,
  } as unknown as WebSocket & { sent: string[] };
}

const framesOf = (ws: { sent: string[] }): ClientEvent[] =>
  ws.sent.map((raw) => JSON.parse(raw) as ClientEvent);

describe('useMonitorSync', () => {
  let ws: WebSocket & { sent: string[] };

  beforeEach(() => {
    useDesktopStore.setState({
      monitors: [
        { id: '0', label: 'Monitor 1', createdAt: 0 },
        { id: '1', label: 'Monitor 2', createdAt: 0 },
      ],
      activeMonitorId: '0',
    });
    ws = fakeOpenSocket();
    wsManager.ws = ws;
  });

  afterEach(() => {
    wsManager.ws = null;
  });

  // Drives activeMonitorId directly rather than through the switchMonitor action:
  // the hook watches the field, and another test file replaces the action with a
  // spy on the singleton store, which would leak into this one.
  it('a monitor switch re-subscribes, and sends nothing else', () => {
    const hook = renderHook(() => useMonitorSync());

    useDesktopStore.setState({ activeMonitorId: '1' });

    expect(framesOf(ws).map((f) => f.type)).toEqual(['SUBSCRIBE_MONITOR']);
    expect((framesOf(ws)[0] as { monitorId?: string }).monitorId).toBe('1');
    hook.unmount();
  });

  it('re-asserting the current monitor sends nothing', () => {
    const hook = renderHook(() => useMonitorSync());

    useDesktopStore.setState({ activeMonitorId: '0' });

    expect(ws.sent).toEqual([]);
    hook.unmount();
  });
});
