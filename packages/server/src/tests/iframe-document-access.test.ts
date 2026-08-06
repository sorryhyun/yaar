/**
 * An iframe may read the document it was told to render.
 *
 * The window's content URL is chosen by the server, but the browser fetches it
 * under the window's *iframe token* — so it passes the same access gate as any
 * other storage read. Devtools previews are served out of devtools' storage
 * (`/api/storage/apps/devtools/projects/{id}/dist/…`) while the preview window
 * runs under a `preview--{id}` principal of its own, which holds no permission
 * there: every preview 403'd on its own document and the desktop rendered
 * "Cannot embed this site". The window's document grant covers that one file,
 * `read` only.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import {
  requirePermission,
  resolvePrincipal,
  setWindowGrantResolver,
  storageUriFor,
  storageUriForPath,
  type Principal,
} from '../http/access.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';
import { parseContentPath } from '../lib/yaar-uri-server.js';
import { handleCreate } from '../features/window/create.js';
import { actionEmitter } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { getSessionHub } from '../session/session-hub.js';
import { WindowStateRegistry } from '../session/window-state.js';
import type { SessionId } from '../session/types.js';

const PREVIEW_PATH = '/api/storage/apps/devtools/projects/anima/dist/index.html';
const PREVIEW_URI = 'yaar://apps/devtools/storage/projects/anima/dist/index.html';
const PREVIEW_WINDOW = 'devtools-preview-anima';

/** Resolve the browser's request for the document, the way http/routes/files.ts does. */
function gateFor(token: string, path = PREVIEW_PATH) {
  const req = new Request(`http://127.0.0.1:8000${path}?__yaar_token=${token}`);
  const url = new URL(req.url);
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) throw new Error('principal was denied');
  const parsed = parseContentPath(decodeURIComponent(url.pathname));
  if (parsed?.authority !== 'storage') throw new Error('not a storage path');
  const uri = storageUriFor(principal, parsed.path);
  if (typeof uri !== 'string') throw new Error('no URI for path');
  return { principal, uri };
}

describe('iframe document access', () => {
  /**
   * The window's authority, in its real home.
   *
   * The document grant used to be baked into the token; it now lives on
   * `WindowStateRegistry` and is read per request through the gate's injected resolver
   * (`lifecycle.ts` wires it to the hub at boot). This block's subject is the *gate*, so
   * it drives a real registry directly — the mint-side producers are exercised end to end
   * through `handleCreate` in the reconnect block below.
   */
  let windowState: WindowStateRegistry;

  beforeEach(() => {
    windowState = new WindowStateRegistry();
    setWindowGrantResolver((_sessionId, windowId, monitorId) =>
      windowState.getWindowGrants(windowId, monitorId),
    );
  });

  afterEach(() => setWindowGrantResolver(() => []));

  /** Mint the preview window's token and record what its window was granted. */
  function mintPreviewToken(documentUri?: string) {
    if (documentUri) {
      windowState.grantWindowAccess(PREVIEW_WINDOW, [{ uri: documentUri, verbs: ['read'] }]);
    }
    return generateAppIframeToken(PREVIEW_WINDOW, 'sess-1', {
      appId: 'preview--anima',
      permissions: ['yaar://storage/'], // the previewed project's declared permissions
    });
  }

  it('names the document URI the gate will check', () => {
    const parsed = parseContentPath(PREVIEW_PATH);
    expect(parsed?.authority).toBe('storage');
    expect(storageUriForPath(parsed!.path)).toBe(PREVIEW_URI);
  });

  it('lets a preview iframe read its own document, though it lives in another app’s storage', async () => {
    const { principal, uri } = gateFor(await mintPreviewToken(PREVIEW_URI));
    expect(uri).toBe(PREVIEW_URI);
    expect(requirePermission(principal, uri, 'read')).toBeNull();
  });

  it('denies that document without the grant — the bug this guards', async () => {
    const { principal, uri } = gateFor(await mintPreviewToken(undefined));
    expect(requirePermission(principal, uri, 'read')?.status).toBe(403);
  });

  it('grants the one file, not a foothold in the storage that hosts it', async () => {
    const { principal } = gateFor(await mintPreviewToken(PREVIEW_URI));
    const sibling = 'yaar://apps/devtools/storage/projects/anima/app.json';
    expect(requirePermission(principal, sibling, 'read')?.status).toBe(403);
    expect(requirePermission(principal, PREVIEW_URI, 'delete')?.status).toBe(403);
  });

  it('resolves a traversing path to no document at all', () => {
    expect(storageUriForPath('apps/devtools/../secrets/keys.json')).toBeNull();
  });
});

