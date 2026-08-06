/**
 * The Claude SDK's failure channels, and the line between "notice" and "error".
 *
 * The mapper used to read one of the SDK's five failure channels and to render a
 * failed turn as the literal string "Unknown SDK error" whenever `errors[]` came
 * back empty — which is most of the time. Two properties keep the replacement
 * honest, and both are easy to regress by accident:
 *
 *   1. **A recoverable failure is a `notice`, never an `error`.** `error` is
 *      terminal by contract: `StreamToEventMapper.map` calls `fail()` on it,
 *      which latches the turn closed, and `ClaudeSessionProvider` stops reading
 *      the stream. A `rate_limit` or a 529 is normally followed by an
 *      `api_retry` and then a perfectly good answer, so classifying one as an
 *      error would end the turn in the UI while the CLI kept working.
 *   2. **A terminal error says what actually happened.** `terminal_reason` and
 *      `stop_reason` carry the cause whenever `errors[]` does not, and
 *      `errors[]` must still survive verbatim — `session-provider.ts` matches
 *      `No conversation found` in it to retry without `resume`.
 */
import { describe, it, expect } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ServerEventType, type ServerEvent, type StreamFrame } from '@yaar/shared';
import { mapClaudeMessage } from '../providers/claude/message-mapper.js';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { actionEmitter } from '../session/action-emitter.js';
import type { SessionScopedEvent } from '../session/emitter-channels.js';
import type { ContextSource } from '../agents/context.js';

const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;

describe('Claude failure channels → StreamMessage', () => {
  it('maps a typed assistant error to a non-terminal notice', () => {
    const mapped = mapClaudeMessage(
      sdk({ type: 'assistant', message: {}, error: 'rate_limit', session_id: 's1' }),
    );
    expect(mapped?.type).toBe('notice');
    expect(mapped?.noticeLevel).toBe('warning');
    expect(mapped?.errorCode).toBe('rate_limit');
    expect(mapped?.content).toContain('Rate limited');
    // The session id still rides along — the assistant frame is how the mapper
    // learns it, and swallowing it here would break session resumption.
    expect(mapped?.sessionId).toBe('s1');
  });

  it('leaves a clean assistant frame as the session-tracking ping it was', () => {
    const mapped = mapClaudeMessage(sdk({ type: 'assistant', message: {}, session_id: 's1' }));
    expect(mapped).toEqual({ type: 'text', sessionId: 's1' });
  });

  it('reports an interrupt-truncated assistant frame as an info notice', () => {
    const mapped = mapClaudeMessage(
      sdk({ type: 'assistant', message: {}, aborted: true, session_id: 's1' }),
    );
    expect(mapped?.type).toBe('notice');
    expect(mapped?.noticeLevel).toBe('info');
    expect(mapped?.errorCode).toBe('aborted');
  });

  it('surfaces an API retry with its attempt and backoff', () => {
    const mapped = mapClaudeMessage(
      sdk({
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 8000,
        error_status: 529,
        error: 'overloaded',
        session_id: 's1',
      }),
    );
    expect(mapped?.type).toBe('notice');
    expect(mapped?.errorCode).toBe('api_retry');
    expect(mapped?.content).toContain('overloaded');
    expect(mapped?.content).toContain('529');
    expect(mapped?.content).toContain('2/10');
    expect(mapped?.content).toContain('8s');
  });

  it('surfaces an auto-denied tool call with the deciding reason', () => {
    const mapped = mapClaudeMessage(
      sdk({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        decision_reason: 'matched a deny rule',
        message: 'told to the model',
        session_id: 's1',
      }),
    );
    expect(mapped?.type).toBe('notice');
    expect(mapped?.errorCode).toBe('permission_denied');
    expect(mapped?.content).toContain('Bash');
    expect(mapped?.content).toContain('matched a deny rule');
  });

  it('surfaces a model refusal, and marks a recovered one as merely informational', () => {
    const refused = mapClaudeMessage(
      sdk({
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        original_model: 'claude-opus-5',
        api_refusal_category: 'cyber',
        api_refusal_explanation: 'declined',
        session_id: 's1',
      }),
    );
    expect(refused?.noticeLevel).toBe('warning');
    expect(refused?.content).toContain('cyber');

    const recovered = mapClaudeMessage(
      sdk({
        type: 'system',
        subtype: 'model_refusal_fallback',
        original_model: 'claude-opus-5',
        fallback_model: 'claude-sonnet-5',
        session_id: 's1',
      }),
    );
    expect(recovered?.noticeLevel).toBe('info');
    expect(recovered?.content).toContain('claude-sonnet-5');
  });

  it('forwards a rejected subscription limit and swallows the per-request chatter', () => {
    // `allowed` and `allowed_warning` can ride every single request; forwarding
    // them would be a firehose and the mapper holds no state to dedupe against.
    for (const status of ['allowed', 'allowed_warning']) {
      expect(
        mapClaudeMessage(
          sdk({ type: 'rate_limit_event', rate_limit_info: { status }, session_id: 's1' }),
        ),
      ).toBeNull();
    }
    const rejected = mapClaudeMessage(
      sdk({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
        session_id: 's1',
      }),
    );
    expect(rejected?.type).toBe('notice');
    expect(rejected?.errorCode).toBe('rate_limit_rejected');
    expect(rejected?.content).toContain('five-hour');
  });

  it('names the cause of a terminal error whose errors[] is empty', () => {
    const mapped = mapClaudeMessage(
      sdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
        terminal_reason: 'prompt_too_long',
        stop_reason: null,
        session_id: 's1',
      }),
    );
    expect(mapped?.type).toBe('error');
    expect(mapped?.error).not.toContain('Unknown SDK error');
    expect(mapped?.error).toContain('context window');
    expect(mapped?.errorCode).toBe('prompt_too_long');
  });

  it('keeps errors[] verbatim, since the stale-session retry matches on it', () => {
    const mapped = mapClaudeMessage(
      sdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No conversation found with session ID: abc'],
        session_id: 's1',
      }),
    );
    expect(mapped?.type).toBe('error');
    expect(mapped?.error).toContain('No conversation found');
  });

  it('appends a non-end_turn stop reason, which otherwise looked like a clean stop', () => {
    const mapped = mapClaudeMessage(
      sdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
        stop_reason: 'refusal',
        session_id: 's1',
      }),
    );
    expect(mapped?.error).toContain('refusal');
  });
});

