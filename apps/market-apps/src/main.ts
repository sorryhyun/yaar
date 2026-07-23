// ── Entry point ─────────────────────────────────────────────────────────
//
// Wires the pieces together: mounts the reactive UI (components.ts) and runs
// startup (load publisher status + marketplace data). All state lives in
// store.ts, business logic in actions.ts, I/O in api.ts, and App Protocol
// wiring in protocol.ts.

import { onMount } from '@bundled/solid-js';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import './protocol.js';
import { App } from './components.js';
import { refreshAccount, refreshData, startGithubStatusPolling } from './actions.js';

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
  // Publisher sign-in and the catalog are independent — neither waits for the other.
  void refreshAccount();
  void refreshData();
});
