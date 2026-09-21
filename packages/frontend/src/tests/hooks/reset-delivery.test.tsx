/**
 * A context reset is a delivery, not a gesture.
 *
 * `reset()` used to put the frame on the wire, ignore whether that worked, and clear the
 * desktop regardless. `send` returning true only means the frame reached *our* end of the
 * socket, and a phone coming back from another app routinely holds one whose peer is long
 * gone — `recoverAfterResume` exists because of exactly that. So the transcript emptied,
 * the toast appeared, and the server never heard a word: the next message was answered by
 * the conversation the button exists to end.
 *
 * The rule this pins: a reset goes into the outbox, like a user message, and stays there
 * until the server says it has it. The server dedups, so the resend is safe — see
 * `packages/server/src/tests/message-delivery.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClientEventType, type ClientEvent } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import { reset } from '@/hooks/useAgentConnection';
import { wsManager } from '@/lib/transport/transport-manager';

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

describe('reset — held until the server acknowledges it', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      outbox: [],
      messageStatuses: {},
      cliHistory: {
        '0': [{ id: 'c1', type: 'user', content: 'hi', monitorId: '0', timestamp: 0 }],
      },
      activeMonitorId: '0',
      windows: {},
    });
  });

  afterEach(() => {
    wsManager.ws = null;
  });

  it('sends the reset with an id, and holds it in the outbox', () => {
    const ws = fakeOpenSocket();
    wsManager.ws = ws;
    reset('0');

    const frame = framesOf(ws).find((f) => f.type === ClientEventType.RESET) as
      | { monitorId?: string; messageId?: string }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame!.monitorId).toBe('0');
    // The id is the whole mechanism: without one there is nothing for the server to ack
    // and nothing for the outbox to settle.
    const messageId = frame!.messageId;
    expect(messageId).toBeTruthy();

    const outbox = useDesktopStore.getState().pendingOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].messageId).toBe(messageId!);
  });

  it('keeps holding it when the socket could not take it, and clears the desktop anyway', () => {
    // No socket at all — the same outcome a dead peer produces, reached by the one door a
    // test can open. Before the outbox, this reset simply ceased to exist.
    wsManager.ws = null;

    reset('0');

    expect(useDesktopStore.getState().pendingOutbox()).toHaveLength(1);
    // Still cleared on the spot. The ack is ordinarily immediate but `resetSession` is not,
    // and a reset button that leaves the old transcript up reads as one that did nothing.
    expect(useDesktopStore.getState().cliHistory['0']).toEqual([]);
  });

  it('lets go once the server acks it', () => {
    const ws = fakeOpenSocket();
    wsManager.ws = ws;
    reset('0');
    const messageId = useDesktopStore.getState().pendingOutbox()[0].messageId;

    useDesktopStore.getState().settleOutbox(messageId);

    expect(useDesktopStore.getState().pendingOutbox()).toHaveLength(0);
  });
});
