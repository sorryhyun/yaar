/**
 * The half-open socket, and what finally notices it.
 *
 * A phone that spends a few minutes in another app comes back holding a WebSocket that
 * reads `OPEN` and has no peer. The reconnect path begins at `onclose`, which for that
 * socket arrives minutes later or never, so the desktop sits there looking connected and
 * answering nothing — the shape the user reports as "the frontend is dead until I
 * reload". These are the two pieces that end it: a deadline on the resync's answer, and a
 * replacement that does not wait for a close handshake nobody will complete.
 */
import { describe, it, expect } from 'bun:test';
import {
  createLivenessProbe,
  LIVENESS_PROBE_TIMEOUT_MS,
} from '@/hooks/use-agent-connection/liveness-probe';
import { createWsManager, replaceDeadSocket } from '@/hooks/use-agent-connection/transport-manager';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A socket that is `OPEN` and connected to nothing — the state under test. */
function zombieSocket(): WebSocket & { closed: number } {
  const socket: { readyState: number; closed: number; close: () => void; send: () => void } = {
    readyState: WebSocket.OPEN,
    closed: 0,
    close() {
      socket.closed++;
      // Deliberately does *not* move to CLOSED: a peer that is gone sends no close
      // frame back, which is the whole reason this socket cannot be waited on.
      socket.readyState = WebSocket.CLOSING;
    },
    send() {},
  };
  return socket as unknown as WebSocket & { closed: number };
}

describe('createLivenessProbe', () => {
  it('fires when nothing answers before the deadline', async () => {
    const silent: WebSocket[] = [];
    const probe = createLivenessProbe((s) => silent.push(s), 20);
    const socket = zombieSocket();

    probe.arm(socket);
    expect(silent).toEqual([]);
    await tick(40);

    expect(silent).toEqual([socket]);
  });

  it('stays quiet when the peer speaks first', async () => {
    let fired = 0;
    const probe = createLivenessProbe(() => void fired++, 20);

    probe.arm(zombieSocket());
    probe.disarm();
    await tick(40);

    expect(fired).toBe(0);
  });

  it('re-arming replaces the running deadline rather than adding one', async () => {
    const silent: WebSocket[] = [];
    const probe = createLivenessProbe((s) => silent.push(s), 20);
    const first = zombieSocket();
    const second = zombieSocket();

    probe.arm(first);
    probe.arm(second);
    await tick(40);

    expect(silent).toEqual([second]);
  });

  it('is generous enough to survive a radio waking up', () => {
    // Being wrong costs a reconnect: a handshake, a flush and a full snapshot.
    expect(LIVENESS_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe('replaceDeadSocket', () => {
  it('drops the socket and reconnects without waiting for the close handshake', () => {
    const wsManager = createWsManager();
    const dead = zombieSocket();
    wsManager.ws = dead;
    wsManager.attached = true;
    wsManager.reconnectAttempts = 4;

    let reconnects = 0;
    replaceDeadSocket(wsManager, () => void reconnects++);

    expect(reconnects).toBe(1);
    // Still CLOSING — had this waited on `onclose`, it would still be waiting.
    expect(dead.readyState).toBe(WebSocket.CLOSING);
    expect(dead.closed).toBe(1);
    expect(wsManager.ws).toBeNull();
    expect(wsManager.attached).toBe(false);
    // A user-visible stall is not the moment to start at a 16s backoff.
    expect(wsManager.reconnectAttempts).toBe(0);
  });

  it('cancels a pending backoff so the two do not both reconnect', () => {
    const wsManager = createWsManager();
    wsManager.ws = zombieSocket();
    wsManager.reconnectTimeout = setTimeout(() => {}, 60_000) as unknown as number;
    wsManager.nextRetryAt = Date.now() + 60_000;

    replaceDeadSocket(wsManager, () => {});

    expect(wsManager.reconnectTimeout).toBeNull();
    expect(wsManager.nextRetryAt).toBeNull();
  });

  it('leaves a user who asked to be offline offline', () => {
    const wsManager = createWsManager();
    const dead = zombieSocket();
    wsManager.ws = dead;
    wsManager.stopped = true;

    let reconnects = 0;
    replaceDeadSocket(wsManager, () => void reconnects++);

    expect(reconnects).toBe(0);
    expect(wsManager.ws).toBe(dead);
  });
});
