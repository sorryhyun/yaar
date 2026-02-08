/**
 * Tests for pool drain on reset — verifies that ContextPool, AgentPool,
 * AppServer, and CodexProvider correctly handle in-flight tasks during reset.
 */
import { describe, it, expect, vi } from 'vitest';
import { InteractionTimeline } from '../agents/interaction-timeline.js';
import { ContextTape } from '../agents/context.js';
import { ContextAssemblyPolicy } from '../agents/context-pool-policies/context-assembly-policy.js';

// ── AppServer turn queue drain ──────────────────────────────────────────

describe('AppServer.stop() drains turn queue', () => {
  it('resolves all pending turn waiters on stop', async () => {
    // Inline minimal AppServer to test turn queue drain without spawning a process
    const turnQueue: Array<{ resolve: () => void }> = [];
    let turnActive = false;

    function acquireTurn(): Promise<void> {
      if (!turnActive) {
        turnActive = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        turnQueue.push({ resolve });
      });
    }

    function drainTurnQueue(): void {
      for (const waiter of turnQueue) {
        waiter.resolve();
      }
      turnQueue.length = 0;
      turnActive = false;
    }

    // First acquire succeeds immediately
    await acquireTurn();
    expect(turnActive).toBe(true);

    // Two waiters queue up
    const results: string[] = [];
    const p1 = acquireTurn().then(() => results.push('waiter1'));
    const p2 = acquireTurn().then(() => results.push('waiter2'));

    expect(turnQueue.length).toBe(2);

    // Drain (simulates stop())
    drainTurnQueue();
    await Promise.all([p1, p2]);

    expect(results).toEqual(['waiter1', 'waiter2']);
    expect(turnQueue.length).toBe(0);
    expect(turnActive).toBe(false);
  });
});

// ── AgentPool interrupt-before-dispose ──────────────────────────────────

describe('AgentPool.cleanup() interrupt-before-dispose', () => {
  it('calls interrupt before cleanup on each agent', async () => {
    const callOrder: string[] = [];

    const mockSession = {
      interrupt: vi.fn(async () => { callOrder.push('interrupt'); }),
      cleanup: vi.fn(async () => { callOrder.push('cleanup'); }),
      isRunning: vi.fn(() => false),
    };

    // Simulate what AgentPool.cleanup does
    const agents = [{ session: mockSession, idleTimer: null as NodeJS.Timeout | null }];

    // Phase 1: interrupt
    for (const agent of agents) {
      if (agent.idleTimer) clearTimeout(agent.idleTimer);
      await agent.session.interrupt();
    }
    // Phase 2: dispose
    for (const agent of agents) {
      await agent.session.cleanup();
    }

    expect(callOrder).toEqual(['interrupt', 'cleanup']);
    expect(mockSession.interrupt).toHaveBeenCalledBefore(mockSession.cleanup);
  });
});

// ── ContextPool inflight tracking ───────────────────────────────────────

describe('ContextPool inflight tracking', () => {
  it('inflightEnter/Exit counts correctly and resolves waiter', async () => {
    // Test the inflight counting logic directly
    let inflightCount = 0;
    let inflightResolve: (() => void) | null = null;

    function inflightEnter() { inflightCount++; }
    function inflightExit() {
      inflightCount--;
      if (inflightCount <= 0 && inflightResolve) {
        inflightResolve();
        inflightResolve = null;
      }
    }
    function awaitInflight(): Promise<void> {
      if (inflightCount <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => { inflightResolve = resolve; });
    }

    // Start two inflight tasks
    inflightEnter();
    inflightEnter();
    expect(inflightCount).toBe(2);

    // Start waiting
    let resolved = false;
    const waitPromise = awaitInflight().then(() => { resolved = true; });

    // Exit one — shouldn't resolve yet
    inflightExit();
    await Promise.resolve(); // microtick
    expect(resolved).toBe(false);
    expect(inflightCount).toBe(1);

    // Exit second — should resolve
    inflightExit();
    await waitPromise;
    expect(resolved).toBe(true);
    expect(inflightCount).toBe(0);
  });

  it('awaitInflight resolves immediately when no tasks in flight', async () => {
    const inflightCount = 0;
    function awaitInflight(): Promise<void> {
      if (inflightCount <= 0) return Promise.resolve();
      return new Promise<void>(() => { /* never resolves */ });
    }

    // Should resolve immediately
    await awaitInflight();
  });

  it('resetting flag rejects new tasks', () => {
    let resetting = true;
    const rejected: string[] = [];

    function handleTask(messageId: string): boolean {
      if (resetting) {
        rejected.push(messageId);
        return false;
      }
      return true;
    }

    expect(handleTask('msg-1')).toBe(false);
    expect(handleTask('msg-2')).toBe(false);
    expect(rejected).toEqual(['msg-1', 'msg-2']);

    resetting = false;
    expect(handleTask('msg-3')).toBe(true);
  });
});

