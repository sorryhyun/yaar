/**
 * Window creation logic.
 */

import { join } from 'path';
import {
  type OSAction,
  type ComponentLayout,
  type WindowBounds,
  extractAppId,
  WINDOW_PLACEMENT,
  cascadeWindowBounds,
} from '@yaar/shared';
import { componentLayoutSchema } from '@yaar/shared/schemas';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { okJson, error, validateRelativePath } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionId } from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';
import { resolveResourceUri } from '../../handlers/uri-resolve.js';
import { generateAppIframeToken } from '../../http/iframe-tokens.js';
import { getAppMeta } from '../apps/discovery.js';
import { APPS_DIR, resolveAppDir, resolveAppSource } from '../apps/roots.js';
import { isolatedAppOrigin, isOriginBoundaryActive } from '../../http/origin-boundary.js';
import { grantsFromPayload, mayDelegateGrants } from './delegated-grants.js';
import type { PermissionEntry } from '../../http/access.js';
import {
  formatWindowRef,
  deriveWindowId,
  allocateWindowId,
  getAppMetaOverrides,
  storageDocumentUri,
} from './helpers.js';

/** How long an iframe window gets to report that its content rendered. */
const IFRAME_RENDER_TIMEOUT_MS = 2_000;

/**
 * Single source of truth for a new window's bounds.
 *
 * Size resolves explicit → app.json → 640x480. Position cascades from a centered
 * origin, so the first window on a monitor lands in the middle of the viewport and
 * each subsequent one steps down-right instead of burying its predecessor.
 *
 * Three things this fixes over the previous inline logic:
 *  - **Per-axis cascade.** The old gate was `x == null && y == null` while the
 *    fallbacks were per-axis, so a caller supplying only `x` got cascade `{0,0}`
 *    and `y` pinned to exactly 100 — every such window stacked.
 *  - **Monitor-scoped count.** `getWindowCount()` counted every window in the
 *    session across all monitors and never decremented on close, so the offset
 *    tracked session history rather than what is actually on screen.
 *  - **Clamped to the viewport**, so a deep cascade can't push a window off-screen
 *    (the frontend clamp runs after x is fixed and silently narrows w instead).
 */
function resolveDefaultBounds(
  payload: Record<string, unknown>,
  appMeta: { defaultWidth?: number; defaultHeight?: number } | null,
): WindowBounds {
  const w = (payload.width as number) ?? appMeta?.defaultWidth ?? WINDOW_PLACEMENT.defaultWidth;
  const h = (payload.height as number) ?? appMeta?.defaultHeight ?? WINDOW_PLACEMENT.defaultHeight;

  const explicitX = payload.x as number | undefined;
  const explicitY = payload.y as number | undefined;
  if (explicitX != null && explicitY != null) return { x: explicitX, y: explicitY, w, h };

  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  const monitorId = actionEmitter.resolveWindowMonitor();

  let count = 0;
  let viewport: { w: number; h: number } | undefined;
  if (session) {
    viewport = session.layoutContext.getViewport(monitorId);
    count = session.windowState
      .listWindows()
      .filter((win) => session.windowState.getMonitorForWindow(win.id) === monitorId).length;
  }

  const cascaded = cascadeWindowBounds(count, w, h, viewport);
  return { x: explicitX ?? cascaded.x, y: explicitY ?? cascaded.y, w, h };
}

