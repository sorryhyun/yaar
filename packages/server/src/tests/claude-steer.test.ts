/**
 * What "steer" has to mean on a shared process.
 *
 * The Claude provider used to steer with the SDK's own `Query.streamInput()`,
 * which drains the iterable it is given and then calls `transport.endInput()` —
 * ending the CLI's stdin. That is right for a one-shot process and wrong here:
 * the persistent session shares one CLI across every turn and feeds it from a
 * channel that never closes, so a single steer closed stdin under the session.
 * It was also unguarded, so it would write into the gap between turns.
 *
 * Codex has the guards already (`turn/steer` names an `expectedTurnId` and waits
 * for the turn to start), so these claims are those semantics, restated for a
 * provider whose transport is a pipe rather than an RPC:
 *
 * 1. A steer reaches the CLI by the same channel a turn's own message does — the
 *    stream's `streamInput` is never called, so stdin stays open.
 * 2. There is no turn to steer unless one is in flight: idle sessions, absent
 *    sessions, and forks (which have no channel) refuse.
 * 3. A steer waits for its turn's message to be on the wire first, so it can
 *    never be written ahead of the message it is meant to steer.
 * 4. A steer that lost the race refuses instead of becoming the next turn's
 *    opening line — whether the turn ended under it or the stream was replaced.
 */
import { describe, expect, it } from 'bun:test';

import { ClaudeSessionProvider } from '../providers/claude/session-provider.js';

/**
 * Stand in for a live persistent session. The real one spawns a CLI, and the
 * field is private, so the field itself is the seam — what matters here is which
 * branch `steer()` takes and what it writes.
 */
function fakePersistentSession(overrides: { busy: boolean; turnStarted?: Promise<void> | null }) {
  const pushed: unknown[] = [];
  let streamInputCalls = 0;
  const session = {
    busy: overrides.busy,
    fingerprint: 'fp',
    openedWithResume: undefined,
    turnsProcessed: 1,
    turnId: 7,
    turnStarted: overrides.turnStarted ?? null,
    mcpReady: Promise.resolve(),
    abortController: new AbortController(),
    channel: {
      push: (message: unknown) => {
        pushed.push(message);
      },
      close: () => {},
    },
    stream: {
      streamInput: async () => {
        streamInputCalls++;
      },
    },
  };
  return { session, pushed, streamInput: () => streamInputCalls };
}

function setPersistentSession(provider: ClaudeSessionProvider, value: unknown): void {
  (provider as unknown as { persistentSession: unknown }).persistentSession = value;
}

describe('ClaudeSessionProvider.steer()', () => {
  it('pushes into the live channel and never calls streamInput', async () => {
    const provider = new ClaudeSessionProvider();
    const { session, pushed, streamInput } = fakePersistentSession({ busy: true });
    setPersistentSession(provider, session);

    expect(await provider.steer('also check the tests')).toBe(true);

    expect(pushed).toEqual([
      { type: 'user', message: { role: 'user', content: 'also check the tests' } },
    ]);
    // The whole point: `streamInput` would have closed stdin behind this write.
    expect(streamInput()).toBe(0);
  });

  it('refuses when no turn is in flight', async () => {
    const provider = new ClaudeSessionProvider();
    const { session, pushed } = fakePersistentSession({ busy: false });
    setPersistentSession(provider, session);

    expect(await provider.steer('hello')).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('refuses when there is no persistent session — a fork has no channel', async () => {
    const provider = new ClaudeSessionProvider();
    setPersistentSession(provider, null);

    expect(await provider.steer('hello')).toBe(false);
  });

  it("waits for the turn's own message before writing", async () => {
    const provider = new ClaudeSessionProvider();
    let startTurn!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      startTurn = resolve;
    });
    const { session, pushed } = fakePersistentSession({ busy: true, turnStarted });
    setPersistentSession(provider, session);

    const steered = provider.steer('and now this');
    // The turn is busy but still gated on MCP: nothing may be on the wire yet,
    // or the steer would precede the message it is steering.
    await Promise.resolve();
    expect(pushed).toEqual([]);

    startTurn();
    expect(await steered).toBe(true);
    expect(pushed).toHaveLength(1);
  });

  it('refuses when the turn ends while it waits', async () => {
    const provider = new ClaudeSessionProvider();
    let startTurn!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      startTurn = resolve;
    });
    const { session, pushed } = fakePersistentSession({ busy: true, turnStarted });
    setPersistentSession(provider, session);

    const steered = provider.steer('too late');
    // The turn unwinds — `runPersistentTurn`'s finally clears busy and wakes the
    // waiter rather than holding it for the full deadline.
    session.busy = false;
    startTurn();

    expect(await steered).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('refuses when the next turn started while it waited', async () => {
    const provider = new ClaudeSessionProvider();
    let startTurn!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      startTurn = resolve;
    });
    const { session, pushed } = fakePersistentSession({ busy: true, turnStarted });
    setPersistentSession(provider, session);

    const steered = provider.steer('meant for the previous turn');
    // Same stream, still busy — but a different turn. Without the id check this
    // would land as the new turn's opening message.
    session.turnId++;
    startTurn();

    expect(await steered).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('refuses when the stream was replaced while it waited', async () => {
    const provider = new ClaudeSessionProvider();
    let startTurn!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      startTurn = resolve;
    });
    const { session, pushed } = fakePersistentSession({ busy: true, turnStarted });
    setPersistentSession(provider, session);

    const steered = provider.steer('into a dead process');
    // A reopen (fingerprint change, stale resume, crash) swaps the record; the
    // captured session is a corpse whose stdin no longer goes anywhere.
    const replacement = fakePersistentSession({ busy: true });
    setPersistentSession(provider, replacement.session);
    startTurn();

    expect(await steered).toBe(false);
    expect(pushed).toEqual([]);
    expect(replacement.pushed).toEqual([]);
  });
});
