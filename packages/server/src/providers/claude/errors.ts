/**
 * The Claude Agent SDK's failure vocabulary, translated once.
 *
 * The SDK reports trouble on **five** channels and the mapper historically read
 * exactly one of them — `result.is_error`, whose `errors[]` array is frequently
 * empty, which is how a failed turn came to render as the literal string
 * "Unknown SDK error". The other four say precisely what went wrong and were
 * discarded on the floor:
 *
 * | channel | what it says | was |
 * |---|---|---|
 * | `assistant.error` | a typed {@link SDKAssistantMessageError} — `rate_limit`, `billing_error`, `authentication_failed`, … | dropped |
 * | `system/api_retry` | a transient failure is being retried, with attempt and backoff | dropped |
 * | `system/permission_denied` | a tool call was auto-denied, with the deciding reason | dropped |
 * | `system/model_refusal_*` | the model refused, and whether a fallback ran | dropped |
 * | `rate_limit_event` | the subscription's own limit was hit | dropped |
 *
 * **Most of these are not terminal**, which is the whole reason they need their
 * own channel rather than riding `StreamMessage.type === 'error'`. A `rate_limit`
 * on an assistant frame is normally followed by an `api_retry` and then a
 * perfectly good answer; `StreamToEventMapper.map`'s `error` case calls `fail()`,
 * which *latches the turn closed*. Reporting them as errors would end the turn in
 * the UI while the CLI kept working — strictly worse than the silence it replaced.
 * So every one of them becomes a non-terminal `notice`, and only the SDK's own
 * `result` terminal stays an `error`.
 *
 * The two enum tables below are typed as total `Record`s over the SDK's unions on
 * purpose: when a CLI bump adds a code, the build breaks here and someone writes
 * a sentence for it. Lookups are still defensive, because the *wire* can carry a
 * code the installed types do not know (an older or newer CLI than this build).
 */

import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderNotice } from '../notice.js';

/**
 * One sentence per {@link SDKAssistantMessageError}.
 *
 * These describe the *API call*, not the turn: the SDK retries the transient ones
 * (`rate_limit`, `overloaded`, `server_error`) on its own, so the sentences avoid
 * claiming anything about whether the turn survived. When it does not, the
 * `result` terminal says so separately.
 */
const ASSISTANT_ERROR_TEXT: Record<SDKAssistantMessageError, string> = {
  authentication_failed:
    'Claude CLI authentication failed — run `claude login`, or set CLAUDE_CODE_OAUTH_TOKEN.',
  oauth_org_not_allowed: "This Claude account's organization is not allowed to use the API.",
  account_on_hold:
    'This Claude account is on hold and cannot make API calls until it is reinstated.',
  billing_error: 'Claude rejected the request for a billing reason — check the plan or credit.',
  rate_limit: 'Rate limited by the Claude API.',
  overloaded: 'The Claude API is overloaded.',
  invalid_request: 'The Claude API rejected the request as malformed.',
  model_not_found: 'The configured model does not exist or is not available to this account.',
  server_error: 'The Claude API returned a server error.',
  max_output_tokens: 'The response reached the max output-token limit and was cut off.',
  unknown: 'The Claude API call failed for an unspecified reason.',
};

/**
 * One clause per `TerminalReason` — a *reason fragment*, not a sentence, because
 * it is always appended to whatever the result already said ("Reason: …").
 *
 * Deliberately not typed as `Record<TerminalReason, string>`: `TerminalReason`
 * carries `completed` and `background_requested`, which are not failures at all,
 * and a partial map lets the lookup below return `null` for "nothing worth
 * saying" without a second exclusion list.
 */
