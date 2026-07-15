/**
 * Session-agent browser door — the user's-deputy path to the *real* browser.
 *
 * `yaar://session/browser` is the one door that reaches `LocalUserBrowser` (the
 * user's own Chrome, with their cookies and logins). Access control is enforced
 * upstream in `ResourceRegistry.execute()` — this resource is marked
 * `access: 'session-principal'`, so only the session agent ever gets here.
 *
 * This module just picks the right provider instance and runs the *same* action
 * layer used by `/api/browser`, with the Phase-3 consent + driving guards
 * applied.
 */

import type { VerbResult } from '../../handlers/uri-registry.js';
import { error } from '../../handlers/utils.js';
import {
  getLocalBrowser,
  getHeadlessBrowser,
  isForceHeadless,
  type BrowserProvider,
} from '../../lib/browser/index.js';
import { runGuardedBrowserAction, handleListTabs } from '../browser/actions.js';
import { getSessionId } from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';

/**
 * Resolve the provider behind the session door.
 *
 * Normally the user's real Chrome (`LocalUserBrowser`), auto-attached whenever a
 * debuggable Chrome is reachable. Two refusals, both deliberate:
 *  - **force-headless opt-out** (`YAAR_BROWSER_PROVIDER=headless`): the user never
 *    wants the agent near their real browser → use the headless sandbox.
 *  - **no local Chrome reachable** (cloud / REMOTE / no debug port): return a
 *    clear error, never a silent downgrade to headless — a silent sandbox would
 *    lie about identity (design §5, "No silent fallback").
 */
async function resolveSessionProvider(): Promise<
  { ok: true; provider: BrowserProvider } | { ok: false; error: string }
> {
  if (isForceHeadless()) {
    return { ok: true, provider: getHeadlessBrowser() };
  }
  const local = getLocalBrowser();
  if (!(await local.isAvailable())) {
    return {
      ok: false,
      error:
        'No local browser available. The session agent drives your real Chrome, ' +
        'which must be launched with --remote-debugging-port (or set CHROME_DEBUG_PORT). ' +
        'This path is unavailable in cloud / REMOTE runs — there is no silent fallback to ' +
        'the headless sandbox, since that would act under the wrong identity.',
    };
  }
  return { ok: true, provider: local };
}

function resolveSessionId(): string | undefined {
  return getSessionId() ?? getSessionHub().getDefault()?.sessionId;
}

/**
 * `read('yaar://session/browser')` → list the open tabs in the user's browser.
 */
export async function sessionBrowserRead(): Promise<VerbResult> {
  const resolved = await resolveSessionProvider();
  if (!resolved.ok) return error(resolved.error);
  // Pull in tabs the user already had open (incl. YAAR's own tab) before
  // listing — otherwise the list only shows tabs YAAR itself opened.
  await resolved.provider.syncExistingTabs();
  return handleListTabs(resolved.provider);
}

/**
 * `invoke('yaar://session/browser', { action, ... })` → drive the user's browser.
 *
 * The payload mirrors the `POST /api/browser` body: `{ action, browserId?, ... }`.
 */
export async function sessionBrowserInvoke(payload?: Record<string, unknown>): Promise<VerbResult> {
  const action = payload?.action as string | undefined;
  if (!action) {
    return error(
      'Payload must include "action" (e.g. open, click, type, extract, screenshot, list_tabs).',
    );
  }

  const resolved = await resolveSessionProvider();
  if (!resolved.ok) return error(resolved.error);

  // `list_tabs` should reflect the user's real tabs, not just YAAR-opened ones.
  if (action === 'list_tabs') await resolved.provider.syncExistingTabs();

  // The session agent is the user's deputy: allow it to drive YAAR's own tab
  // (self-target), unlike the `/api/browser` path. Access to this door is
  // already session-principal gated, so only the session agent reaches here.
  return runGuardedBrowserAction(
    resolved.provider,
    action,
    payload ?? {},
    resolveSessionId(),
    /* allowSelfTarget */ true,
  );
}
