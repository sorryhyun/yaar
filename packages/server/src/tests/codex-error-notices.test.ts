/**
 * The Codex app-server's failure channels, and the `willRetry` bug they exposed.
 *
 * The Claude side of this (`claude-error-notices.test.ts`) fixed an omission.
 * Codex had the omission *and* a live defect: every `error` notification mapped
 * to a terminal `StreamMessage`, which latched the turn closed in
 * `StreamToEventMapper` and tripped the `done` short-circuit in
 * `CodexProvider`'s read loop — even when the notification carried
 * `willRetry: true`. A transient API error therefore killed a turn the
 * app-server was in the middle of retrying, and whatever it answered afterwards
 * was produced and thrown away.
 *
 * Two properties, both cheap to regress:
 *
 *   1. **`willRetry` decides the type.** True → `notice`, false → `error`. The
 *      mapper and the provider's loop must agree, or the stream and the loop
 *      disagree about whether the turn ended.
 *   2. **A turn failure says what failed.** `codexErrorInfo` is a typed union
 *      sitting right beside `TurnError.message`, and both it and
 *      `additionalDetails` were discarded — so an expired login and a context
 *      overflow both surfaced as the literal string `'Turn failed'`.
 */
import { describe, it, expect } from 'bun:test';
import { mapNotification } from '../providers/codex/message-mapper.js';

describe('Codex error notifications', () => {
  it('treats a retryable error as a notice, not a terminal error', () => {
    const mapped = mapNotification('error', {
      error: { message: 'stream disconnected', codexErrorInfo: 'serverOverloaded' },
      willRetry: true,
      threadId: 't',
      turnId: 'u',
    });
    expect(mapped?.type).toBe('notice');
    expect(mapped?.errorCode).toBe('serverOverloaded');
    expect(mapped?.content).toContain('overloaded');
    expect(mapped?.content).toContain('Retrying');
  });

  it('treats a final error as terminal, naming the typed cause', () => {
    const mapped = mapNotification('error', {
      error: { message: 'no', codexErrorInfo: 'unauthorized', additionalDetails: 'token expired' },
      willRetry: false,
      threadId: 't',
      turnId: 'u',
    });
    expect(mapped?.type).toBe('error');
    expect(mapped?.errorCode).toBe('unauthorized');
    expect(mapped?.error).toContain('codex login');
    expect(mapped?.error).toContain('token expired');
  });

  it('reads the HTTP status out of the object-shaped error variants', () => {
    const mapped = mapNotification('error', {
      error: { message: '', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
      willRetry: false,
    });
    expect(mapped?.errorCode).toBe('httpConnectionFailed');
    expect(mapped?.error).toContain('503');
  });

  it('no longer reduces a failed turn to the string "Turn failed"', () => {
    const mapped = mapNotification('turn/completed', {
      threadId: 't',
      turn: {
        id: 'u',
        status: 'failed',
        error: { message: '', codexErrorInfo: 'contextWindowExceeded', additionalDetails: null },
      },
    });
    expect(mapped?.type).toBe('error');
    expect(mapped?.error).not.toBe('Turn failed');
    expect(mapped?.error).toContain('context window');
    expect(mapped?.errorCode).toBe('contextWindowExceeded');
  });

  it('still falls back to the app-server prose when there is no typed code', () => {
    const mapped = mapNotification('turn/completed', {
      threadId: 't',
      turn: { id: 'u', status: 'failed', error: { message: 'sandbox denied write' } },
    });
    expect(mapped?.error).toBe('sandbox denied write');
  });

  it('leaves a clean turn as a plain completion', () => {
    expect(
      mapNotification('turn/completed', { threadId: 't', turn: { status: 'completed' } }),
    ).toEqual({ type: 'complete' });
  });
});

describe("Codex's user-facing warning channels", () => {
  it('forwards the four dedicated warning notifications', () => {
    const warn = mapNotification('warning', { threadId: 't', message: 'disk is nearly full' });
    expect(warn?.type).toBe('notice');
    expect(warn?.noticeLevel).toBe('warning');
    expect(warn?.content).toContain('disk is nearly full');

    const guardian = mapNotification('guardianWarning', {
      threadId: 't',
      message: 'risky command',
    });
    expect(guardian?.errorCode).toBe('guardian_warning');

    const config = mapNotification('configWarning', {
      summary: 'unknown key "modle"',
      details: 'did you mean "model"?',
      path: '~/.codex/config.toml',
    });
    expect(config?.content).toContain('config.toml');
    expect(config?.content).toContain('did you mean');

    const deprecation = mapNotification('deprecationNotice', {
      summary: 'approval_policy is renamed',
      details: null,
    });
    // A deprecation is bookkeeping, not a problem with this turn.
    expect(deprecation?.noticeLevel).toBe('info');
  });

  it("surfaces a model reroute, the counterpart of Claude's refusal fallback", () => {
    const mapped = mapNotification('model/rerouted', {
      threadId: 't',
      turnId: 'u',
      fromModel: 'gpt-5-codex',
      toModel: 'gpt-5',
      reason: 'highRiskCyberActivity',
    });
    expect(mapped?.type).toBe('notice');
    expect(mapped?.content).toContain('gpt-5-codex');
    expect(mapped?.content).toContain('highRiskCyberActivity');
  });

  it('explains a turn gone quiet for safety buffering, but only when it is showing', () => {
    expect(
      mapNotification('model/safetyBuffering/updated', { showBufferingUi: false, reasons: [] }),
    ).toBeNull();
    const shown = mapNotification('model/safetyBuffering/updated', {
      showBufferingUi: true,
      model: 'gpt-5',
      reasons: ['cyber'],
    });
    expect(shown?.errorCode).toBe('safety_buffering');
  });

  it('reports an MCP server that failed to start, and stays quiet for the rest', () => {
    for (const status of ['starting', 'ready', 'cancelled']) {
      expect(
        mapNotification('mcpServer/startupStatus/updated', { name: 'yaar-verbs', status }),
      ).toBeNull();
    }
    const failed = mapNotification('mcpServer/startupStatus/updated', {
      name: 'yaar-verbs',
      status: 'failed',
      error: null,
      failureReason: 'reauthenticationRequired',
    });
    expect(failed?.errorCode).toBe('mcp_server_failed');
    expect(failed?.content).toContain('yaar-verbs');
    expect(failed?.content).toContain('reauthenticationRequired');
  });

  it('forwards a reached usage limit and swallows the rolling gauge', () => {
    // A sparse rolling update rides many turns; `usedPercent` alone is a gauge,
    // and this mapper holds no state to dedupe a per-request notice against.
    expect(
      mapNotification('account/rateLimits/updated', {
        rateLimits: { primary: { usedPercent: 71 }, rateLimitReachedType: null },
      }),
    ).toBeNull();

    const reached = mapNotification('account/rateLimits/updated', {
      rateLimits: {
        rateLimitReachedType: 'workspace_owner_credits_depleted',
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        primary: { usedPercent: 100, resetsAt: null },
      },
    });
    expect(reached?.type).toBe('notice');
    expect(reached?.errorCode).toBe('workspace_owner_credits_depleted');
    expect(reached?.content).toContain('No credits remaining');
  });

  it('keeps ignoring the notifications that were ignored on purpose', () => {
    for (const method of [
      'thread/compacted',
      'account/updated',
      'app/list/updated',
      'turn/plan/updated',
      'model/verification',
      'item/autoApprovalReview/completed',
    ]) {
      expect(mapNotification(method, {})).toBeNull();
    }
  });
});
