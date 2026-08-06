/**
 * The one place a blocked domain becomes a question instead of a refusal.
 *
 * Every route that fetches a user-named URL has to consult the allowlist. Two of them
 * used to consult it and stop there: `/api/ml-weights` and `/api/ml-weights/download`
 * answered a miss with a bare 403, so on a fresh install — where `config/` doesn't
 * exist yet and the allowlist seeds empty — downloading a model from huggingface.co
 * failed with no dialog ever reaching the desktop. Asking lives here now, and every
 * caller shares it.
 */

import { extractDomain, isDomainAllowed, addAllowedDomain } from '../config/domains.js';
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

  const purpose = options?.purpose ?? `An app wants to make HTTP requests to "${domain}".`;
  const confirmed = await actionEmitter.showPermissionDialogToSession(sessionId, {
    title: 'Allow Domain Access',
    message: `${purpose}\n\nDo you want to allow this domain?`,
    toolName: 'http_domain',
    context: domain,
    timeoutMs: options?.timeoutMs,
  });

  if (!confirmed) {
    return { reason: 'denied', domain, message: `User denied access to domain "${domain}".` };
  }

  await addAllowedDomain(domain);
  return null;
}
