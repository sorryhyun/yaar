/**
 * Phase 3 consent + self-target guards for browser automation.
 *
 * Two protections layered in front of `POST /api/browser`, both centred on the
 * substrate-collapse insight: once the
 * user's browser is the substrate, YAAR's own tab is *one more addressed target*,
 * not a thing to wall off — so self-reference is allowed but never silent.
 *
 *  1. **Self-target guard** — refuse raw-DOM *mutations* against YAAR's own tab.
 *     Reading YAAR's tab (screenshot / extract / introspection) is fine; changing
 *     it must go through OS Actions / the `yaar://` protocol so state stays
 *     coherent. Applies to every provider (headless tabs never show YAAR's
 *     origin, so it's a no-op there). **Exception:** the session-agent door
 *     (`yaar://session/browser`) passes `allowSelfTarget` — as the user's deputy
 *     it may drive YAAR's own tab, the same way the user can.
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
import { savePermission, checkPermission } from '../../storage/permissions.js';
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

/**
 * Tab actions (over the YAAR Bridge) that change tab/group/page state and therefore need the same
 * per-origin consent as raw-DOM mutation. Covers the T2 window-manager verbs (`close/group/move`)
 * and the T3 page-drive verbs (`click/type/scroll/navigate`). `focus` is deliberately excluded — it
 * only brings a tab forward, exactly what the user does by clicking a tab, and exposes nothing.
 * `track` (a cosmetic observation cue) is likewise not a mutation, and `extract`/`screenshot` are
 * reads gated by the separate content-read guard.
 */
const MUTATING_TAB_ACTIONS = new Set([
  'close',
  'group',
  'move',
  'click',
  'type',
  'scroll',
  'navigate',
]);

