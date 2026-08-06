/**
 * The Codex app-server's failure vocabulary, translated once.
 *
 * The mirror of `claude/errors.ts`, and Codex actually says *more* than Claude
 * does — it just said it into a `console.debug`. Four dedicated user-facing
 * channels (`warning`, `guardianWarning`, `configWarning`, `deprecationNotice`)
 * fell through the mapper's `default:` case; `account/rateLimits/updated` and
 * `model/rerouted` were listed in `IGNORED_METHODS` by name; and every turn
 * failure was reduced to `TurnError.message`, discarding the typed
 * `CodexErrorInfo` beside it and `additionalDetails` under it.
 *
 * The load-bearing one is `ErrorNotification.willRetry`. Every `error`
 * notification used to map to a terminal `StreamMessage`, which both latched the
 * turn closed in `StreamToEventMapper` *and* tripped the `done` short-circuit in
 * `CodexProvider`'s read loop — so a transient failure the app-server was about
 * to retry ended the turn, and the answer Codex went on to produce was never
 * read. `willRetry: true` is a {@link ProviderNotice} for exactly that reason.
 */

import type { ProviderNotice } from '../notice.js';
import type { CodexErrorInfo, TurnError } from './types.js';

/**
 * One sentence per string variant of `CodexErrorInfo`.
 *
 * Typed as a total `Record` over the string members so a `make codex-types`
 * regeneration that adds one breaks the build here rather than degrading to the
 * raw camelCase identifier. The object variants (`httpConnectionFailed` and
 * friends, which carry an `httpStatusCode`) are handled separately below —
 * they are a different shape, not a different code.
 */
type CodexErrorCode = Extract<CodexErrorInfo, string>;

const CODEX_ERROR_TEXT: Record<CodexErrorCode, string> = {
  contextWindowExceeded: 'The conversation exceeded the model context window.',
  sessionBudgetExceeded: 'The session budget was exhausted.',
  usageLimitExceeded: 'Your Codex usage limit is exhausted.',
  serverOverloaded: 'The Codex API is overloaded.',
  cyberPolicy: 'The request was declined by the cyber-activity policy.',
  internalServerError: 'The Codex API returned an internal server error.',
  unauthorized: 'Codex is not authenticated — run `codex login`.',
  badRequest: 'The Codex API rejected the request as malformed.',
  threadRollbackFailed: 'The thread could not be rolled back.',
  sandboxError: 'The sandbox failed to run the command.',
  other: 'Codex reported an unspecified error.',
};

/**
 * The sentence and the code for a `CodexErrorInfo`, in either of its two shapes.
 *
 * Returns null for a null/absent info so the caller falls back to
 * `TurnError.message`, which is the only thing that was ever read before.
 */
function describeErrorInfo(info: CodexErrorInfo | null | undefined): {
  text: string;
  code: string;
} | null {
  if (!info) return null;
  if (typeof info === 'string') {
    return { text: CODEX_ERROR_TEXT[info] ?? `Codex error: ${info}.`, code: info };
  }
  // The object variants are single-key wrappers: `{ httpConnectionFailed: { httpStatusCode } }`.
  const [code, payload] = Object.entries(info)[0] ?? [];
  if (!code) return null;
  const status = (payload as { httpStatusCode?: number | null } | undefined)?.httpStatusCode;
  const suffix = typeof status === 'number' ? ` (HTTP ${status})` : '';
  const readable: Record<string, string> = {
    httpConnectionFailed: 'The connection to the Codex API failed',
    responseStreamConnectionFailed: 'The response stream could not be opened',
    responseStreamDisconnected: 'The response stream disconnected',
    responseTooManyFailedAttempts: 'The request failed too many times',
    activeTurnNotSteerable: 'The active turn cannot be steered',
  };
  return { text: `${readable[code] ?? `Codex error: ${code}`}${suffix}.`, code };
}

/**
 * What a Codex turn failure should say, from every field that carries meaning.
 *
 * `codexErrorInfo` first, because it is the typed one and its sentence is
 * written for a human; `message` is the app-server's own prose and rides along
 * when it adds something the sentence does not; `additionalDetails` last. The
 * previous behaviour was `message` alone, falling back to the literal string
 * `'Turn failed'`.
 */
export function describeTurnError(
  err: TurnError | null | undefined,
  fallback: string,
): { text: string; code: string } {
  const info = describeErrorInfo(err?.codexErrorInfo);
  const parts: string[] = [];
  if (info) parts.push(info.text);
  // Don't say the same thing twice: the app-server frequently sets `message` to
  // a lowercase restatement of the code it already put in `codexErrorInfo`.
  if (err?.message && (!info || !info.text.toLowerCase().includes(err.message.toLowerCase()))) {
    parts.push(err.message);
  }
  if (err?.additionalDetails) parts.push(err.additionalDetails);
  return {
    text: parts.length ? parts.join(' ') : fallback,
    code: info?.code ?? 'turn_failed',
  };
}

/**
 * Every method {@link notificationNotice} knows about, quiet states included.
 *
 * The mapper needs this because a null from `notificationNotice` does **not**
 * mean "unknown": most of these are level signals whose quiet states say
 * nothing (`status: 'ready'`, a rate-limit gauge below its limit). Without the
 * set, a handled method's ordinary silence fell through to the mapper's
 * `console.debug('Unknown notification')` and read as unhandled.
 */
export const NOTICE_METHODS: ReadonlySet<string> = new Set([
  'warning',
  'guardianWarning',
  'configWarning',
  'deprecationNotice',
  'model/rerouted',
  'model/safetyBuffering/updated',
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
  'windows/worldWritableWarning',
]);