const TERMINAL_REASON_TEXT: Readonly<Record<string, string>> = {
  blocking_limit: 'a usage limit blocked the turn',
  rapid_refill_breaker: 'the rapid-refill circuit breaker tripped',
  prompt_too_long: 'the prompt exceeded the model context window',
  image_error: 'an attached image could not be processed',
  model_error: 'the model errored',
  api_error: 'the API errored',
  malformed_tool_use_exhausted: 'the model kept emitting malformed tool calls',
  aborted_streaming: 'the response stream was aborted',
  aborted_tools: 'the turn was aborted while tools were running',
  stop_hook_prevented: 'a Stop hook prevented continuation',
  hook_stopped: 'a hook stopped the turn',
  tool_deferred: 'a tool call was deferred',
  tool_deferred_unavailable: 'a deferred tool call could not be resumed',
  max_turns: 'the turn limit was reached',
  budget_exhausted: 'the cost budget was exhausted',
  structured_output_retry_exhausted: 'structured-output retries were exhausted',
  turn_setup_failed: 'the turn could not be set up',
};

/** One sentence per `SDKResultError['subtype']`, used when `errors[]` is empty. */
const RESULT_SUBTYPE_TEXT: Readonly<Record<string, string>> = {
  error_during_execution: 'The turn failed during execution.',
  error_max_turns: 'The turn hit its maximum number of turns.',
  error_max_budget_usd: 'The turn hit its maximum USD budget.',
  error_max_structured_output_retries: 'The turn exhausted its structured-output retries.',
};

/** The sentence for an assistant-level error code, naming the code if it is unknown to us. */
function assistantErrorText(code: string): string {
  return ASSISTANT_ERROR_TEXT[code as SDKAssistantMessageError] ?? `Claude API error: ${code}.`;
}

/**
 * The notice an `assistant` message carries, or null if it carries none.
 *
 * Two independent signals ride the same frame: `error` (the API call failed) and
 * `aborted` (an interrupt cut the content off mid-word). `error` wins when both
 * are set — an abort during a failing call is the failure's consequence, and two
 * notices for one frame would double-report it.
 */
export function assistantNotice(msg: SDKMessage): ProviderNotice | null {
  const m = msg as { error?: string; aborted?: true };
  if (m.error) {
    return { level: 'warning', code: m.error, text: assistantErrorText(m.error) };
  }
  if (m.aborted) {
    return {
      level: 'info',
      code: 'aborted',
      text: 'The response was cut short by an interrupt.',
    };
  }
  return null;
}

/**
 * The notice a `system` message carries, or null for the subtypes that are not
 * about failure (`init`, the `task_*` lifecycle the mapper handles itself, and
 * everything else).
 *
 * Structural narrowing rather than the SDK's per-message types on purpose: this
 * runs against whatever CLI the user has installed, and a subtype the installed
 * `.d.ts` does not know is a field read that returns `undefined`, not a crash.
 * `mirror_error` is deliberately absent — it reports the CLI's own session-file
 * mirroring, which no user can act on and which does not affect the answer.
 */