export function isMutatingTabAction(action: string): boolean {
  return MUTATING_TAB_ACTIONS.has(action);
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
  /**
   * Allow raw-DOM mutation of YAAR's own tab. Only the session agent's door
   * (`yaar://session/browser`, session-principal gated) sets this — as the
   * user's deputy it may drive YAAR's own tab the way the user would. The
   * `/api/browser` path (frontend / bundled tools / headless sandbox) leaves
   * this unset, so self-target mutation stays refused there.
   */
  allowSelfTarget?: boolean;
}): Promise<GuardResult> {
  const { provider, action, session, sessionId, allowSelfTarget } = opts;

  // No session yet (e.g. create/open of a fresh tab) → nothing to guard here.
  if (!session) return OK;
  if (!isMutatingAction(action)) return OK;

  // 1. Self-target: YAAR's own tab.
  if (isYaarOriginUrl(session.currentUrl)) {
    // The session agent (user's deputy) may drive YAAR's own tab. It's our own
    // origin, not a third-party login, so no tab-control consent is needed —
    // allow it outright before the consent guard below would prompt.
    if (allowSelfTarget) return OK;
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
 * The T2 (Manage) twin of `enforceBrowserGuards`, for the YAAR Bridge tab surface
 * (the `focus`/`close`/`group`/`move` bridge actions on `POST /api/bridge`). The target is a real,
 * logged-in tab in the user's
 * everyday browser, so the same two protections apply — expressed over a `BridgeTab` (url + isSelf)
 * instead of a CDP `BrowserSession`:
 *
 *  1. **Self-target** — never `close`/`group`/`move` YAAR's own tab. YAAR's UI is the addressed
 *     meta-level; it's managed through OS Actions / windows, not by rearranging its browser tab.
 *     (There is no `allowSelfTarget` escape here: the tab surface is not the session-agent door.)
 *  2. **Per-origin consent** — the same allowlist + dialog that gates outbound navigation.
 *
 * `focus` and `track` are not mutations (see `MUTATING_TAB_ACTIONS`), so they sail through — a
 * bare `{ ok: true }`, no dialog.
 */
export async function enforceTabControlGuard(opts: {
  tab: { url: string; isSelf?: boolean };
  action: string;
  sessionId: string | undefined;
}): Promise<GuardResult> {
  const { tab, action, sessionId } = opts;
  if (!isMutatingTabAction(action)) return OK;

  if (tab.isSelf || isYaarOriginUrl(tab.url)) {
    return {
      ok: false,
      error:
        `Refusing to "${action}" YAAR's own tab. YAAR's UI is the addressed meta-level — ` +
        `manage it through OS Actions / windows (window.* actions, invoke('yaar://windows/...')), ` +
        `not by closing or moving its browser tab. Focusing it is allowed.`,
    };
  }

  return ensureTabControlConsentForUrl(tab.url, sessionId);
}

/**
 * Content-read guard (T3-lite), for the `extract` bridge action (`POST /api/bridge`).
 *
 * Reading a real, logged-in page's text is materially more sensitive than the T2 manage verbs —
 * it crosses the tab-metadata boundary that keeps T1/T2 safe — so it gets its OWN per-origin grant
 * (`browser_content_read`), distinct from tab-control's navigation allowlist. Granting tab control
 * on a domain does NOT grant content read there, and vice-versa.
 *
 * Reading YAAR's own tab is allowed (mirrors the self-target rule: reads of self are fine,
 * only mutations are refused); it carries no third-party login to protect.
 */
export async function enforceContentReadGuard(opts: {
  tab: { url: string; isSelf?: boolean };
  sessionId: string | undefined;
}): Promise<GuardResult> {
  const { tab, sessionId } = opts;
  // Reading our own origin exposes no third-party session — allow without a prompt.
  if (tab.isSelf || isYaarOriginUrl(tab.url)) return OK;
  return ensureContentReadConsent(tab.url, sessionId);
}

/**
 * Ensure the agent is allowed to read page content at this origin. A dedicated grant keyed under
 * the `browser_content_read` tool (persisted as `browser_content_read:{domain}`), separate from the
 * tab-control / navigation allowlist — so content read is its own explicit, revocable decision.
 */
async function ensureContentReadConsent(
  url: string | undefined,
  sessionId: string | undefined,
): Promise<GuardResult> {
  const domain = extractDomain(url ?? '');
  // Blank / about: pages carry no logged-in content — nothing to protect yet.
  if (!domain) return OK;

  if (!sessionId) {
    return {
      ok: false,
      error:
        `Reading page content on "${domain}" needs your consent, but there's no active session ` +
        `to ask. Open the tab's page in a YAAR session and retry.`,
    };
  }

  // `showPermissionDialogToSession` checks the saved `browser_content_read:{domain}` decision first
  // and, if the user picks "remember", persists it — so a granted domain won't prompt again.
  const confirmed = await actionEmitter.showPermissionDialogToSession(
    sessionId,
    'Allow Reading Page Content',
    `The agent wants to read the full text of your open tab on "${domain}".\n\n` +
      `This is a real, logged-in page — its content may include private information. ` +
      `Allow the agent to read the page content on "${domain}"?`,
    'browser_content_read',
    domain,
  );
  if (!confirmed) {
    return { ok: false, error: `User denied reading page content on "${domain}".` };
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
  return ensureTabControlConsentForUrl(session.currentUrl, sessionId);
}

/**
 * Origin-based twin of `ensureTabControlConsent` — used by the Bridge T2 path, where the target
 * is a `BridgeTab` (a URL + id), not a CDP `BrowserSession`. Same allowlist + dialog.
 */
async function ensureTabControlConsentForUrl(
  url: string | undefined,
  sessionId: string | undefined,
): Promise<GuardResult> {
  if (await isAllDomainsAllowed()) return OK;

  const domain = extractDomain(url ?? '');
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

/**
 * Proactively grant the agent full *use* of a tab's origin — the "Allow use" button in the
 * Real Browser app. Where {@link enforceTabControlGuard} / {@link enforceContentReadGuard} prompt
 * lazily on first action, this grants both up-front so the agent can view, scroll, click, and read
 * that origin without any further dialogs:
 *   1. tab-control (the `http_domain` allowlist that gates click/type/scroll/navigate), and
 *   2. content-read (the `browser_content_read:{domain}` grant that gates reading page text).
 *
 * It's a *user*-initiated consent act (the iframe calls `/api/bridge`), never something the agent
 * can trigger for itself. Refuses on origin-less pages (about:blank etc.), which carry nothing to grant.
 */
export async function grantTabUse(
  url: string | undefined,
): Promise<{ ok: true; domain: string } | { ok: false; error: string }> {
  const domain = extractDomain(url ?? '');
  if (!domain) {
    return { ok: false, error: 'This tab has no addressable origin (e.g. a blank/internal page).' };
  }
  await addAllowedDomain(domain);
  await savePermission('browser_content_read', 'allow', domain);
  return { ok: true, domain };
}

/**
 * Whether a tab's origin is already fully granted for agent use — i.e. both the tab-control
 * allowlist and the content-read grant are in place. Lets the UI show a tab as "in use" and hide
 * its "Allow use" button. Origin-less pages are never "in use".
 */
export async function isTabUseAllowed(url: string | undefined): Promise<boolean> {
  const domain = extractDomain(url ?? '');
  if (!domain) return false;
  const controlled = await isDomainAllowed(domain); // also true when allow_all_domains is set
  const readable = (await checkPermission('browser_content_read', domain)) === 'allow';
  return controlled && readable;
}
