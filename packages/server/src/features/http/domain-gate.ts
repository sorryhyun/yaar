/**
 * The one place a blocked domain becomes a question instead of a refusal.
 *
 * Every route that fetches a user-named URL has to consult the allowlist. Two of them
 * used to consult it and stop there: `/api/ml-weights` and `/api/ml-weights/download`
 * answered a miss with a bare 403, so on a fresh install — where `config/` doesn't
 * exist yet and the allowlist seeds empty — downloading a model from huggingface.co
 * failed with no dialog ever reaching the desktop. Asking lives here now, and every
 * caller shares it.
 *
 * Asking is also *batched per session*. Each request used to ask on its own, so an app
 * opening with a burst of fetches — the marketplace reads several endpoints on one host
 * and a status page on another — stacked one dialog per request: the same domain asked
 * three times, a second domain on top. Now a session has at most one domain dialog on
 * screen. A request for a domain already being asked about waits on that answer, and
 * any other unknown domain joins the next dialog, which collects for a moment and opens
 * once the current one is answered.
 */

import { extractDomain, isDomainAllowed, addAllowedDomain } from '../config/domains.js';
import { checkPermission } from '../../storage/permissions.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionHub } from '../../session/session-hub.js';

/** Why a domain stayed blocked — callers map this to their own error shape. */
export type DomainDenial =
  | { reason: 'denied'; domain: string; message: string }
  | { reason: 'no-session'; domain: string; message: string };

export interface DomainGateOptions {
  /** Caller-supplied session; validated against the hub, falling back to the default. */
  sessionId?: string;
  /** Shown in the dialog body. Defaults to a generic HTTP-request phrasing. */
  purpose?: string;
  /** Dialogs for multi-GB weight downloads need longer than a 60s default. */
  timeoutMs?: number;
}

const TOOL_NAME = 'http_domain';

/**
 * How long a new dialog waits for more domains before opening. A burst of fetches from
 * one app lands within a few milliseconds; this is long enough to catch it and short
 * enough that nobody waits on it.
 */
export const DOMAIN_BATCH_GATHER_MS = 100;

/** One dialog's worth of domains, and the answer they all share. */
interface DomainBatch {
  /** Domain → the purpose its first asker gave (undefined: the generic phrasing). */
  domains: Map<string, string | undefined>;
  timeoutMs?: number;
  answer: Promise<boolean>;
}

/** Per session: the dialog on screen, and the one gathering behind it. */
const asking = new Map<string, DomainBatch>();
const gathering = new Map<string, DomainBatch>();

/**
 * Ensure `url`'s domain is allowed, prompting the user if it isn't.
 *
 * Returns `null` when the domain is allowed (already, or because the user just
 * approved it — in which case it has been persisted). Returns a `DomainDenial` when
 * the request must not proceed.
 */
export async function ensureDomainAllowed(
  url: string,
  options?: DomainGateOptions,
): Promise<DomainDenial | null> {
  const domain = extractDomain(url);
  if (await isDomainAllowed(domain)) return null;

  // The caller may pass a stale/restored sessionId that no longer names a LiveSession,
  // so validate it against the hub before trusting it, then fall back to the default.
  const hub = getSessionHub();
  const sessionId =
    (options?.sessionId && hub.get(options.sessionId) ? options.sessionId : undefined) ??
    hub.getDefault()?.sessionId;

  if (!sessionId) {
    return {
      reason: 'no-session',
      domain,
      message: `Domain "${domain}" is not in the allowed list. Add it to curl_allowed_domains.yaml.`,
    };
  }

  const confirmed = await askForDomain(sessionId, domain, options);
  if (!confirmed) {
    return { reason: 'denied', domain, message: `User denied access to domain "${domain}".` };
  }
  return null;
}

/** Resolve `domain` through a saved decision, or the session's shared dialog. */
async function askForDomain(
  sessionId: string,
  domain: string,
  options?: DomainGateOptions,
): Promise<boolean> {
  // A saved per-domain decision answers without a dialog — checked here, per domain,
  // because a batched dialog has no single context for the emitter to look up.
  const saved = await checkPermission(TOOL_NAME, domain);
  if (saved === 'deny') return false;
  if (saved === 'allow') {
    await addAllowedDomain(domain);
    return true;
  }

  const current = asking.get(sessionId);
  if (current?.domains.has(domain)) return current.answer;

  let next = gathering.get(sessionId);
  if (!next) {
    next = openBatch(sessionId);
    gathering.set(sessionId, next);
  }
  if (!next.domains.has(domain)) next.domains.set(domain, options?.purpose);
  if (options?.timeoutMs !== undefined) {
    next.timeoutMs = Math.max(next.timeoutMs ?? 0, options.timeoutMs);
  }
  return next.answer;
}

function openBatch(sessionId: string): DomainBatch {
  const batch: DomainBatch = { domains: new Map(), answer: Promise.resolve(false) };
  batch.answer = (async () => {
    await new Promise((r) => setTimeout(r, DOMAIN_BATCH_GATHER_MS));
    // One dialog at a time: wait out the one on screen, still accepting domains.
    while (asking.has(sessionId)) await asking.get(sessionId)!.answer.catch(() => {});
    gathering.delete(sessionId);
    asking.set(sessionId, batch);
    try {
      return await showBatch(sessionId, batch);
    } finally {
      asking.delete(sessionId);
    }
  })();
  return batch;
}

async function showBatch(sessionId: string, batch: DomainBatch): Promise<boolean> {
  // The previous dialog (or a hand edit) may have allowed some of these while they waited.
  for (const domain of [...batch.domains.keys()]) {
    if (await isDomainAllowed(domain)) batch.domains.delete(domain);
  }
  const domains = [...batch.domains.keys()];
  if (domains.length === 0) return true;

  const single = domains.length === 1;
  const confirmed = await actionEmitter.showPermissionDialogToSession(sessionId, {
    title: 'Allow Domain Access',
    message: batchMessage(batch.domains),
    toolName: TOOL_NAME,
    ...(single ? { context: domains[0] } : { contexts: domains }),
    timeoutMs: batch.timeoutMs,
  });
  if (!confirmed) return false;

  for (const domain of domains) await addAllowedDomain(domain);
  return true;
}

function batchMessage(domains: Map<string, string | undefined>): string {
  const entries = [...domains];
  if (entries.length === 1) {
    const [domain, purpose] = entries[0]!;
    return `${purpose ?? `An app wants to make HTTP requests to "${domain}".`}\n\nDo you want to allow this domain?`;
  }
  const plain = entries.filter(([, p]) => p === undefined).map(([d]) => `• ${d}`);
  const described = entries.filter(([, p]) => p !== undefined).map(([, p]) => `• ${p}`);
  const parts = [];
  if (plain.length) parts.push(`An app wants to make HTTP requests to:\n${plain.join('\n')}`);
  if (described.length) parts.push(described.join('\n'));
  return `${parts.join('\n\n')}\n\nDo you want to allow these ${entries.length} domains?`;
}
