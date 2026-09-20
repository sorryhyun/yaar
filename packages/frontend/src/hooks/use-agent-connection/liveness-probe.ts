/**
 * Is this socket still attached to a server, or only to our own end of a dead one?
 *
 * `readyState` cannot answer that. A socket whose peer went away silently — a phone
 * that slept, an app switch the radio did not survive, a Wi-Fi handover — stays `OPEN`
 * on our side until the OS gives up on the TCP connection, which is minutes. Until then
 * every `send()` succeeds into the void and no `onclose` ever schedules a retry, so the
 * tab shows itself connected and answers nothing. That is the state a phone comes back
 * to after the user spent a while in another app, and nothing in the reconnect path was
 * ever going to notice it, because the reconnect path starts at `onclose`.
 *
 * So we ask instead of assuming. The resume path already sends `RESYNC`, whose whole
 * contract is that the server answers with a `SNAPSHOT` — a request that must produce a
 * reply is exactly a liveness probe, and it costs nothing extra. Arm a deadline against
 * it; any inbound frame at all disarms it, because any frame proves a peer. Silence past
 * the deadline is the answer.
 *
 * The same deadline covers a socket stuck in `CONNECTING`: a handshake interrupted by
 * the freeze can sit there forever, and `openSocket` refuses to replace a connecting
 * socket, so nothing else would ever clear it.
 */

/**
 * How long the server has to say anything at all before we call the socket dead.
 *
 * Generous on purpose. This fires on a phone that has just woken up, where the first
 * packets go out over a radio that is still reassociating; the cost of being wrong is a
 * reconnect that reattaches to the same session, but it is still a remount of every app
 * iframe, so we would rather wait than churn.
 */
export const LIVENESS_PROBE_TIMEOUT_MS = 8_000;

export interface LivenessProbe {
  /** Start the deadline for `socket`. Replaces any deadline already running. */
  arm: (socket: WebSocket) => void;
  /** The peer spoke (or we stopped caring). Cancels the deadline. */
  disarm: () => void;
}

/**
 * @param onSilence Called with the probed socket when the deadline passes unanswered.
 *   It receives the socket so the caller can check it is still the current one — the
 *   deadline may outlive the connection it was armed against.
 */
export function createLivenessProbe(
  onSilence: (probed: WebSocket) => void,
  timeoutMs: number = LIVENESS_PROBE_TIMEOUT_MS,
): LivenessProbe {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let probed: WebSocket | null = null;

  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    probed = null;
  };

  return {
    arm(socket: WebSocket) {
      disarm();
      probed = socket;
      timer = setTimeout(() => {
        const dead = probed;
        timer = null;
        probed = null;
        if (dead) onSilence(dead);
      }, timeoutMs);
    },
    disarm,
  };
}