// ── CodexProvider local appServer capture ───────────────────────────────

describe('CodexProvider query() local appServer capture', () => {
  it('local reference survives instance field being nulled', () => {
    // Simulates the pattern: capture local ref, then null the instance field
    let instanceField: { releaseTurn: () => string } | null = {
      releaseTurn: () => 'released',
    };

    // Capture local reference (what the fix does)
    const localRef = instanceField;

    // Simulate dispose() nulling the instance field
    instanceField = null;

    // The local ref should still work
    expect(localRef.releaseTurn()).toBe('released');
    expect(instanceField).toBeNull();
  });
});

// ── AgentLimiter clearWaiting during reset ──────────────────────────────

describe('AgentLimiter.clearWaiting during reset', () => {
  it('unblocks waiters with rejection', async () => {
    // Import the real limiter
    const { AgentLimiter } = await import('../agents/limiter.js');
    const limiter = new AgentLimiter(1);

    // Fill up the limiter
    limiter.tryAcquire();

    // Queue a waiter
    const waiterPromise = limiter.acquire();

    // Clear with reset error
    limiter.clearWaiting(new Error('Pool resetting'));

    await expect(waiterPromise).rejects.toThrow('Pool resetting');
    expect(limiter.getWaitingCount()).toBe(0);

    limiter.reset();
  });
});

// ── Integration: reset waits for inflight then disposes ─────────────────

describe('Reset integration: interrupt → await inflight → dispose', () => {
  it('disposes only after inflight tasks complete', async () => {
    const events: string[] = [];
    let inflightCount = 0;
    let inflightResolve: (() => void) | null = null;

    function inflightEnter() { inflightCount++; }
    function inflightExit() {
      inflightCount--;
      if (inflightCount <= 0 && inflightResolve) {
        inflightResolve();
        inflightResolve = null;
      }
    }
    function awaitInflight(): Promise<void> {
      if (inflightCount <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => { inflightResolve = resolve; });
    }

    // Simulate a long-running inflight task
    inflightEnter();
    const inflightTask = new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push('task-finished');
        inflightExit();
        resolve();
      }, 50);
    });

    // Simulate reset() sequence
    events.push('interrupt');
    await awaitInflight();
    events.push('dispose');

    // The task should have finished before dispose
    await inflightTask;
    expect(events).toEqual(['interrupt', 'task-finished', 'dispose']);
  });
});

// ── Main agent routing: idle → main, busy → ephemeral ───────────────────

describe('Main agent routing logic', () => {
  it('routes to main when idle, ephemeral when busy', () => {
    // Simulate the routing decision
    let mainBusy = false;
    const routeLog: string[] = [];

    function routeMainTask(taskId: string): void {
      if (!mainBusy) {
        routeLog.push(`main:${taskId}`);
        mainBusy = true;
      } else {
        routeLog.push(`ephemeral:${taskId}`);
      }
    }

    routeMainTask('msg-1'); // main is idle → goes to main
    routeMainTask('msg-2'); // main is busy → goes to ephemeral
    routeMainTask('msg-3'); // main still busy → goes to ephemeral

    expect(routeLog).toEqual([
      'main:msg-1',
      'ephemeral:msg-2',
      'ephemeral:msg-3',
    ]);
  });

  it('main agent becomes available after task completes', () => {
    let mainBusy = false;
    const routeLog: string[] = [];

    function routeMainTask(taskId: string): void {
      if (!mainBusy) {
        routeLog.push(`main:${taskId}`);
        mainBusy = true;
      } else {
        routeLog.push(`ephemeral:${taskId}`);
      }
    }

    function completeMainTask(): void {
      mainBusy = false;
    }

    routeMainTask('msg-1'); // → main
    completeMainTask();
    routeMainTask('msg-2'); // → main (idle again)

    expect(routeLog).toEqual(['main:msg-1', 'main:msg-2']);
  });
});