/**
 * ...and it must still be able to read it after the desktop reloads.
 *
 * A token is not durable: every reconnect re-mints one per open iframe window
 * (`SessionSnapshotService.windowActions()` → `refreshRestoredWindowActions`), from
 * `{ appId, monitorId }` alone. So while the document grant and the caller-supplied
 * `permissions` lived *on the token*, both were dropped on the first page refresh and the
 * 403 the mint-path tests above guard against came straight back — the recurring
 * devtools-preview failure.
 *
 * `features/window/delegated-grants.ts` had already recorded the lesson ("tokens are
 * re-minted on remount and would otherwise silently lose it") and stored its grants on
 * `WindowStateRegistry`. These tests say the same rule holds for the other two, and for
 * the appId itself: the restore path used to re-derive the app from the content *path*
 * and ignore the `appId` on the action it was rewriting, so a storage-served window came
 * back as an anonymous principal.
 *
 * Everything here drives the real thing end to end — `handleCreate` for the mint,
 * `LiveSession.generateSnapshot()` for the reconnect — so a regression cannot be hidden by
 * rearranging a helper.
 */
describe('iframe document access across a reconnect', () => {
  const SESSION = 'ses-iframe-doc' as SessionId;
  const PREVIEW_WINDOW = 'devtools-preview-anima';
  const PREVIEW_APP = 'preview--anima';
  /** A prefix the *caller* adds on top of the app's declared list (payload `permissions`). */
  const EXTRA_PREFIX = 'yaar://storage/scratch/';
  const EXTRA_FILE = 'yaar://storage/scratch/anima.json';
  /** A file the create payload names *to* the app — a delegated grant (`grantsFromPayload`). */
  const NAMED_FILE = 'yaar://storage/files/brief.md';

  /**
   * Watch what the emitter sends, and answer the render handshake.
   *
   * `handleCreate` waits out a 2s deadline for an iframe that never reports, and the token
   * it minted rides on the emitted action rather than the verb result — so both halves are
   * read off this one listener.
   */
  function watchActions(): { actions: OSAction[]; stop: () => void } {
    const actions: OSAction[] = [];
    const onAction = (event: { action: OSAction; requestId?: string }) => {
      actions.push(event.action);
      if (event.requestId) {
        actionEmitter.resolveFeedback({
          requestId: event.requestId,
          windowId: (event.action as { windowId?: string }).windowId ?? '',
          renderer: 'iframe',
          success: true,
        });
      }
    };
    actionEmitter.on('action', onAction);
    return { actions, stop: () => void actionEmitter.off('action', onAction) };
  }

  /**
   * Open the preview window the way devtools does — through the real `window.create`,
   * as a monitor agent (the one caller tier `mayDelegateGrants` lets hand its reach on).
   * Returns the token that was minted for it.
   */
  async function openPreviewWindow(): Promise<string> {
    const watch = watchActions();
    try {
      await runWithAgentContext(
        { agentId: 'monitor-0', role: 'monitor', sessionId: SESSION, monitorId: '0' },
        () =>
          handleCreate(PREVIEW_WINDOW, {
            title: 'Anima (preview)',
            renderer: 'iframe',
            content: PREVIEW_PATH,
            appId: PREVIEW_APP,
            permissions: [EXTRA_PREFIX],
            // Named to the app rather than granted to it — the delegated-grant path.
            open: NAMED_FILE,
          }),
      );
    } finally {
      watch.stop();
    }
    const create = watch.actions.find((a) => a.type === 'window.create') as
      | (OSAction & { iframeToken?: string })
      | undefined;
    if (typeof create?.iframeToken !== 'string') throw new Error('no token on the create action');
    return create.iframeToken;
  }

  /** The token a reconnecting tab is handed for the same window. */
  async function reconnectToken(): Promise<string> {
    const session = getSessionHub().get(SESSION);
    if (!session) throw new Error('session went away');
    const actions = (await session.generateSnapshot()) as Array<
      OSAction & { appId?: string; iframeToken?: string }
    >;
    const win = actions.find((a) => a.type === 'window.create' && a.appId === PREVIEW_APP);
    if (typeof win?.iframeToken !== 'string') throw new Error('no token in the reconnect snapshot');
    return win.iframeToken;
  }

  function principalFor(token: string): Principal {
    const req = new Request('http://127.0.0.1:8000/api/verb', {
      headers: { 'x-iframe-token': token },
    });
    const principal = resolvePrincipal(req, new URL(req.url));
    if (principal instanceof Response) throw new Error('principal was denied');
    return principal;
  }

  /** Wire the access gate exactly as `lifecycle.ts` does at boot, then open the session. */
  async function openSession(): Promise<void> {
    setWindowGrantResolver(
      (sessionId, windowId, monitorId) =>
        getSessionHub()
          .get(sessionId as SessionId)
          ?.windowState.getWindowGrants(windowId, monitorId) ?? [],
    );
    getSessionHub().attach(SESSION, {});
  }

  afterEach(async () => {
    setWindowGrantResolver(() => []);
    await getSessionHub().remove(SESSION);
  });

  it('holds all three at the moment the window opens', async () => {
    await openSession();
    const principal = principalFor(await openPreviewWindow());
    expect(requirePermission(principal, PREVIEW_URI, 'read')).toBeNull();
    expect(requirePermission(principal, EXTRA_FILE, 'read')).toBeNull();
    expect(requirePermission(principal, NAMED_FILE, 'read')).toBeNull();
  });

  it('mints a fresh token on reconnect — which is why nothing may be stored on it', async () => {
    await openSession();
    const minted = await openPreviewWindow();
    const refreshed = await reconnectToken();
    expect(refreshed).not.toBe(minted);
    // Still an app principal on the window's own monitor: the monitor is re-derivable
    // because the restored id carries it ("0/devtools-preview-anima").
    const principal = principalFor(refreshed);
    expect(principal.kind).toBe('app');
    expect(principal.kind === 'app' && principal.monitorId).toBe('0');
  });

  it('the reconnect token still names the app', async () => {
    // `refreshRestoredWindowActions` used to re-derive the appId from the content *path*
    // (`/api/apps/{id}/…`) and ignore the `appId` sitting on the very action it was
    // rewriting. A window whose document is storage-served — which is every devtools
    // preview — matches neither pattern, so it came back as an anonymous iframe: `self`
    // stopped resolving, and with it the automatic `yaar://apps/self/{storage,db,agents}/`
    // grants the app never had to declare. The identity the token is the pure carrier of
    // was itself lost on the refresh.
    await openSession();
    await openPreviewWindow();
    const principal = principalFor(await reconnectToken());
    expect(principal.kind === 'app' && principal.appId).toBe(PREVIEW_APP);
  });

  it('can still read its own document after a reconnect', async () => {
    await openSession();
    await openPreviewWindow();
    const principal = principalFor(await reconnectToken());
    expect(requirePermission(principal, PREVIEW_URI, 'read')).toBeNull();
  });

  it('still holds the permissions its caller added, after a reconnect', async () => {
    await openSession();
    await openPreviewWindow();
    const principal = principalFor(await reconnectToken());
    expect(requirePermission(principal, EXTRA_FILE, 'read')).toBeNull();
  });

  it('still reaches the file the create named to it, after a reconnect', async () => {
    // Delegated grants were always stored on the window registry, so this one should have
    // survived already — except that `create.ts` filed them under the raw id
    // ("devtools-preview-anima") while the reconnect token names the monitor-scoped handle
    // ("0/devtools-preview-anima"), and `getWindowGrants` unioned the two spellings only
    // when the lookup came in raw. The right home was not enough; the key had to agree.
    await openSession();
    await openPreviewWindow();
    const principal = principalFor(await reconnectToken());
    expect(requirePermission(principal, NAMED_FILE, 'read')).toBeNull();
  });
});
