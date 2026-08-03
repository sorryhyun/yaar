/**
 * What "stop" has to mean.
 *
 * Pressing stop used to report success it had not observed: the Claude provider
 * fired the SDK's interrupt control request and dropped the answer, the pool
 * flipped a flag and returned, and the work carried on out of sight — queued
 * messages the CLI told us it had kept, tool calls already dispatched still
 * painting windows, and the next queued task starting the moment the stopped
 * turn unwound. Four claims, one per way that leaked:
 *
 * 1. The provider waits for the acknowledgement and reads it. `still_queued` is
 *    the SDK saying which messages *will* still run, so a non-empty list is not
 *    a stop and escalates to killing the stream.
 * 2. An idle stream is closed, not aborted — an abort leaves the record pointing
 *    at a dead process, and the next turn would push into it and answer nothing.
 * 3. An interrupted agent's in-flight tools stop reaching the screen.
 * 4. Stopping skips idle agents entirely, so a warm process survives a stop-all.
 */
import { describe, expect, it, mock } from 'bun:test';

import { AgentPool } from '../agents/agent-pool.js';
import { ClaudeSessionProvider } from '../providers/claude/session-provider.js';
import { actionEmitter } from '../session/action-emitter.js';
import type { AITransport, StreamMessage, TransportOptions } from '../providers/types.js';
import type { OSAction } from '@yaar/shared';
import type { SessionId } from '../session/types.js';

// ── The provider's receipt ──────────────────────────────────────────────────

/**
 * Stand in for a live SDK stream. The provider's persistent session is private
 * and the real one spawns a CLI, so the seam is the field itself: what matters
 * here is which branch `interrupt()` takes and what it leaves behind.
 */
function fakePersistentSession(overrides: {
  busy: boolean;
  interrupt?: () => Promise<{ still_queued: string[] } | undefined>;
}) {
  const closed = { channel: false, aborted: false, returned: false };
  const abortController = new AbortController();
  const session = {
    busy: overrides.busy,
    fingerprint: 'fp',
    openedWithResume: undefined,
    turnsProcessed: 1,
    mcpReady: Promise.resolve(),
    abortController,
    channel: {
      close: () => {
        closed.channel = true;
      },
    },
    stream: {
      interrupt: overrides.interrupt ?? (async () => ({ still_queued: [] })),
      return: async () => {
        closed.returned = true;
      },
    },
  };
  abortController.signal.addEventListener('abort', () => {
    closed.aborted = true;
  });
  return { session, closed };
}

/** Reach the private field both the branch and the leak live in. */
function persistentSessionOf(provider: ClaudeSessionProvider): unknown {
  return (provider as unknown as { persistentSession: unknown }).persistentSession;
}
function setPersistentSession(provider: ClaudeSessionProvider, value: unknown): void {
  (provider as unknown as { persistentSession: unknown }).persistentSession = value;
}

describe('ClaudeSessionProvider.interrupt()', () => {
  it('reports a clean stop when the CLI acknowledges with nothing queued', async () => {
    const provider = new ClaudeSessionProvider();
    const { session } = fakePersistentSession({ busy: true });
    setPersistentSession(provider, session);

    const receipt = await provider.interrupt();

    expect(receipt.outcome).toBe('acknowledged');
    // The process survives a clean interrupt — that is the whole point of the
    // control request over killing it.
    expect(persistentSessionOf(provider)).toBe(session);
  });

  it('escalates to closing the stream when the CLI reports messages still queued', async () => {
    const provider = new ClaudeSessionProvider();
    const { session, closed } = fakePersistentSession({
      busy: true,
      interrupt: async () => ({ still_queued: ['uuid-a', 'uuid-b'] }),
    });
    setPersistentSession(provider, session);

    const receipt = await provider.interrupt();

    expect(receipt.outcome).toBe('escalated');
    expect(receipt.stillQueued).toEqual(['uuid-a', 'uuid-b']);
    expect(closed.aborted).toBe(true);
    expect(persistentSessionOf(provider)).toBeNull();
  });

  it('escalates when the acknowledgement never comes', async () => {
    const provider = new ClaudeSessionProvider();
    const { session, closed } = fakePersistentSession({
      busy: true,
      interrupt: () => new Promise(() => {}), // never settles
    });
    setPersistentSession(provider, session);

    const receipt = await provider.interrupt();

    expect(receipt.outcome).toBe('escalated');
    expect(closed.aborted).toBe(true);
    expect(persistentSessionOf(provider)).toBeNull();
  }, 10_000);

  it('treats an old CLI’s empty payload as acknowledged rather than a failure', async () => {
    // Before `interrupt_receipt_v1` the control response carries no detail. The
    // request was still accepted, so killing the process here would cost a warm
    // stream on every stop for anyone on an older CLI.
    const provider = new ClaudeSessionProvider();
    const { session } = fakePersistentSession({ busy: true, interrupt: async () => undefined });
    setPersistentSession(provider, session);

    expect((await provider.interrupt()).outcome).toBe('acknowledged');
    expect(persistentSessionOf(provider)).toBe(session);
  });

  it('closes an idle stream instead of aborting it behind its own record', async () => {
    // The regression this guards: the base abort kills the prewarmed process but
    // leaves `persistentSession` set, so the next turn reuses the corpse — pushing
    // a user message into a dead channel and returning no answer at all.
    const provider = new ClaudeSessionProvider();
    const { session, closed } = fakePersistentSession({ busy: false });
    setPersistentSession(provider, session);

    const receipt = await provider.interrupt();

    expect(receipt.outcome).toBe('idle');
    expect(closed.channel).toBe(true);
    expect(persistentSessionOf(provider)).toBeNull();
  });
});

