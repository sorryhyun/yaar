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
import { initialBrowserId, parsedInitialUrl } from './store';
import { connectSSE, disconnectSSE } from './sse';
import { disconnectLive } from './live';
import { browserOpts } from './session';
import {
  browserState,
  navigationCommands,
  interactionCommands,
  inspectionCommands,
  uiCommands,
} from './protocol';
import { App } from './view';
import './styles.css';

connectSSE(initialBrowserId);
onCleanup(() => {
  disconnectSSE();
  disconnectLive();
});

export default defineApp({
  id: 'browser',
  name: 'Browser',
  state: { ...browserState },
  commands: {
    ...navigationCommands,
    ...interactionCommands,
    ...inspectionCommands,
    ...uiCommands,
  },
  view: App,
});

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
