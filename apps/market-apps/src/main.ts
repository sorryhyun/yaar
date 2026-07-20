// ── Entry point ─────────────────────────────────────────────────────────
//
// Wires the pieces together: mounts the reactive UI (components.ts) and runs
// startup (resolve domain, load publisher status + marketplace data). All state
// lives in store.ts, business logic in actions.ts, I/O in api.ts, and App
// Protocol wiring in protocol.ts.

import { onMount } from '@bundled/solid-js';
import { render } from '@bundled/solid-js/web';
import { storage } from '@bundled/yaar';
import './styles.css';
import './protocol.js';
import { App } from './components.js';
import { DEFAULT_MARKET_DOMAIN, STORAGE_DOMAIN_KEY } from './constants.js';
import { normalizeDomain } from './parsers.js';
import { refreshAccount, refreshData, startGithubStatusPolling } from './actions.js';
import { setApiBase, setStatus } from './store.js';

// ── Mount reactive UI ────────────────────────────────────────────────

render(() => App(), document.getElementById('app')!);

// ── Ambient GitHub health ───────────────────────────────────────────
//
// Feeds the publish banner. Started here rather than inside `onMount` below
// because that callback is async: after its first `await`, Solid's owner is gone
// and an `onCleanup` registered there would never fire. Independent of both the
// marketplace domain and sign-in — an outage is worth flagging before the user
// gets that far. `pagehide` covers the window being closed; the interval dies
// with the iframe either way, so this is belt-and-braces.
const stopGithubStatusPolling = startGithubStatusPolling();
window.addEventListener('pagehide', stopGithubStatusPolling);

// ── Async initialization ────────────────────────────────────────────

onMount(async () => {
  let domain = normalizeDomain(
    new URLSearchParams(window.location.search).get('domain') ||
      ((window as any).__MARKET_APPS_DOMAIN__ as string | undefined) ||
      '',
  );

  if (!domain) {
    try {
      const saved = await storage.read(STORAGE_DOMAIN_KEY);
      if (typeof saved === 'string' && saved.trim()) domain = normalizeDomain(saved.trim());
    } catch {
      // no saved domain
    }
  }

  if (!domain) domain = DEFAULT_MARKET_DOMAIN;
  setApiBase(domain);

  // Publisher sign-in is independent of the marketplace domain — load it either way.
  void refreshAccount();

  if (domain) {
    void refreshData();
  } else {
    setStatus('No domain configured. Set domain via App Protocol setDomain command.', true);
  }
});