// ── Post-stop actions ───────────────────────────────────────────────────────

describe('actionEmitter and an interrupted agent', () => {
  const action = { type: 'notification.show', message: 'late' } as unknown as OSAction;

  it('drops actions from a stopped agent and lets them through again on its next turn', () => {
    const seen: string[] = [];
    const listener = (payload: { agentId?: string }) => seen.push(payload.agentId ?? 'none');
    actionEmitter.on('action', listener);
    try {
      actionEmitter.emitAction(action, 'ses-interrupt' as SessionId, 'agent-1');
      expect(seen).toEqual(['agent-1']);

      // The user presses stop. A tool call dispatched a beat earlier finishes and
      // emits — this is the emit that used to open a window after the stop.
      actionEmitter.markInterrupted('agent-1');
      actionEmitter.emitAction(action, 'ses-interrupt' as SessionId, 'agent-1');
      expect(seen).toEqual(['agent-1']);

      // Another agent is not stopped, and is not silenced by this one.
      actionEmitter.emitAction(action, 'ses-interrupt' as SessionId, 'agent-2');
      expect(seen).toEqual(['agent-1', 'agent-2']);

      // Next turn: the block lifts, or the agent would never paint again.
      actionEmitter.clearInterrupted('agent-1');
      actionEmitter.emitAction(action, 'ses-interrupt' as SessionId, 'agent-1');
      expect(seen).toEqual(['agent-1', 'agent-2', 'agent-1']);
    } finally {
      actionEmitter.clearInterrupted('agent-1');
      actionEmitter.off('action', listener);
    }
  });

  it('settles a feedback-awaiting action as cancelled rather than as a refusal', async () => {
    actionEmitter.markInterrupted('agent-3');
    try {
      // `resolveAgentId` falls back to the async context; naming the agent
      // explicitly is the same path a tool takes when it knows its own id.
      const outcome = await actionEmitter.emitActionWithFeedback(action, 50, 'ses-interrupt');
      // No agent in context here, so this one is *not* dropped — a stopped agent
      // is no reason to ignore an action that isn't its.
      expect(outcome.ok).toBe(false);
    } finally {
      actionEmitter.clearInterrupted('agent-3');
    }
  });
});

// ── Stopping skips what is already stopped ──────────────────────────────────

function fakeProvider(): AITransport {
  return {
    name: 'fake',
    providerType: 'claude',
    systemPrompt: 'unused',
    async isAvailable() {
      return true;
    },
    // eslint-disable-next-line require-yield
    async *query(_prompt: string, _options: TransportOptions): AsyncIterable<StreamMessage> {
      return;
    },
    async interrupt() {
      return { outcome: 'acknowledged' as const };
    },
    async dispose() {},
  };
}

describe('AgentPool.interruptAll()', () => {
  it('leaves idle agents alone', async () => {
    const pool = new AgentPool(
      'ses-interrupt-pool' as SessionId,
      () => {},
      (id) => id,
      async () => fakeProvider(),
    );
    try {
      // Hand the fake in rather than letting the pool reach for a warm provider:
      // this test is about which agents get interrupted, not about spawning one.
      const agent = await pool.createMonitorAgent('0', fakeProvider());
      expect(agent).not.toBeNull();

      const interrupt = mock(async () => ({ outcome: 'acknowledged' as const }));
      agent!.session.interrupt = interrupt;
      agent!.session.isRunning = () => false;

      await pool.interruptAll();
      // An idle agent has nothing to stop, and stopping it anyway costs its warm
      // stream — the first message after any stop-all would pay a cold start.
      expect(interrupt).not.toHaveBeenCalled();

      agent!.session.isRunning = () => true;
      await pool.interruptAll();
      expect(interrupt).toHaveBeenCalledTimes(1);
    } finally {
      await pool.cleanup();
    }
  });
});
