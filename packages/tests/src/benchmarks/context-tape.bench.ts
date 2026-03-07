/**
 * Benchmarks for ContextTape and MonitorBudgetPolicy.
 *
 * ContextTape is the central conversation history structure — it is read and
 * formatted on every agent turn.  MonitorBudgetPolicy enforces per-monitor
 * rate limits and is checked/updated on every OS action emitted by a
 * background monitor.  Both are purely in-memory with no I/O.
 *
 * Run with: bun run --filter @yaar/tests bench
 */

import { bench, describe } from 'vitest';
import { ContextTape } from '@yaar/server/agents/context';
import { MonitorBudgetPolicy } from '@yaar/server/agents/context-pool-policies/monitor-budget-policy';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MAIN_MSG = 'The user asked about dashboard metrics for Q4 revenue analysis with filters.';
const WIN_MSG = 'Component rendered with 12 data points on an interactive line chart.';

/**
 * Build a tape pre-populated with `mainCount` main messages and
 * `windowCount` window messages spread across 5 windows.
 */
function buildTape(mainCount: number, windowCount: number): ContextTape {
  const tape = new ContextTape();
  for (let i = 0; i < mainCount; i++) {
    tape.append(i % 2 === 0 ? 'user' : 'assistant', `${MAIN_MSG} (${i})`, 'main');
  }
  for (let i = 0; i < windowCount; i++) {
    tape.append(i % 2 === 0 ? 'user' : 'assistant', `${WIN_MSG} (${i})`, {
      window: `win-${i % 5}`,
    });
  }
  return tape;
}

// Read-only tapes used for filter / format benchmarks.
const TAPE_200 = buildTape(150, 50); // 200 messages: 150 main + 50 window
const TAPE_400 = buildTape(200, 200); // 400 messages: close to the 200-main prune threshold

// ── ContextTape append ────────────────────────────────────────────────────────

describe('ContextTape.append', () => {
  bench('100 main messages', () => {
    const tape = new ContextTape();
    for (let i = 0; i < 100; i++) {
      tape.append(i % 2 === 0 ? 'user' : 'assistant', `${MAIN_MSG} (${i})`, 'main');
    }
  });

  bench('100 window messages across 5 windows', () => {
    const tape = new ContextTape();
    for (let i = 0; i < 100; i++) {
      tape.append(i % 2 === 0 ? 'user' : 'assistant', `${WIN_MSG} (${i})`, {
        window: `win-${i % 5}`,
      });
    }
  });

  bench('append past the 200-main prune boundary (triggers prune)', () => {
    // Creates a tape that already has 195 main messages, then appends 10 more
    // to exercise the pruneIfNeeded() path.
    const tape = buildTape(195, 0);
    for (let i = 0; i < 10; i++) {
      tape.append('user', `extra message ${i}`, 'main');
    }
  });
});

// ── ContextTape getMessages ───────────────────────────────────────────────────

describe('ContextTape.getMessages (200 messages)', () => {
  bench('all messages (no filter)', () => {
    TAPE_200.getMessages();
  });

  bench('exclude window messages', () => {
    TAPE_200.getMessages({ includeWindows: false });
  });

  bench('filter to 2 specific windows', () => {
    TAPE_200.getMessages({ windowIds: ['win-0', 'win-1'] });
  });

  bench('exclude 3 windows', () => {
    TAPE_200.getMessages({ excludeWindowIds: ['win-0', 'win-1', 'win-2'] });
  });
});

// ── ContextTape formatForPrompt ───────────────────────────────────────────────

describe('ContextTape.formatForPrompt (200 messages)', () => {
  bench('main-only (default for main agents)', () => {
    TAPE_200.formatForPrompt({ includeWindows: false });
  });

  bench('main + one window (default for window agents)', () => {
    TAPE_200.formatForPrompt({ includeWindows: true, windowId: 'win-0' });
  });

  bench('all windows included', () => {
    TAPE_200.formatForPrompt({ includeWindows: true });
  });
});

describe('ContextTape.formatForPrompt (400 messages)', () => {
  bench('main-only on large tape', () => {
    TAPE_400.formatForPrompt({ includeWindows: false });
  });
});

// ── ContextTape pruneWindow ───────────────────────────────────────────────────

describe('ContextTape.pruneWindow', () => {
  bench('prune one window from a 200-message tape', () => {
    // Build fresh each iteration so the window messages are always present.
    const tape = buildTape(150, 50);
    tape.pruneWindow('win-0');
  });
});

// ── MonitorBudgetPolicy ───────────────────────────────────────────────────────

describe('MonitorBudgetPolicy.recordAction', () => {
  bench('record 1000 actions across 5 background monitors', () => {
    const policy = new MonitorBudgetPolicy(2, 30, 50_000);
    for (let i = 0; i < 1000; i++) {
      policy.recordAction(`monitor-${(i % 5) + 1}`);
    }
  });
});

describe('MonitorBudgetPolicy.checkActionBudget', () => {
  bench('check budget on empty monitor ×1000', () => {
    const policy = new MonitorBudgetPolicy(2, 30, 50_000);
    for (let i = 0; i < 1000; i++) {
      policy.checkActionBudget('monitor-1');
    }
  });

  bench('check budget after filling window (25/30 actions) ×1000', () => {
    const policy = new MonitorBudgetPolicy(2, 30, 50_000);
    for (let i = 0; i < 25; i++) policy.recordAction('monitor-1');
    for (let i = 0; i < 1000; i++) {
      policy.checkActionBudget('monitor-1');
    }
  });

  bench('primary monitor bypasses check ×1000', () => {
    const policy = new MonitorBudgetPolicy(2, 30, 50_000);
    for (let i = 0; i < 1000; i++) {
      policy.checkActionBudget('monitor-0');
    }
  });
});

describe('MonitorBudgetPolicy.tryAcquireTaskSlot', () => {
  bench('acquire + release cycle ×1000 (no contention)', () => {
    const policy = new MonitorBudgetPolicy(4, 30, 50_000);
    for (let i = 0; i < 1000; i++) {
      policy.tryAcquireTaskSlot('monitor-1');
      policy.releaseTaskSlot('monitor-1');
    }
  });

  bench('primary monitor no-op bypass ×1000', () => {
    const policy = new MonitorBudgetPolicy(2, 30, 50_000);
    for (let i = 0; i < 1000; i++) {
      policy.tryAcquireTaskSlot('monitor-0');
    }
  });
});

describe('MonitorBudgetPolicy.getStats', () => {
  bench('stats over 10 monitors each with 30 recorded actions', () => {
    const policy = new MonitorBudgetPolicy(2, 30, 50_000);
    for (let i = 1; i <= 10; i++) {
      for (let j = 0; j < 30; j++) {
        policy.recordAction(`monitor-${i}`);
      }
    }
    policy.getStats();
  });
});