export function systemNotice(msg: SDKMessage): ProviderNotice | null {
  if ((msg as { type?: string }).type !== 'system') return null;
  const m = msg as {
    subtype?: string;
    attempt?: number;
    max_retries?: number;
    retry_delay_ms?: number;
    error_status?: number | null;
    error?: string;
    tool_name?: string;
    decision_reason?: string;
    message?: string;
    original_model?: string;
    fallback_model?: string;
    api_refusal_category?: string | null;
    api_refusal_explanation?: string | null;
    content?: string;
  };

  switch (m.subtype) {
    case 'api_retry': {
      const status = typeof m.error_status === 'number' ? ` (HTTP ${m.error_status})` : '';
      const attempt =
        m.attempt && m.max_retries
          ? ` ${m.attempt}/${m.max_retries}`
          : m.attempt
            ? ` ${m.attempt}`
            : '';
      const delay = m.retry_delay_ms ? ` in ${Math.round(m.retry_delay_ms / 1000)}s` : '';
      return {
        level: 'warning',
        code: 'api_retry',
        text: `${assistantErrorText(m.error ?? 'unknown')}${status} Retrying${attempt}${delay}.`,
      };
    }
    case 'permission_denied': {
      // `message` is what the model was told; `decision_reason` is why. Prefer the
      // latter — the model's rejection text is written for the model, not for us.
      const why = m.decision_reason ?? m.message;
      return {
        level: 'warning',
        code: 'permission_denied',
        text: `Tool ${m.tool_name ?? 'call'} was denied${why ? `: ${why}` : '.'}`,
      };
    }
    case 'model_refusal_fallback':
      return {
        level: 'info',
        code: 'model_refusal_fallback',
        text: `${m.original_model ?? 'The model'} refused the request${
          m.api_refusal_category ? ` (${m.api_refusal_category})` : ''
        }; retrying on ${m.fallback_model ?? 'a fallback model'}.`,
      };
    case 'model_refusal_no_fallback':
      return {
        level: 'warning',
        code: 'model_refusal_no_fallback',
        text: `${m.original_model ?? 'The model'} refused the request${
          m.api_refusal_category ? ` (${m.api_refusal_category})` : ''
        }${m.api_refusal_explanation ? `: ${m.api_refusal_explanation}` : '.'}`,
      };
    default:
      return null;
  }
}

/**
 * The notice a `rate_limit_event` carries — **only** when the limit actually
 * rejected the call.
 *
 * The SDK emits this frame with whatever rate-limit headers the API returned, so
 * on a subscription plan it can arrive on *every* request. `allowed` is the
 * steady state and `allowed_warning` repeats for as long as utilization stays
 * above the threshold; forwarding either would be a firehose, and this mapper
 * holds no cross-turn state to dedupe against. `rejected` is the one status that
 * is news each time it happens, and it is exactly the one a silent desktop
 * currently gives no explanation for.
 */
export function rateLimitNotice(msg: SDKMessage): ProviderNotice | null {
  if ((msg as { type?: string }).type !== 'rate_limit_event') return null;
  const info = (
    msg as {
      rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number };
    }
  ).rate_limit_info;
  if (!info || info.status !== 'rejected') return null;
  const which = info.rateLimitType ? `${info.rateLimitType.replace(/_/g, '-')} ` : '';
  const resets = info.resetsAt ? ` Resets at ${new Date(info.resetsAt * 1000).toISOString()}.` : '';
  return {
    level: 'warning',
    code: 'rate_limit_rejected',
    text: `Your Claude ${which}usage limit is exhausted.${resets}`,
  };
}

/**
 * What a `result` error should actually say, assembled from every field that
 * carries meaning instead of from `errors[]` alone.
 *
 * Order matters: `errors[]` is the SDK's own prose and wins when it has any (it
 * is also where `No conversation found` lives, which `session-provider.ts`
 * pattern-matches to retry without `resume` — so it must stay verbatim and
 * first). Absent that, the subtype gives a sentence, `terminal_reason` gives the
 * clause that names the actual cause, and a non-`end_turn` `stop_reason` is
 * appended because a turn that stopped on `max_tokens` or `refusal` looked
 * identical to one that finished.
 */
export function describeResultError(result: {
  subtype?: string;
  errors?: string[];
  terminal_reason?: string;
  stop_reason?: string | null;
}): { text: string; code: string } {
  const errorsText = (result.errors ?? []).filter(Boolean).join('; ');
  const parts: string[] = [
    errorsText ||
      (result.subtype && RESULT_SUBTYPE_TEXT[result.subtype]) ||
      'The provider ended the turn with an unspecified error.',
  ];
  const reason = result.terminal_reason && TERMINAL_REASON_TEXT[result.terminal_reason];
  if (reason) parts.push(`Reason: ${reason}.`);
  if (result.stop_reason && result.stop_reason !== 'end_turn') {
    parts.push(`Stop reason: ${result.stop_reason}.`);
  }
  return {
    text: parts.join(' '),
    code: result.terminal_reason ?? result.subtype ?? 'error',
  };
}
