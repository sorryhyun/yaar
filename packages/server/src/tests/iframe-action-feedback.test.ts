/**
 * Actions an iframe app emits must stay answerable.
 *
 * Agents reach the frontend through ToolActionBridge, which stamps the pending
 * request's id onto the action. Iframe apps have no bridge — LiveSession broadcasts
 * their actions itself — and that path used to drop the requestId. An action awaiting
 * feedback is only answerable if the frontend knows which request to answer:
 * `window.capture` reads the id off the action and skips the capture without one, so
 * devtools could open a preview and never screenshot it. The read simply timed out.
 */
import { describe, it, expect } from 'bun:test';
import { ServerEventType, type OSAction, type ServerEvent } from '@yaar/shared';
import { LiveSession } from '../session/live-session.js';
import { getBroadcastCenter } from '../session/broadcast-center.js';
import { actionEmitter } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId, YaarWebSocket } from '../session/types.js';

const SESSION = 'iframe-feedback-session' as SessionId;

/** A socket that records what the session broadcast to it. */
function fakeSocket(sink: ServerEvent[]): YaarWebSocket {
  return {
    readyState: 1, // WS_OPEN
    send: (data: string) => sink.push(JSON.parse(data) as ServerEvent),
  } as unknown as YaarWebSocket;
}

/** Emit `action` as devtools' iframe would, and collect what reached the frontend. */
async function broadcastFromIframe(action: OSAction): Promise<OSAction[]> {
  const events: ServerEvent[] = [];
  const session = new LiveSession(SESSION);
  const bc = getBroadcastCenter();
  bc.subscribe('conn-1', fakeSocket(events), SESSION);
  // A connection receives monitor-scoped events for the monitor it says it is on, and
  // for no other. A real tab says so as it connects (?monitorId= / SUBSCRIBE_MONITOR).
  bc.subscribeToMonitor('conn-1', '0');
  try {
    await runWithAgentContext(
      { agentId: 'iframe:devtools', sessionId: SESSION, monitorId: '0' },
      () => actionEmitter.emitActionWithFeedback(action, 10, SESSION, '0'),
    );
  } finally {
    bc.unsubscribe('conn-1');
    await session.cleanup();
  }
  return events
    .filter((e) => e.type === ServerEventType.ACTIONS)
    .flatMap((e) => (e as unknown as { actions: OSAction[] }).actions);
}

describe('iframe-emitted actions awaiting feedback', () => {
  it('reaches the frontend carrying the requestId to answer', async () => {
    const actions = await broadcastFromIframe({
      type: 'window.capture',
      windowId: '0/devtools-preview-1752345678901',
    } as OSAction);

    const capture = actions.find((a) => a.type === 'window.capture') as
      | (OSAction & { requestId?: string; windowId?: string })
      | undefined;

    expect(capture).toBeDefined();
    // Without this the frontend drops the capture on the floor and the read times out
    // into "Preview window returned no screenshot".
    expect(capture?.requestId).toBeTruthy();
    // The scoped handle still survives the same rewrite.
    expect(capture?.windowId).toBe('0/devtools-preview-1752345678901');
  });

  /**
   * `window.create` is the one action whose handle does not exist until the action is
   * applied, so the handle lookup that brackets it has to happen afterwards. It did not,
   * and the raw id went out — leaving the frontend to key the new window by whichever
   * monitor that tab happened to be looking at. With two monitors the two registries
   * then held the same window under different keys, and every app_query, app_command and
   * __screenshot against it failed with "Window element not found" until it was closed
   * and re-created (issue #48).
   */
  it('reaches the frontend with the handle window.create itself mints', async () => {
    const actions = await broadcastFromIframe({
      type: 'window.create',
      windowId: 'devtools-preview-1752345678902',
      title: '3D Studio (preview)',
      bounds: { x: 225, y: 84, w: 640, h: 480 },
      content: { renderer: 'iframe', data: '/api/storage/apps/devtools/x/dist/index.html' },
    } as OSAction);

    const create = actions.find((a) => a.type === 'window.create') as
      | (OSAction & { windowId?: string })
      | undefined;

    expect(create).toBeDefined();
    expect(create?.windowId).toBe('0/devtools-preview-1752345678902');
  });
});