/**
 * The notice a non-item notification carries, or null when it is not about
 * trouble.
 *
 * Keyed by method rather than by a generated discriminated union so an
 * app-server newer than `providers/codex/generated/` degrades to "unhandled"
 * rather than to a crash — the same reasoning as the Claude side, and the reason
 * every field read below is optional. Anything answered here must also appear in
 * {@link NOTICE_METHODS}.
 *
 * Deliberately absent: `thread/compacted` (marked deprecated in the protocol in
 * favour of the `ContextCompaction` item type), `model/verification` and
 * `item/autoApprovalReview/*` (policy bookkeeping with no user-visible
 * consequence).
 */
export function notificationNotice(method: string, params: unknown): ProviderNotice | null {
  const p = (params ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

  switch (method) {
    // The app-server's own general-purpose warning channel.
    case 'warning': {
      const message = str(p.message);
      return message ? { level: 'warning', code: 'warning', text: message } : null;
    }

    case 'guardianWarning': {
      const message = str(p.message);
      return message ? { level: 'warning', code: 'guardian_warning', text: message } : null;
    }

    case 'configWarning': {
      const summary = str(p.summary);
      if (!summary) return null;
      const where = str(p.path) ? ` (${str(p.path)})` : '';
      const details = str(p.details) ? ` ${str(p.details)}` : '';
      return {
        level: 'warning',
        code: 'config_warning',
        text: `Codex config${where}: ${summary}${details}`,
      };
    }

    case 'deprecationNotice': {
      const summary = str(p.summary);
      if (!summary) return null;
      return {
        level: 'info',
        code: 'deprecation_notice',
        text: `${summary}${str(p.details) ? ` ${str(p.details)}` : ''}`,
      };
    }

    // Codex's counterpart to Claude's `model_refusal_fallback`: the turn was
    // silently moved to a different model, which changes the answer's character.
    case 'model/rerouted': {
      const from = str(p.fromModel) ?? 'the model';
      const to = str(p.toModel) ?? 'another model';
      const reason = str(p.reason) ? ` (${str(p.reason)})` : '';
      return {
        level: 'info',
        code: 'model_rerouted',
        text: `Codex rerouted this turn from ${from} to ${to}${reason}.`,
      };
    }

    // Emitted when a response is being buffered for safety review — the single
    // best explanation Codex offers for a turn that has gone quiet.
    case 'model/safetyBuffering/updated': {
      if (p.showBufferingUi !== true) return null;
      return {
        level: 'info',
        code: 'safety_buffering',
        text: 'Codex is buffering the response for safety review; output will arrive in a batch.',
      };
    }

    // A *rolling* snapshot that can ride many turns, so only the states that
    // actually blocked something are forwarded — see `rateLimitsNotice`.
    case 'account/rateLimits/updated':
      return rateLimitsNotice(p.rateLimits);

    // One of YAAR's own MCP servers failed to come up, which is why some verb is
    // about to be missing. `starting`/`ready`/`cancelled` say nothing.
    case 'mcpServer/startupStatus/updated': {
      if (p.status !== 'failed') return null;
      const name = str(p.name) ?? 'an MCP server';
      const reason = str(p.failureReason);
      const detail = str(p.error) ?? (reason ? reason : undefined);
      return {
        level: 'warning',
        code: 'mcp_server_failed',
        text: `MCP server ${name} failed to start${detail ? `: ${detail}` : '.'}`,
      };
    }

    case 'windows/worldWritableWarning': {
      const samples = Array.isArray(p.samplePaths) ? (p.samplePaths as unknown[]) : [];
      const extra = typeof p.extraCount === 'number' ? p.extraCount : 0;
      if (!samples.length && !extra) return null;
      const more = extra > 0 ? ` (+${extra} more)` : '';
      return {
        level: 'warning',
        code: 'world_writable',
        text: `World-writable paths on PATH weaken the sandbox: ${samples.slice(0, 3).join(', ')}${more}`,
      };
    }

    default:
      return null;
  }
}

/**
 * The notice a rate-limit snapshot carries — **only** when a limit was reached.
 *
 * `account/rateLimits/updated` is documented as a sparse rolling update: it
 * arrives with whatever the backend most recently reported, which on a busy
 * thread is often. `rateLimitReachedType` and `spendControlReached` are the two
 * fields that mean something *happened*; `usedPercent` alone is a gauge and
 * would be a per-request firehose, since this mapper holds no state to dedupe
 * against.
 */
function rateLimitsNotice(rateLimits: unknown): ProviderNotice | null {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const r = rateLimits as {
    rateLimitReachedType?: string | null;
    spendControlReached?: boolean | null;
    primary?: { usedPercent?: number; resetsAt?: number | null } | null;
    credits?: { hasCredits?: boolean; unlimited?: boolean } | null;
  };
  const reached = r.rateLimitReachedType;
  const spend = r.spendControlReached === true;
  if (!reached && !spend) return null;

  const what = reached ? reached.replace(/_/g, ' ') : 'the configured spend control was reached';
  const resets = r.primary?.resetsAt
    ? ` Resets at ${new Date(r.primary.resetsAt * 1000).toISOString()}.`
    : '';
  const credits =
    r.credits && r.credits.unlimited !== true && r.credits.hasCredits === false
      ? ' No credits remaining.'
      : '';
  return {
    level: 'warning',
    code: reached ?? 'spend_control_reached',
    text: `Codex usage limit: ${what}.${credits}${resets}`,
  };
}
