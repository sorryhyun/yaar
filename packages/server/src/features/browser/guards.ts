/**
 * Phase 3 consent + self-target guards for browser automation.
 *
 * Two protections layered in front of `POST /api/browser`, both centred on the
 * substrate-collapse insight from docs/browser_substrate_proposal.md: once the
 * user's browser is the substrate, YAAR's own tab is *one more addressed target*,
 * not a thing to wall off — so self-reference is allowed but never silent.
 *
 *  1. **Self-target guard** — refuse raw-DOM *mutations* against YAAR's own tab.
 *     Reading YAAR's tab (screenshot / extract / introspection) is fine; changing
 *     it must go through OS Actions / the `yaar://` protocol so state stays
 *     coherent. Applies to every provider (headless tabs never show YAAR's
 *     origin, so it's a no-op there).
 *
 *  2. **Tab-control consent** — when the provider drives the *user's own* browser
 *     (`controlsUserBrowser`), mutating a real logged-in tab requires a per-origin
 *     grant, reusing the same `curl_allowed_domains.yaml` allowlist + permission
 *     dialog that already gates outbound navigation. A sandboxed headless tab
 *     needs no such grant.
 */

import type { BrowserProvider } from '../../lib/browser/index.js';
import type { BrowserSession } from '../../lib/browser/index.js';
import { getPort } from '../../config.js';
import {
  isDomainAllowed,
  extractDomain,
  addAllowedDomain,
  isAllDomainsAllowed,
} from '../config/domains.js';
import { actionEmitter } from '../../session/action-emitter.js';

/**
 * Actions that change page/tab/browser state via raw CDP. Everything not listed
 * (screenshot, extract, extract_images, html, get_cookies, list_tabs, wait_for,
 * annotate, remove_annotations, create, screenshot) is treated as read-only.
 *
 * `evaluate` is mutating: arbitrary JS can change the DOM, storage, or navigate.
 */
const MUTATING_ACTIONS = new Set([
  'open',
  'navigate',
  'click',
  'type',
  'press',
  'scroll',
  'hover',
  'evaluate',
  'set_cookie',
  'delete_cookies',
  'close_tab',
]);

export function isMutatingAction(action: string): boolean {
  return MUTATING_ACTIONS.has(action);
}

/** Whether a URL points at YAAR's own origin (any localhost/loopback host + our port). */
export function isYaarOriginUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const isLoopbackHost =
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '0.0.0.0' ||
      u.hostname === '[::1]';
    return isLoopbackHost && port === String(getPort());
  } catch {
    return false;
  }
}

export type GuardResult = { ok: true } | { ok: false; error: string };

const OK: GuardResult = { ok: true };

/**
 * Apply the self-target and tab-control consent guards for one browser action.
 *
 * Called from the `POST /api/browser` dispatch *before* the action runs. Returns
 * `{ ok: false, error }` (→ HTTP 403) when the action must be blocked.
 *
 * Creation/navigation of a *new* tab is left to the existing per-domain
 * navigation check in `actions.ts`; this guard only fires once a session exists.
 */
export async function enforceBrowserGuards(opts: {
  provider: BrowserProvider;
  action: string;
  session: BrowserSession | undefined;
  sessionId: string | undefined;
}): Promise<GuardResult> {
  const { provider, action, session, sessionId } = opts;

  // No session yet (e.g. create/open of a fresh tab) → nothing to guard here.
  if (!session) return OK;
  if (!isMutatingAction(action)) return OK;

  // 1. Self-target: refuse raw-DOM mutation of YAAR's own tab.
  if (isYaarOriginUrl(session.currentUrl)) {
    return {
      ok: false,
      error:
        `Refusing to "${action}" YAAR's own tab via raw browser automation. ` +
        `YAAR's UI is the addressed meta-level — change it through OS Actions / the ` +
        `yaar:// protocol (e.g. window.* actions, invoke('yaar://windows/...')), ` +
        `not raw CDP. Reading this tab (screenshot/extract) is allowed.`,
    };
  }

  // 2. Tab-control consent: mutating the user's own logged-in tab needs a grant.
  if (provider.controlsUserBrowser) {
    const consent = await ensureTabControlConsent(session, sessionId);
    if (!consent.ok) return consent;
  }

  return OK;
}

/**
 * Ensure the agent is allowed to control the user's tab at its current origin.
 * Reuses the outbound-HTTP allowlist + permission dialog. Self-targets are
 * handled earlier and never reach here.
 */
async function ensureTabControlConsent(
  session: BrowserSession,
  sessionId: string | undefined,
): Promise<GuardResult> {
  if (await isAllDomainsAllowed()) return OK;

  const domain = extractDomain(session.currentUrl);
  // Blank / about: pages carry no logged-in state — nothing to protect yet.
  if (!domain) return OK;
  if (await isDomainAllowed(domain)) return OK;

  if (!sessionId) {
    return {
      ok: false,
      error:
        `Controlling your browser tab on "${domain}" is not allowed yet. ` +
        `Grant it with invoke('yaar://config/domains', { domain: "${domain}" }).`,
    };
  }

  const confirmed = await actionEmitter.showPermissionDialogToSession(
    sessionId,
    'Allow Tab Control',
    `The agent wants to control your open tab on "${domain}".\n\n` +
      `This is a real, logged-in tab in your browser. Allow the agent to ` +
      `click, type, and run scripts on "${domain}"?`,
    'http_domain',
    domain,
  );
  if (!confirmed) {
    return { ok: false, error: `User denied tab control for "${domain}".` };
  }
  await addAllowedDomain(domain);
  return OK;
}