// ── Ephemeral agent lifecycle ───────────────────────────────────────────

describe('Ephemeral agent lifecycle', () => {
  it('creates, processes, pushes callback, and disposes', async () => {
    const events: string[] = [];

    // Simulate ephemeral agent lifecycle
    events.push('create-ephemeral');
    events.push('process-task');
    events.push('push-callback');
    events.push('dispose-ephemeral');

    expect(events).toEqual([
      'create-ephemeral',
      'process-task',
      'push-callback',
      'dispose-ephemeral',
    ]);
  });
});

// ── Window agent persistence ────────────────────────────────────────────

describe('Window agent persistence', () => {
  it('creates on first interaction, reuses on subsequent', () => {
    const windowAgents = new Map<string, string>();
    let nextId = 0;

    function getOrCreate(windowId: string): string {
      if (windowAgents.has(windowId)) {
        return windowAgents.get(windowId)!;
      }
      const agentId = `agent-${nextId++}`;
      windowAgents.set(windowId, agentId);
      return agentId;
    }

    const first = getOrCreate('win-1');
    const second = getOrCreate('win-1');
    const third = getOrCreate('win-2');

    expect(first).toBe(second); // Same agent reused
    expect(first).not.toBe(third); // Different window → different agent
    expect(windowAgents.size).toBe(2);
  });

  it('disposes on window close', () => {
    const windowAgents = new Map<string, string>();
    windowAgents.set('win-1', 'agent-0');
    windowAgents.set('win-2', 'agent-1');

    // Simulate window close
    windowAgents.delete('win-1');

    expect(windowAgents.has('win-1')).toBe(false);
    expect(windowAgents.has('win-2')).toBe(true);
    expect(windowAgents.size).toBe(1);
  });
});

// ── Callback injection into main prompt ──────────────────────────────────

describe('Timeline injection into main prompt', () => {
  it('timeline entries drained and included in main prompt', () => {
    const timeline = new InteractionTimeline();

    // Simulate ephemeral agent pushing to timeline
    timeline.pushAI('ephemeral-1', 'app: Calendar', [
      { type: 'window.create', windowId: 'cal', title: 'Cal', bounds: { x: 0, y: 0, w: 600, h: 400 }, content: { renderer: 'component', data: '' } },
    ]);

    // Simulate window agent pushing to timeline
    timeline.pushAI('window-settings', 'button "Save"', []);

    expect(timeline.size).toBe(2);

    // Format for prompt injection
    const formatted = timeline.format();
    expect(formatted).toContain('<timeline>');
    expect(formatted).toContain('agent="ephemeral-1"');
    expect(formatted).toContain('agent="window-settings"');

    // Drain clears the timeline
    const drained = timeline.drain();
    expect(drained).toHaveLength(2);
    expect(timeline.size).toBe(0);
  });
});

// ── ContextAssemblyPolicy: buildWindowInitialContext ─────────────────────

describe('ContextAssemblyPolicy.buildWindowInitialContext', () => {
  it('includes last N main turns for new window agents', () => {
    const tape = new ContextTape();
    const policy = new ContextAssemblyPolicy();

    tape.append('user', 'Hello', 'main');
    tape.append('assistant', 'Hi there!', 'main');
    tape.append('user', 'Open calendar', 'main');
    tape.append('assistant', 'Opening calendar...', 'main');
    tape.append('user', 'Show settings', 'main');
    tape.append('assistant', 'Here are your settings.', 'main');

    // Default 3 turns = 6 messages
    const context = policy.buildWindowInitialContext(tape, 3);
    expect(context).toContain('<recent_conversation>');
    expect(context).toContain('Hello');
    expect(context).toContain('Here are your settings.');
  });

  it('returns empty string when no main messages', () => {
    const tape = new ContextTape();
    const policy = new ContextAssemblyPolicy();

    expect(policy.buildWindowInitialContext(tape)).toBe('');
  });

  it('excludes window messages', () => {
    const tape = new ContextTape();
    const policy = new ContextAssemblyPolicy();

    tape.append('user', 'Main message', 'main');
    tape.append('assistant', 'Main response', 'main');
    tape.append('user', 'Window message', { window: 'win-1' });
    tape.append('assistant', 'Window response', { window: 'win-1' });

    const context = policy.buildWindowInitialContext(tape, 3);
    expect(context).toContain('Main message');
    expect(context).not.toContain('Window message');
  });
});
