/**
 * System domain handlers for the verb layer — the running installation itself.
 *
 *   list('yaar://system')                              → available system resources
 *   read('yaar://system/update')                       → cached status + live install progress
 *   invoke('yaar://system/update', { action: 'check' })   → ask GitHub for the latest release
 *   invoke('yaar://system/update', { action: 'install' }) → download, verify, and swap it in
 *   list('yaar://system/browsers')                     → the sandbox browser's sessions
 *   read('yaar://system/browsers/{id}')                → one session
 *   invoke('yaar://system/browsers/{id}', { action })  → revive a suspended session
 *   delete('yaar://system/browsers/{id}')              → kill it
 *
 * `read` is deliberately network-free so a UI can poll it during an install; only
 * `check` goes out. See `features/update/updater.ts` for the reasoning behind that
 * split and behind `install` returning before the work finishes.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJson, okLinks, error } from './utils.js';
import {
  checkForUpdate,
  getUpdateStatus,
  refusalText,
  startInstall,
  UpdateRefused,
} from '../features/update/updater.js';
import { getHeadlessBrowser } from '../lib/browser/index.js';
import { actionEmitter } from '../session/action-emitter.js';
import { getSessionId } from '../agents/agent-context.js';

const BROWSERS_ROOT = 'yaar://system/browsers';

/** The `{id}` in `yaar://system/browsers/{id}`, or null for the collection itself. */
function browserIdFrom(resolved: ResolvedUri): string | null {
  const rest = resolved.sourceUri.slice(BROWSERS_ROOT.length).replace(/^\/+|\/+$/g, '');
  return rest ? decodeURIComponent(rest) : null;
}

export function registerSystemHandlers(registry: ResourceRegistry): void {
  // ── yaar://system — namespace root ──
  registry.register('yaar://system', {
    description:
      'The running YAAR installation — version, updates, the fonts it serves, and media download.',
    verbs: ['describe', 'list'],

    async list() {
      return okLinks([
        {
          uri: 'yaar://system/update',
          name: 'update',
          description: 'Running version, latest release, and self-update',
        },
        {
          uri: 'yaar://system/fonts',
          name: 'fonts',
          description: 'The webfonts YAAR serves, and subsets of them inlined as data: URLs',
        },
        {
          uri: BROWSERS_ROOT,
          name: 'browsers',
          description: 'Sandbox browser sessions — live, suspended, and crashed',
        },
        {
          uri: 'yaar://system/ytdlp',
          name: 'ytdlp',
          description: 'Audio download from YouTube via the optional yt-dlp binary',
        },
      ]);
    },
  });

  registerBrowserHandlers(registry);

  // ── yaar://system/update — version check + self-update ──
  registry.register('yaar://system/update', {
    description:
      'YAAR version and updates. Read for the running version plus the last check result and any install in progress (no network). Invoke with action "check" to ask GitHub for the latest release, or "install" to download it, verify it against the release SHA256SUMS, and swap it in. Only the standalone executable can install updates; a source checkout updates with git. Installing never restarts YAAR — the user must do that.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'install'],
          description:
            '"check" queries GitHub for the latest release; "install" downloads and applies it.',
        },
        force: {
          type: 'boolean',
          description: 'check only — bypass the 5-minute result cache.',
        },
      },
      required: ['action'],
    },

    async read(): Promise<VerbResult> {
      return okJson(getUpdateStatus());
    },

    async invoke(_resolved, payload): Promise<VerbResult> {
      const action = (payload as { action?: string } | undefined)?.action;
      const force = (payload as { force?: boolean } | undefined)?.force === true;

      if (action === 'check') {
        const status = await checkForUpdate(force);
        return okJson(status);
      }

      if (action === 'install') {
        try {
          return okJson(await startInstall());
        } catch (err) {
          if (err instanceof UpdateRefused) return error(err.message);
          throw err;
        }
      }

      if (action === 'status') {
        // Not in the schema, but a plausible guess — answer it rather than scolding.
        return okJson(getUpdateStatus());
      }

      return error('Provide action: "check" or "install".');
    },

    async describe() {
      // The generated describe would list the verbs but not say whether *this* build
      // can act on them, which is the first thing a caller needs to know.
      const status = getUpdateStatus();
      const capability = status.canInstall
        ? 'This build can install updates itself.'
        : refusalText(status);
      return ok(
        JSON.stringify(
          {
            uri: 'yaar://system/update',
            description: `Running ${status.current} (${status.bundled ? 'standalone executable' : 'source checkout'}) on ${status.platform}/${status.arch}. ${capability}`,
            verbs: ['describe', 'read', 'invoke'],
            invokeSchema: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['check', 'install'] },
                force: { type: 'boolean' },
              },
              required: ['action'],
            },
          },
          null,
          2,
        ),
      );
    },
  });
}

