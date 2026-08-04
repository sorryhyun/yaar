/**
 * S12 — a reset tells the client which *hub* session it is on, not which transcript.
 *
 * Two id namespaces ride on `CONNECTION_STATUS`: `sessionId` is the SessionHub key the
 * client rejoins the WebSocket with and mints iframe tokens against, while `logSessionId`
 * names a `session_logs/` directory (`2026-08-04_14-55-15`) that only the history/restore
 * UI is keyed by. `ContextPool.initialize()` says so in as many words; `reset()` sent the
 * log id in the `sessionId` field.
 *
 * The frontend believes that field (`server-event-dispatcher.ts` → `setSession`), so after
 * one reset the desktop's `store.sessionId` *was* a directory name. Nothing looked wrong
 * until the next app launch: `POST /api/iframe-token` mints against whatever id it is
 * handed, so every icon-launched window from then on carried a token naming a session the
 * hub had never held, and each of its session-scoped verbs parked the full
 * `SessionHub.waitFor()` and came back 503. Process Explorer, Session Logs and
 * Configurations never loaded; apps that only touch storage — devtools — kept working,
 * which is what made it look like an app bug rather than a session-id bug.
 *
 * Asserted over *every* CONNECTION_STATUS the client received, not just the last: the
 * frame that poisons the store is whichever one carries the wrong id, and the reset path
 * emits its own.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe('S12 — CONNECTION_STATUS carries the hub id across a reset', () => {
  it('every connection status names the session the hub holds', async () => {
    const h = await boot();
    harness = h;
    h.registry.onTurn(() => [{ kind: 'text', content: 'ok' }]);

    // A turn first: the pool (and with it the log directory whose name is the wrong id)
    // only exists once something has been sent.
    await h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'hello',
    });
    await h.client.waitForFrame(ServerEventType.CONNECTION_STATUS);

    await h.client.deliverAsync({ type: ClientEventType.RESET });
    // The reset's own frame, not the one the first turn already sent — matched by count
    // rather than by content, since the id it carries is the thing under test.
    await h.client.waitForFrame(
      ServerEventType.CONNECTION_STATUS,
      () => h.client.framesOf(ServerEventType.CONNECTION_STATUS).length > 1,
    );

    // A frame that names no session is fine — the dispatcher only calls `setSession` when
    // the frame carries both a provider and a sessionId, so those leave the store alone.
    // The invariant is about the ones that *do* name a session.
    const named = h.client
      .framesOf(ServerEventType.CONNECTION_STATUS)
      .filter((frame) => frame.sessionId !== undefined);

    expect(named.length).toBeGreaterThan(1);
    for (const frame of named) {
      expect(frame.sessionId).toBe(h.sessionId);
    }
  });
});
