/**
 * The app-origin marks a `window.create` for an app carries: whether its iframe moves to
 * the isolated app origin, and — in `proxy-port` mode — which origin that is.
 *
 * The one statement of the rule. Every path that produces an app window asks here: an
 * agent's create (`create.ts`), a replay (`logging/window-restore.ts`), and the desktop
 * opening an app on its own, which gets the marks back from the `/api/iframe-token` mint.
 * That last path once built its own `window.create` without them, so every installed app
 * opened from its desktop icon ran same-origin with the desktop.
 *
 * Only installed (`source:'user'`) apps move to the app origin — bundled apps and
 * AI-authored HTML are host-authored, not the hostile-app threat, and stay same-origin.
 */

import { isolatedAppOrigin, isOriginBoundaryActive } from '../../http/origin-boundary.js';
import { resolveAppSource } from '../apps/roots.js';

export interface AppOriginMarks {
  isolateOrigin?: true;
  appOrigin?: string;
}

/** The marks for an iframe window of `appId`; empty when it stays on the desktop origin. */
export function appOriginMarks(appId: string | undefined | null): AppOriginMarks {
  if (!appId || !isOriginBoundaryActive() || resolveAppSource(appId) !== 'user') return {};
  // Locally the frontend derives the app origin itself (only the browser knows which
  // port served the document — a dev proxy is not the API port). Over a `proxy-port`
  // boundary the origin is a published address the server chose, so state it: the
  // client has no way to compute `https://<magic-dns>:8443` from where it is standing.
  const appOrigin = isolatedAppOrigin();
  return { isolateOrigin: true, ...(appOrigin ? { appOrigin } : {}) };
}