/**
 * The sandbox browser's sessions, as processes rather than as an implementation
 * detail of the `browser` app.
 *
 * Only the headless sandbox door (`getHeadlessBrowser`) is listed. The other door
 * — `LocalUserBrowser` — drives the *user's own* Chrome, where "kill this session"
 * would mean closing a tab they opened themselves; that browser is reached through
 * `yaar://session/browser` by the session agent and has no business appearing in a
 * kill list.
 */
function registerBrowserHandlers(registry: ResourceRegistry): void {
  registry.register(BROWSERS_ROOT, {
    description:
      'Sandbox browser sessions. Each entry is one tab of the server-side Chrome: its id ' +
      '(the `browserId` a window addresses it by), the page it is on, whether anyone is ' +
      'watching it, how idle it is, and roughly what it weighs. `state` is "live" when a ' +
      'CDP socket is behind it, "suspended" when only its record is (a reloaded desktop, ' +
      'an idle-swept tab, a restarted server — reviving it restores the page and its ' +
      'logins), or "crashed" when the tab died and could not be brought back.',
    verbs: ['describe', 'list', 'read'],

    async list(): Promise<VerbResult> {
      const provider = getHeadlessBrowser();
      const sessions = await provider.listSessionInfo();
      const stats = provider.getStats();
      return okJson({
        chromeRunning: stats.chromeRunning,
        maxSessions: stats.maxSessions,
        liveSessions: sessions.filter((s) => s.state === 'live').length,
        sessions,
      });
    },

    async read(): Promise<VerbResult> {
      const sessions = await getHeadlessBrowser().listSessionInfo();
      return okJson(sessions);
    },
  });

  registry.register(`${BROWSERS_ROOT}/*`, {
    description:
      'One sandbox browser session. Read for its state, invoke with action "revive" to put ' +
      'a socket back behind a suspended id (the page is re-navigated and the persisted ' +
      'profile still holds its cookies), delete to kill it — which also closes the window ' +
      'showing it.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    // Seeing the roster is open (the collection above); reviving and killing are not.
    // Same shape as `yaar://session/agents/*`, and for the same reason: one app must
    // not be able to end another window's session because it happened to be granted a
    // prefix. The session agent and bundled system apps — Process Explorer — qualify.
    access: 'session-principal',
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['revive'],
          description: '"revive" reopens a suspended or crashed session under the same id.',
        },
      },
    },

    async exists(resolved: ResolvedUri): Promise<boolean> {
      const id = browserIdFrom(resolved);
      if (!id) return false;
      const sessions = await getHeadlessBrowser().listSessionInfo();
      return sessions.some((s) => s.id === id);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const id = browserIdFrom(resolved);
      if (!id) return error('Browser session id required.');
      const info = (await getHeadlessBrowser().listSessionInfo()).find((s) => s.id === id);
      if (!info) return error(`No browser session "${id}".`);
      return okJson(info);
    },

    async invoke(resolved: ResolvedUri, payload): Promise<VerbResult> {
      const id = browserIdFrom(resolved);
      if (!id) return error('Browser session id required.');
      const action = (payload as { action?: string } | undefined)?.action;
      if (action !== 'revive') return error('Provide action: "revive".');

      const session = await getHeadlessBrowser().reviveSession(id);
      if (!session) return error(`Could not revive browser session "${id}".`);
      return ok(`Browser ${id} revived at ${session.currentUrl}.`);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      const id = browserIdFrom(resolved);
      if (!id) return error('Browser session id required.');

      const provider = getHeadlessBrowser();
      const session = provider.getSession(id);
      // Killing the tab without closing the window leaves a canvas painting a page
      // that no longer exists — which is exactly the failure P1 is here to end.
      if (session?.windowId) {
        actionEmitter.emitAction(
          { type: 'window.close', windowId: session.windowId },
          getSessionId(),
        );
      }
      await provider.closeSession(id);
      return ok(`Browser ${id} closed.`);
    },
  });
}
