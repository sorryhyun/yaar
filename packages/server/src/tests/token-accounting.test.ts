/**
 * Token accounting: what reaches Process Explorer's token column, and when.
 *
 * Two properties, both broken before and both invisible to a type checker:
 *
 *   1. **The counter moves while the agent is busy.** Claude hangs its
 *      authoritative figure on the `result` message, which arrives once the turn
 *      is already over — so an agent's tokens stayed blank for exactly as long
 *      as anyone was watching it work, and showed nothing at all on a first
 *      turn. The numbers are known throughout (`message_start` carries the whole
 *      input side, `message_delta` the output), and are now reported as deltas
 *      as they land.
 *   2. **Reporting early must not double-count.** The mid-turn reports and the
 *      terminal describe the same tokens; the terminal's job is to contribute
 *      only the remainder. The invariant asserted below is that the deltas sum
 *      to the provider's own total for the turn — no more, no less.
 *
 * Plus the bug found while measuring (1): `total_cost_usd` is the *session's*
 * running cost, not the turn's — measured at 0.0084 → 0.0109 → 0.0137 across
 * three one-word turns — and was being summed, inflating it quadratically.
 */
import { describe, it, expect } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapClaudeMessage, TurnUsageTracker } from '../providers/claude/message-mapper.js';
import { mapNotification } from '../providers/codex/message-mapper.js';
import { AgentSession } from '../agents/agent-session.js';
import type { StreamMessage, TokenUsage } from '../providers/types.js';

/** The wire spelling of a usage block, as the Anthropic API sends it. */
function raw(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

const messageStart = (u: ReturnType<typeof raw>) =>
  ({
    type: 'stream_event',
    event: { type: 'message_start', message: { usage: u } },
  }) as unknown as SDKMessage;

const messageDelta = (u: ReturnType<typeof raw>) =>
  ({ type: 'stream_event', event: { type: 'message_delta', usage: u } }) as unknown as SDKMessage;

const result = (u: ReturnType<typeof raw>, costUsd?: number) =>
  ({
    type: 'result',
    subtype: 'success',
    session_id: 'ses-1',
    usage: u,
    ...(costUsd === undefined ? {} : { total_cost_usd: costUsd }),
  }) as unknown as SDKMessage;

/** Sum every turn-scoped report a mapped turn produced — what AgentSession folds. */
function sumReports(messages: (StreamMessage | null)[]): TokenUsage {
  const total: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const m of messages) {
    if (!m?.usage) continue;
    expect(m.usageScope ?? 'turn').toBe('turn');
    total.inputTokens += m.usage.inputTokens;
    total.outputTokens += m.usage.outputTokens;
    total.cacheReadTokens += m.usage.cacheReadTokens;
    total.cacheWriteTokens += m.usage.cacheWriteTokens;
  }
  return total;
}

describe('Claude mid-turn token reporting', () => {
  it('reports the input side before a single token has been generated', () => {
    const turn = new TurnUsageTracker();
    // The real figures from one measured turn: the context is almost entirely a
    // cache read, which is exactly why `inputTokens` alone reads as ~10.
    const first = mapClaudeMessage(messageStart(raw(10, 4, 15232, 3313)), turn);

    expect(first).toEqual({
      type: 'usage',
      usageScope: 'turn',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 15232,
        cacheWriteTokens: 3313,
      },
    });
  });

  it('sums to the provider total for a turn, with the terminal adding nothing', () => {
    const turn = new TurnUsageTracker();
    const total = raw(10, 47, 15232, 3313);
    const mapped = [
      mapClaudeMessage(messageStart(raw(10, 4, 15232, 3313)), turn),
      mapClaudeMessage(messageDelta(total), turn),
      mapClaudeMessage(result(total), turn),
    ];

    // The terminal is still a `complete` — it just carries no new tokens.
    expect(mapped[2]?.type).toBe('complete');
    expect(sumReports(mapped)).toEqual({
      inputTokens: 10,
      outputTokens: 47,
      cacheReadTokens: 15232,
      cacheWriteTokens: 3313,
    });
  });

  it('adds across the assistant messages of a multi-step turn, not over them', () => {
    // A turn with one tool round-trip: two assistant messages. Each supersedes
    // its *own* earlier figure while adding to its predecessor's — get that
    // backwards and a tool-heavy turn either triples or reports only its last step.
    const turn = new TurnUsageTracker();
    const mapped = [
      mapClaudeMessage(messageStart(raw(10, 4, 15232, 3313)), turn),
      mapClaudeMessage(messageDelta(raw(10, 47, 15232, 3313)), turn),
      mapClaudeMessage(messageStart(raw(10, 4, 18545, 206)), turn),
      mapClaudeMessage(messageDelta(raw(10, 45, 18545, 206)), turn),
      mapClaudeMessage(result(raw(20, 92, 33777, 3519)), turn),
    ];

    expect(sumReports(mapped)).toEqual({
      inputTokens: 20,
      outputTokens: 92,
      cacheReadTokens: 33777,
      cacheWriteTokens: 3519,
    });
  });

  it('falls back to the terminal figure when partial messages are off', () => {
    // No tracker, or a turn that streamed nothing: the `result` still carries the
    // whole total, so a consumer that never sees a mid-turn report is not starved.
    const turn = new TurnUsageTracker();
    const mapped = mapClaudeMessage(result(raw(10, 47, 15232, 3313)), turn);
    expect(mapped?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 47,
      cacheReadTokens: 15232,
      cacheWriteTokens: 3313,
    });
    expect(mapClaudeMessage(result(raw(1, 2, 3, 4)))?.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
  });

  it('never reports a negative delta when a total arrives lower than what was sent', () => {
    // A sub-agent's messages stream through this mapper but need not appear in
    // the parent's `result` total. Crediting tokens back would let a lifetime
    // counter run backwards.
    const turn = new TurnUsageTracker();
    const mapped = [
      mapClaudeMessage(messageStart(raw(10, 4, 15232, 3313)), turn),
      mapClaudeMessage(messageDelta(raw(10, 900, 15232, 3313)), turn),
      mapClaudeMessage(result(raw(10, 47, 15232, 3313)), turn),
    ];
    const summed = sumReports(mapped);
    expect(summed.outputTokens).toBe(900);
    expect(summed.inputTokens).toBe(10);
  });
});

