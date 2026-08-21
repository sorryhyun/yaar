/**
 * Phase 0B — the process's subscriptions do not grow with the number of sessions.
 *
 * Every `LiveSession` used to attach its own listeners to the global `actionEmitter`: nine
 * of them, across `action`, `app-protocol`, `bridge-event`, and the six forwarded
 * session-scoped channels. Node's default warning threshold is ten listeners per channel,
 * so eleven retained sessions in the WebSocket integration suite was enough to print
 * `MaxListenersExceededWarning` — and the warning was the least of it. Every emit walked
 * every session's callback, each of which then had to work out that the event was not for
 * it, which is a thing a listener can only be *trusted* to do.
 *
 * Now there is one subscription per channel for the whole process and a map from session id
 * to sink. These tests pin both halves of that: the count stays flat as sessions come and
 * go, and detaching one session leaves the others reachable.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ServerEventType, type ServerEvent } from '@yaar/shared';
import { actionEmitter } from '../session/action-emitter.js';
import { LiveSession } from '../session/live-session.js';
import { getBroadcastCenter } from '../session/broadcast-center.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId, YaarWebSocket } from '../session/types.js';

/** The channels a session used to subscribe to one-by-one. */
const CHANNELS = [
  'action',
  'app-protocol',
  'bridge-event',
  'approval-request',
  'user-prompt',
  'session-action',
  'verb-subscription',
  'desktop-shortcut',
  'browser-action',
] as const;

/** Listeners currently attached to each channel, as Node counts them. */
function listenerCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const channel of CHANNELS) {
    counts[channel] = actionEmitter.listenerCount(channel);
  }
  return counts;
}

function fakeSocket(sink: ServerEvent[]): YaarWebSocket {
  return {
    readyState: 1, // WS_OPEN
    send: (data: string) => sink.push(JSON.parse(data) as ServerEvent),
  } as unknown as YaarWebSocket;
}

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let created: LiveSession[] = [];
afterEach(async () => {
  for (const session of created) await session.cleanup();
  created = [];
});

describe('0B — one subscription per channel, however many sessions there are', () => {
  it('keeps global listener counts flat while twenty sessions are alive', async () => {
    const before = listenerCounts();

    for (let i = 0; i < 20; i++) {
      created.push(new LiveSession(`sess-router-${i}` as SessionId));
    }

    // Not "grew by less than the threshold" — did not grow. The old shape added 20 per
    // channel here, and the only reason that was survivable is that the process usually
    // has one session.
    expect(listenerCounts()).toEqual(before);
  });

  it('leaves the counts where it found them after every session is cleaned up', async () => {
    const before = listenerCounts();

    for (let i = 0; i < 20; i++) {
      created.push(new LiveSession(`sess-router-cleanup-${i}` as SessionId));
    }
    for (const session of created.splice(0)) await session.cleanup();

    // The other half of the old bug: a session that attached nine listeners and removed
    // eight kept receiving — and re-broadcasting — traffic for a browser that had closed,
    // forever, since nothing else held a reference that would let anyone notice.
    expect(listenerCounts()).toEqual(before);
  });

  it('emits no MaxListenersExceededWarning while many sessions are retained', async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on('warning', onWarning);

    try {
      for (let i = 0; i < 20; i++) {
        created.push(new LiveSession(`sess-router-warn-${i}` as SessionId));
      }
      await settle();
    } finally {
      // Cast: bun-types 1.4.0 declares off/removeListener("memoryPressure") on
      // Process, which hides EventEmitter's generic overloads for other events.
      (process as NodeJS.EventEmitter).removeListener('warning', onWarning);
    }

    expect(warnings).not.toContain('MaxListenersExceededWarning');
  });
});

describe('0B — detaching one session leaves the others reachable', () => {
  it('stops delivering to the departed session and keeps delivering to the rest', async () => {
    const bc = getBroadcastCenter();
    const goingId = 'sess-router-going' as SessionId;
    const stayingId = 'sess-router-staying' as SessionId;
    const going = new LiveSession(goingId);
    const staying = new LiveSession(stayingId);
    created.push(staying);

    const goingEvents: ServerEvent[] = [];
    const stayingEvents: ServerEvent[] = [];
    bc.subscribe('conn-going', fakeSocket(goingEvents), goingId);
    bc.subscribe('conn-staying', fakeSocket(stayingEvents), stayingId);

    try {
      // The departing session's browser closes.
      await going.cleanup();

      // A prompt for each. The one that left must not be reached — its sink is gone from
      // the router's map, which is a stronger statement than "its listener returned early".
      for (const sessionId of [goingId, stayingId]) {
        runWithAgentContext({ agentId: `agent-${sessionId}`, sessionId }, () =>
          actionEmitter.emit('user-prompt', {
            sessionId,
            event: {
              type: ServerEventType.ACTIONS,
              actions: [{ type: 'notification.show', id: 'n', title: 'hi', body: '' }],
              agentId: 'system',
            } as ServerEvent,
          }),
        );
      }
      await settle();

      expect(stayingEvents).toHaveLength(1);
      expect(goingEvents).toHaveLength(0);
    } finally {
      bc.unsubscribe('conn-going');
      bc.unsubscribe('conn-staying');
    }
  });
});
