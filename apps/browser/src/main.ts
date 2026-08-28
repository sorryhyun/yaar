/**
 * Entrypoint: wire the pieces together, register the app, honour `?url=`.
 *
 * Everything with substance lives next door — store.ts (display state), sse.ts and
 * actions.ts (the still-screenshot path), live.ts (the screencast path), session.ts
 * (which browser we are driving), protocol.ts (the agent contract), view.ts (markup).
 */
import { onCleanup } from '@bundled/solid-js';
import { defineApp } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { initialBrowserId, parsedInitialUrl, initialLive } from './store';
import { connectSSE, disconnectSSE } from './sse';
import { disconnectLive } from './live';
import { browserOpts, setLive } from './session';
import {
  browserState,
  navigationCommands,
  interactionCommands,
  inspectionCommands,
  adBlockCommands,
  uiCommands,
} from './protocol';
import { initAdBlock, stopStatsPolling } from './adblock';
import { App } from './view';
import './styles.css';

connectSSE(initialBrowserId);
void initAdBlock();
onCleanup(() => {
  disconnectSSE();
  disconnectLive();
  stopStatsPolling();
});

export default defineApp({
  id: 'browser',
  name: 'Browser',
  state: { ...browserState },
  commands: {
    ...navigationCommands,
    ...interactionCommands,
    ...inspectionCommands,
    ...adBlockCommands,
    ...uiCommands,
  },
  view: App,
});

/**
 * `?live=1` is a launch parameter too: the window opens already streaming, instead of
 * the user having to find the ◉ Live toggle. Set by `web.open({ visible: true, live: true })`
 * for the flows only a human can finish — a login form, an OTP, a captcha.
 *
 * After `defineApp`, because `setLive` needs the view mounted: it focuses the IME anchor,
 * which the toolbar only renders once `liveMode()` is true.
 */
if (initialLive) {
  void setLive(true).catch((err: unknown) => {
    console.error('[browser] initial live mode failed:', err);
  });
}

/**
 * `?url=` is a launch parameter, and it used to fill the URL bar and stop there — the
 * address was displayed but never fetched, so the window opened on a blank page that
 * claimed to be somewhere. It is now what the app opens on, which is what the desktop
 * relies on when it hands this app a link that refuses to be framed (`open-url.ts`).
 */
if (parsedInitialUrl !== 'about:blank') {
  void (async () => {
    try {
      await web.open(parsedInitialUrl, { ...(await browserOpts()), visible: false });
    } catch (err) {
      console.error('[browser] initial navigation failed:', err);
    }
  })();
}