describe('provider parity — what inputTokens means', () => {
  /**
   * The two providers disagree about `inputTokens` on the wire and the mappers
   * exist to reconcile it: Claude reports the *fresh remainder* with the cache
   * figures beside it, Codex reports the *whole* input with the cache figures
   * folded inside. Normalized, `inputTokens` is the fresh remainder on both, and
   * the whole input a turn read is the sum of all three fields — which is what
   * Process Explorer's "in" column shows.
   *
   * Both fixtures are measured, not invented: Claude's from an SDK `result`,
   * Codex's from a `thread/tokenUsage/updated` on the third turn of a thread.
   */
  const wholeInput = (u: TokenUsage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

  it('normalizes Claude cache-beside into a fresh remainder', () => {
    const usage = mapClaudeMessage(result(raw(10, 47, 15232, 3313)))?.usage;
    expect(usage).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 15232,
      cacheWriteTokens: 3313,
    });
    expect(wholeInput(usage!)).toBe(18555);
  });

  it('normalizes Codex cache-inside into the same fresh remainder', () => {
    // Real payload: the cache figure is *within* inputTokens, which the
    // `totalTokens = inputTokens + outputTokens` identity confirms (17822 = 17816 + 6).
    const mapped = mapNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: {
          totalTokens: 17822,
          inputTokens: 17816,
          cachedInputTokens: 17152,
          cacheWriteInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
        },
      },
    });

    expect(mapped?.usage).toEqual({
      inputTokens: 664,
      outputTokens: 6,
      cacheReadTokens: 17152,
      cacheWriteTokens: 0,
    });
    // The whole input is recovered exactly — no cache figure counted twice.
    expect(wholeInput(mapped!.usage!)).toBe(17816);
    // A running thread total, so it replaces rather than accumulates.
    expect(mapped?.usageScope).toBe('session');
  });

  it('does not count a Codex cache write twice', () => {
    // Codex reports 0 here on every model YAAR has seen, so this guards the
    // arithmetic against the day it does not: a cache write is inside
    // `inputTokens` like a cache read, and adding the three fields back up must
    // still reconstruct exactly the input Codex reported.
    const mapped = mapNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: {
          totalTokens: 20006,
          inputTokens: 20000,
          cachedInputTokens: 15000,
          cacheWriteInputTokens: 4000,
          outputTokens: 6,
          reasoningOutputTokens: 0,
        },
      },
    });

    expect(mapped?.usage?.inputTokens).toBe(1000);
    expect(wholeInput(mapped!.usage!)).toBe(20000);
  });
});

describe('AgentSession lifetime accounting', () => {
  function session() {
    return new AgentSession('conn-usage-test');
  }

  it('adds turn-scoped reports into the lifetime total', async () => {
    const s = session();
    try {
      s.recordUsage({ inputTokens: 10, outputTokens: 47, cacheReadTokens: 15232, cacheWriteTokens: 3313 }, 'turn'); // prettier-ignore
      const { total } = s.recordUsage({ inputTokens: 10, outputTokens: 45, cacheReadTokens: 18545, cacheWriteTokens: 206 }, 'turn'); // prettier-ignore

      expect(total).toMatchObject({
        inputTokens: 20,
        outputTokens: 92,
        cacheReadTokens: 33777,
        cacheWriteTokens: 3519,
      });
    } finally {
      await s.cleanup();
    }
  });

  it('rebases a session-cumulative cost instead of summing it', async () => {
    const s = session();
    try {
      const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      // The three figures a real session reported across three turns. Summed,
      // they give $0.033 for a session that actually cost $0.0137.
      s.recordUsage(zero, 'turn', 0.0084);
      s.recordUsage(zero, 'turn', 0.0109);
      const { total } = s.recordUsage(zero, 'turn', 0.0137);

      expect(total.costUsd).toBeCloseTo(0.0137, 6);
    } finally {
      await s.cleanup();
    }
  });

  it('banks the old figure when a reopened provider stream restarts its cost at zero', async () => {
    const s = session();
    try {
      const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      s.recordUsage(zero, 'turn', 0.0084);
      s.recordUsage(zero, 'turn', 0.0137);
      // A prompt/model change reopens the CLI process, whose own counter starts
      // over. Replacing outright would lose the first stream's spend; the drop is
      // the signal to bank it.
      s.recordUsage(zero, 'turn', 0.002);
      const { total } = s.recordUsage(zero, 'turn', 0.005);

      expect(total.costUsd).toBeCloseTo(0.0187, 6);
    } finally {
      await s.cleanup();
    }
  });
});
