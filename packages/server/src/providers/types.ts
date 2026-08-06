/**
 * Transport layer interfaces for AI providers — abstracts how we talk to
 * different SDKs (Agent SDK, Codex) without changing session logic.
 */

export type ProviderType = 'claude' | 'codex';

export interface ProviderInfo {
  type: ProviderType;
  displayName: string;
  description: string;
  requiredCli?: string;
  requiredEnvVars?: string[];
}

/**
 * Token consumption, normalized across providers.
 *
 * The two SDKs disagree about what "input" means, so the *mappers* reconcile it
 * and everything downstream reads one meaning: `inputTokens` is **fresh** input —
 * neither read from the cache nor written to it. Claude already reports it that
 * way (`input_tokens` excludes both cache counts, which are separate fields);
 * Codex folds cache reads into `inputTokens`, so its mapper subtracts them, which
 * is also how Codex itself computes a blended total.
 *
 * `inputTokens + outputTokens` is therefore the cache-excluded total — the number
 * Process Explorer shows. The two cache counts ride along because the
 * fresh-vs-cache-read ratio is the cheapest signal there is for an agent that is
 * thrashing its context; nothing displays them yet.
 */
export interface TokenUsage {
  /** Input tokens that were neither a cache read nor a cache write. */
  inputTokens: number;
  /** Output tokens, reasoning/thinking included. */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported cost, when it reports one (Claude does; Codex doesn't). */
  costUsd?: number;
}

/**
 * One firing of an escape guard, kept for the session log.
 *
 * Two guards, two stages. `tripwire` fires mid-stream on arguments being
 * written as `\uXXXX` escapes and the turn is cancelled, so `sample` is the raw
 * argument JSON as far as it had been generated. `repair` fires in the
 * `PreToolUse` hook on arguments that already landed, so `sample` is the
 * offending value *before* the rewrite and the path lists say which fields.
 *
 * `sample` is truncated (`ESCAPE_SAMPLE_LIMIT`) — the evidence is the spelling,
 * which the first line of it already shows, and a whole escaped document in the
 * log is just the same six characters repeated a thousand times.
 *
 * @see providers/claude/escape-tripwire.ts, providers/claude/escape-hook.ts
 */
export interface EscapeGuardRecord {
  stage: 'tripwire' | 'repair';
  toolName: string;
  /** The text that triggered it, truncated. Raw JSON for `tripwire`. */
  sample: string;
  /** Dotted paths whose literal escape runs were decoded (`repair` only). */
  overEscaped?: string[];
  /** Dotted paths whose nested JSON was re-escaped (`repair` only). */
  underEscaped?: string[];
}

/** How much triggering text a record carries. See {@link EscapeGuardRecord}. */
export const ESCAPE_SAMPLE_LIMIT = 300;

/** Truncate triggering text to {@link ESCAPE_SAMPLE_LIMIT}, marking what was dropped. */
export function escapeSample(text: string): string {
  return text.length > ESCAPE_SAMPLE_LIMIT
    ? `${text.slice(0, ESCAPE_SAMPLE_LIMIT)}… (${text.length} chars)`
    : text;
}

export interface StreamMessage {
  /**
   * `tool_use_start` and `tool_input_delta` are the *parameter-generation* phase
   * of a call, split out from `tool_use` so a long argument doesn't render as
   * silence. `tool_use` still arrives afterwards carrying the complete, parsed
   * `toolInput` and remains the authoritative one — the two delta types are
   * additive and a provider that cannot produce them (Codex hands arguments over
   * whole) simply never does.
   *
   * `tool_output_delta` is the same idea for the *result* phase: chunks of a
   * running tool's stdout/stderr, in order, so a long command isn't silence.
   * `tool_result` still arrives afterwards with the complete output and stays
   * authoritative — the deltas are a live tail, and a provider that cannot
   * produce them (Claude) simply never does.
   *
   * `usage` carries token accounting and nothing else. It exists because Codex
   * reports usage *mid-turn* (`thread/tokenUsage/updated`), where there is no
   * other message to hang it on; Claude reports it once at the end, so there it
   * rides on `complete`/`error` instead. Either way the payload is `usage` +
   * `usageScope`, folded in one place by `StreamToEventMapper`.
   *
   * `notice` is everything a provider says about trouble that did **not** end the
   * turn: a retry after a 529, an auto-denied tool call, a model refusal that a
   * fallback recovered from, an exhausted subscription limit. It exists because
   * `error` is terminal by contract — `StreamToEventMapper.map` latches the turn
   * closed on it — so reporting a recoverable failure that way would end the turn
   * in the UI while the provider carried on working. `content` holds the text,
   * `noticeLevel` how loudly to say it, `errorCode` the provider's own
   * discriminant. A provider that surfaces none of this (Codex) never emits one.
   */
  type:
    | 'text'
    | 'thinking'
    | 'tool_use_start'
    | 'tool_input_delta'
    | 'tool_use'
    | 'tool_output_delta'
    | 'tool_result'
    | 'usage'
    | 'notice'
    | 'complete'
    | 'error';
  /**
   * Text/thinking delta — and, on `tool_input_delta`, a raw fragment of the
   * argument JSON. That fragment is display-only: it is a prefix of a JSON
   * document, so it must not be parsed. Wait for `tool_use.toolInput`.
   * On `tool_output_delta`, a fragment of the tool's output — a prefix of what
   * `tool_result` will carry whole, to be appended rather than to replace.
   */
  content?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  /**
   * How the raw argument JSON spelled its text, recorded before JSON.parse
   * erases the distinction. `unicodeEscapes` counts `\uXXXX` spellings that
   * decoded to printable characters (valid JSON, normalized on parse);
   * `literalBackslashU` counts backslash-u sequences that survived parsing as
   * literal text in the value — the double-escape form that actually corrupts
   * payloads. Absent when the raw text had neither, or the provider hands
   * arguments over pre-parsed (Codex).
   */
  toolInputEscapes?: { unicodeEscapes: number; literalBackslashU: number };
  toolUseId?: string;
  error?: string;
  /**
   * The provider's own discriminant for an `error` or a `notice` — Claude's
   * `SDKAssistantMessageError` code, its `TerminalReason`, or the mapper's name
   * for the frame (`api_retry`, `permission_denied`, …).
   *
   * Carried alongside the prose rather than baked into it so a consumer can key
   * off the failure without parsing English: `authentication_failed` is worth a
   * "run `claude login`" affordance, `overloaded` is worth nothing but patience.
   */
  errorCode?: string;
  /** How prominently to show a `notice`. See the `notice` type above. */
  noticeLevel?: 'info' | 'warning';
  /**
   * Set on a `notice` raised by the escape guards, carrying the evidence.
   *
   * A notice is otherwise prose — it says what happened and is gone. This one
   * has to survive the session, because the thing it describes is a model
   * defect worth reporting upstream and the offending text is the report. The
   * `notice` branch of `StreamToEventMapper` persists it via
   * `SessionLogger.logEscapeGuard`; nothing else reads it.
   *
   * Note that a tripped turn is *cancelled*, so no `tool_use` entry is ever
   * written for it and `toolInputEscapes` above never gets the chance to
   * describe it. This is the only record that call happened at all.
   */
  escapeGuard?: EscapeGuardRecord;
  isError?: boolean;
  /** Token accounting, normalized. Present on `usage`, and on Claude's terminals. */
  usage?: TokenUsage;
  /**
   * What the numbers in `usage` cover — the one thing a consumer cannot guess,
   * and getting it wrong silently double-counts or undercounts forever.
   *
   * `turn` — consumption of *this turn only*; add it to the running total.
   *   Claude's `result.usage` is this: one per `query()`.
   * `session` — the provider's own running total for the whole thread; replace
   *   the running total with it. Codex's `tokenUsage.total` is this, and it
   *   arrives repeatedly within a single turn.
   *
   * Note that `turn` on Claude no longer means "once, at the end": the mapper
   * reports deltas as the turn runs, so several turn-scoped reports may arrive
   * before the terminal. Summing them is still the correct handling.
   */
  usageScope?: 'turn' | 'session';
  /**
   * The provider's running cost for the *whole session*, in USD.
   *
   * Deliberately not `usage.costUsd`, and deliberately not covered by
   * `usageScope`: Claude's `total_cost_usd` is cumulative even on a message
   * whose token figures are the turn's alone, so one scope cannot describe
   * both. Summing this field is always wrong — see `AgentSession.recordUsage`,
   * which rebases it instead.
   */
  sessionCostUsd?: number;
}

export interface TransportOptions {
  systemPrompt: string;
  model?: string;
  sessionId?: string; // For session resumption, or parent session when forking
  forkSession?: boolean; // When true with sessionId, creates a fork instead of continuing
  resumeThread?: boolean; // When true with sessionId, resume via thread/resume
  images?: string[]; // Base64 data URLs for images (e.g., user drawings)
  monitorId?: string; // Which monitor originated this query (for action routing)
  agentId?: string; // Agent instance ID (for MCP header-based routing)
  allowedTools?: string[]; // Profile-specific tool subset (overrides default getToolNames())
}

/**
 * What a provider can say about an interrupt it just performed.
 *
 * The point of the type is that "we asked it to stop" and "it stopped" are
 * different facts, and only the provider knows which one happened. The Claude
 * Agent SDK says so explicitly — `query.interrupt()` resolves with a receipt
 * carrying `still_queued`, the messages the CLI kept *after* the interrupt — so
 * a provider that fires the request and returns has not learned anything, and a
 * caller that reports "stopped" off that has told the user something it does
 * not know. Every provider returns one of these and every caller may log it;
 * the escalation to a hard stop happens inside the provider, because only it
 * knows what its hard stop is.
 */
export interface InterruptReceipt {
  /**
   * `acknowledged` — the provider confirmed the turn stopped.
   * `escalated` — the acknowledgement was missing, late, or reported leftover
   *   work, so the provider took the turn down the hard way (killing the
   *   process, aborting the stream). Still stopped, but worth a log line.
   * `idle` — nothing was running.
   */
  outcome: 'acknowledged' | 'escalated' | 'idle';
  /** Ids the provider reported as still queued after the interrupt, if any. */
  stillQueued?: string[];
}

export interface AITransport {
  readonly name: string;
  readonly providerType: ProviderType;
  readonly systemPrompt: string;

  isAvailable(): Promise<boolean>;
  query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage>;
  /** Stop the in-flight turn. Resolves only once the turn is actually stopped. */
  interrupt(): Promise<InterruptReceipt>;
  dispose(): Promise<void>;

  /**
   * Inject additional input into the active turn (mid-turn steering).
   * Returns true if successfully steered, false if not supported or failed.
   */
  steer?(content: string): Promise<boolean>;

  getSessionId?(): string | null;

  /**
   * Pre-open the provider's long-lived stream (process + MCP connections) with
   * the exact options the first turn will use, so that turn starts instantly.
   * No message is sent.
   */
  prewarm?(options: TransportOptions): Promise<void>;
}