/** Handle window creation (both component and non-component renderers). */
export async function handleCreate(
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const title = payload.title as string;
  if (!title) return error('"title" is required for create.');

  const renderer = payload.renderer as string;
  if (!renderer) return error('"renderer" is required for create.');

  const derivedId = deriveWindowId(
    payload.appId as string | undefined,
    payload.name as string | undefined,
    title,
  );

  // A create must never take a live window's id — the frontend would overwrite the
  // window in place. The two collision cases mean different things, so they end
  // differently: an id we *derived* from the title/appId is our own guess, and the
  // caller asked for a new window, so step to the next free one. An id the caller
  // *named* is a claim about which window it means; silently redirecting it would
  // leave the agent updating a window it never sees, so say so instead.
  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  let actualId = windowId || derivedId;
  if (session?.windowState.hasWindow(actualId)) {
    if (windowId) {
      return error(
        `Window "${formatWindowRef(actualId)}" already exists. Use action "update" to change ` +
          `its content, "close" it first, or create with a different id.`,
      );
    }
    actualId = allocateWindowId(session.windowState, actualId);
  }

  // Component renderer: content is a ComponentLayout object or loaded from jsonfile
  if (renderer === 'component') {
    let layoutData: ComponentLayout;

    if (payload.jsonfile) {
      const filePath = payload.jsonfile as string;
      if (!filePath.endsWith('.yaarcomponent.json'))
        return error('jsonfile must end with .yaarcomponent.json');
      const pathErr = validateRelativePath(filePath);
      if (pathErr) return error(pathErr);

      // Resolve the owning app's root (bundled or user-apps) from the leading
      // path segment; fall back to the bundled root.
      const appRoot = resolveAppDir(filePath.split('/')[0]);
      const fullPath =
        appRoot && filePath.includes('/')
          ? join(appRoot, filePath.split('/').slice(1).join('/'))
          : join(APPS_DIR, filePath);
      try {
        const raw = await Bun.file(fullPath).text();
        const parsed = JSON.parse(raw);
        const result = componentLayoutSchema.safeParse(parsed);
        if (!result.success) return error(`Invalid .yaarcomponent.json: ${result.error.message}`);
        layoutData = result.data;
      } catch (err) {
        return error(
          `Error reading jsonfile: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    } else if (
      payload.content &&
      typeof payload.content === 'object' &&
      !Array.isArray(payload.content)
    ) {
      const contentObj = payload.content as Record<string, unknown>;
      if (!contentObj.components)
        return error('"content.components" is required for component renderer.');
      layoutData = {
        components: contentObj.components as ComponentLayout['components'],
        cols: contentObj.cols as ComponentLayout['cols'],
        gap: contentObj.gap as ComponentLayout['gap'],
      };
    } else {
      return error(
        'Provide "content" with { components: [...] } or "jsonfile" for component renderer.',
      );
    }

    const appMeta = payload.appId ? await getAppMeta(payload.appId as string) : null;

    const componentAppId = payload.appId as string | undefined;
    const osAction: OSAction = {
      type: 'window.create',
      windowId: actualId,
      title,
      bounds: resolveDefaultBounds(payload, appMeta),
      content: { renderer: 'component', data: layoutData },
      ...getAppMetaOverrides(appMeta),
      ...(componentAppId ? { appId: componentAppId } : {}),
      ...(payload.minimized ? { minimized: true } : {}),
    };

    actionEmitter.emitAction(osAction);
    return okJson({
      windowId: actualId,
      message: `Created component window "${formatWindowRef(actualId)}"`,
    });
  }

  let data = payload.content as string | { headers: string[]; rows: string[][] };

  // Auto-extract appId from content URI (e.g. yaar://apps/word-lite) when not explicit
  const appId =
    (payload.appId as string | undefined) ||
    (renderer === 'iframe' && typeof data === 'string' && extractAppId(data)) ||
    undefined;

  if (renderer === 'iframe' && typeof data === 'string') {
    const resolved = resolveResourceUri(data);
    if (resolved) {
      data = resolved.apiPath;
    } else if (data.startsWith('yaar://')) {
      return error(
        `Unknown app "${appId || data}". Use list to see available apps, or load_skill to learn how to use one.`,
      );
    }
  }

  const appMeta = appId ? await getAppMeta(appId) : null;

  // App-origin isolation (docs/guides/remote_mode.md): only installed
  // (`source:'user'`) apps move to the pinned app origin — bundled apps and
  // AI-authored HTML are host-authored, not the hostile-app threat, and stay
  // same-origin. The frontend does the actual origin swap; here we only mark it.
  const isolateOrigin =
    isOriginBoundaryActive() &&
    renderer === 'iframe' &&
    !!appId &&
    resolveAppSource(appId) === 'user';

  // Locally the frontend derives the app origin itself (only the browser knows which
  // port served the document — a dev proxy is not the API port). Over a `proxy-port`
  // boundary the origin is a published address the server chose, so state it: the
  // client has no way to compute `https://<magic-dns>:8443` from where it is standing.
  const appOrigin = isolateOrigin ? isolatedAppOrigin() : null;

  // Pin the monitor now, using the same resolution the emitter will stamp on the create
  // action below. Left to be derived later from the window id, it is ambiguous whenever
  // the app is open on more than one monitor. Used twice: on the token, and as the scope
  // of the grants recorded for this window.
  const windowMonitorId = renderer === 'iframe' ? actionEmitter.resolveWindowMonitor() : undefined;

  const osAction: OSAction = {
    type: 'window.create',
    windowId: actualId,
    title,
    bounds: resolveDefaultBounds(payload, appMeta),
    content: { renderer, data },
    ...getAppMetaOverrides(appMeta),
    ...(appId ? { appId } : {}),
    ...(isolateOrigin ? { isolateOrigin: true } : {}),
    ...(appOrigin ? { appOrigin } : {}),
    ...(payload.minimized ? { minimized: true } : {}),
    ...(renderer === 'iframe'
      ? {
          // Identity only — see http/iframe-tokens.ts. Everything this window was
          // *granted* goes on the registry, below.
          iframeToken: await generateAppIframeToken(actualId, getSessionId() ?? '', {
            appId,
            monitorId: windowMonitorId,
          }),
        }
      : {}),
  };

  if (renderer === 'iframe') {
    // Everything this window is granted at runtime, as opposed to what its manifest
    // declares. Three producers, one home:
    //
    //  - **Files this create named to the app** — a `?file=yaar://storage/…` on the
    //    content URL, a path in an `open` payload. `grantsFromPayload` applies all four
    //    narrowings (privileged caller only, exact files, `read` only, window-scoped).
    //  - **Permissions a privileged caller added on top.** Honoured only for a caller
    //    that outranks the app (`mayDelegateGrants`) — `window.create` is reachable from
    //    any app declaring `yaar://windows/`, and these were once taken from the payload
    //    unconditionally *and* used to replace the manifest's list, so an app could mint
    //    itself a window holding `yaar://storage/`. Additive for the same reason: a
    //    grant must never subtract.
    //  - **The document the window exists to render**, when storage is what serves it.
    //    The content URL is the server's choice and the browser fetches it under this
    //    window's token, so without this the gate can deny a window its own document —
    //    it did, for every devtools preview. This exact file, `read` only, no prefix.
    //
    // All three used to be baked into the token, which is re-minted on every reconnect:
    // they were silently lost on the first page refresh. Recorded before the emit so the
    // app can read them on its very first turn, and scoped to the monitor the window is
    // about to be registered on — filed under the bare raw id, a grant is one every
    // monitor's copy of the same app can read.
    const docUri = storageDocumentUri(data);
    session?.windowState.grantWindowAccess(
      actualId,
      [
        ...grantsFromPayload(payload),
        ...(Array.isArray(payload.permissions) && mayDelegateGrants()
          ? (payload.permissions as PermissionEntry[])
          : []),
        ...(docUri ? [{ uri: docUri, verbs: ['read' as const] }] : []),
      ],
      windowMonitorId,
    );

    const outcome = await actionEmitter.emitActionWithFeedback(osAction, IFRAME_RENDER_TIMEOUT_MS);

    if (outcome.ok && !outcome.value.success) {
      const { error: reason } = outcome.value;
      const isNotFound = reason?.toLowerCase().includes('not found');
      const hint = isNotFound
        ? ' If this is an app, use load_skill to learn how to use it.'
        : ' The site likely blocks embedding.';
      return error(`Failed to embed iframe in window "${actualId}": ${reason}.${hint}`);
    }

    // The deadline passed with the iframe still silent. The window is on the desktop —
    // the create action was delivered and applied — but nothing has said the content
    // inside it loaded, and this used to be reported as "created ... with embedded
    // iframe", the same words as a confirmed render. It is neither a failure (a slow
    // site is still loading) nor a success (a wedged one never will), and the agent is
    // the one who has to decide what to do about that, so tell it which it got.
    if (!outcome.ok) {
      return okJson({
        windowId: actualId,
        renderConfirmed: false,
        message:
          `Created window "${formatWindowRef(actualId)}", but its iframe did not confirm ` +
          `rendering within ${IFRAME_RENDER_TIMEOUT_MS / 1000}s (${outcome.reason}). It may still ` +
          `be loading, or may have failed silently — read ${formatWindowRef(actualId)} to see it ` +
          `before telling the user it is ready. Do not create the window again.`,
      });
    }

    return okJson({
      windowId: actualId,
      renderConfirmed: true,
      message: `Created window "${formatWindowRef(actualId)}" with embedded iframe`,
    });
  }

  actionEmitter.emitAction(osAction);
  return okJson({ windowId: actualId, message: `Created window "${formatWindowRef(actualId)}"` });
}