describe('a notice does not end the turn', () => {
  function makeMapper() {
    const events: ServerEvent[] = [];
    const state = { responseText: '', thinkingText: '', currentMessageId: null };
    const mapper = new StreamToEventMapper({
      role: 'monitor',
      providerName: 'claude',
      state,
      sendEvent: async (e) => {
        events.push(e);
      },
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
      monitorId: '0',
    });
    return { mapper, events, state };
  }

  it('emits AGENT_NOTICE and leaves the answer and the turn latch untouched', async () => {
    const { mapper, events, state } = makeMapper();
    mapper.start();
    await mapper.map({ type: 'text', content: 'partial' });
    await mapper.map({
      type: 'notice',
      content: 'The Claude API is overloaded. Retrying 1/10 in 2s.',
      noticeLevel: 'warning',
      errorCode: 'api_retry',
    });
    await mapper.map({ type: 'text', content: ' answer' });
    await mapper.map({ type: 'complete' });

    const notice = events.find((e) => e.type === ServerEventType.AGENT_NOTICE);
    expect(notice).toBeDefined();
    expect((notice as { code?: string }).code).toBe('api_retry');
    expect((notice as { level?: string }).level).toBe('warning');

    // The notice is commentary beside the answer, not part of it.
    expect(state.responseText).toBe('partial answer');
    // And it did not latch the turn: the provider's `complete` still closed it.
    expect(
      events.some(
        (e) =>
          e.type === ServerEventType.AGENT_RESPONSE && (e as { isComplete?: boolean }).isComplete,
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === ServerEventType.ERROR)).toBe(false);
  });

  it('publishes a `notice` frame on the agent stream, before and not instead of `done`', async () => {
    const instanceId = 'agent-notice-1';
    const streamSessionId = 'ses-notice-test';
    const uri = `yaar://agents/${instanceId}/stream`;
    const captured: StreamFrame[] = [];
    const listener = (e: SessionScopedEvent) => {
      const { event } = e as { event: ServerEvent };
      if (event.type === ServerEventType.STREAM_FRAME) captured.push(event.frame);
    };
    actionEmitter.on('verb-subscription', listener);
    const subId = subscriptionRegistry.subscribe('tok', 'win-1', streamSessionId, uri, 'stream');
    try {
      const state = { responseText: '', thinkingText: '', currentMessageId: null };
      const mapper = new StreamToEventMapper({
        role: 'monitor',
        providerName: 'claude',
        state,
        sendEvent: async () => {},
        logger: null,
        source: 'yaar://monitors/0' as ContextSource,
        monitorId: '0',
        agentInstanceId: instanceId,
        streamSessionId,
      });
      await mapper.map({
        type: 'notice',
        content: 'Rate limited by the Claude API.',
        noticeLevel: 'warning',
        errorCode: 'rate_limit',
      });
      await mapper.map({ type: 'complete' });
      await new Promise((r) => setTimeout(r, 90));

      expect(captured.map((f) => f.kind)).toEqual(['notice', 'done']);
      expect(captured[0].data).toMatchObject({ level: 'warning', code: 'rate_limit' });
    } finally {
      subscriptionRegistry.unsubscribe(subId);
      actionEmitter.off('verb-subscription', listener);
    }
  });
});
