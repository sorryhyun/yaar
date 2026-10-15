/**
 * Window creation logic.
 */

import { join } from 'path';
import {
  type OSAction,
  type ComponentLayout,
  type WindowBounds,
  extractAppId,
  type WindowSizePreset,
  nextCascadeBounds,
  defaultWindowSize,
  fitWindowBounds,
  WINDOW_PLACEMENT,
} from '@yaar/shared';
import { okJson, error, type VerbResult } from '../../lib/verb-result.js';
import { validateRelativePath, getActiveSessionId } from '../../handlers/utils.js';
import { clientAwayNote } from '../../session/client-presence.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionId } from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';
import { resolveResourceUri } from '../../handlers/uri-resolve.js';
import { generateAppIframeToken } from '../../http/iframe-tokens.js';
import { getAppMeta } from '../apps/discovery.js';
import { readSettings } from '../../storage/settings.js';
import { APPS_DIR, resolveAppDir } from '../apps/roots.js';
import { appOriginMarks } from './origin-marks.js';
import { parseComponentLayout } from './component-layout.js';
import { grantsFromPayload, mayDelegateGrants, undelegatedUris } from './delegated-grants.js';
import { namesInlinableUri, inlineUriContent } from './inline-content.js';
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
 * Size resolves explicit → app.json → the user's `windowSize` preset. Position cascades from a centered
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
 *  - **Clamped to the viewport**, so a deep cascade can't push a window off-screen.
 *
 * Whatever the source of the numbers (an explicit `x`/`y`/`width`/`height`, app.json, or
 * the cascade), the result is then fitted to the monitor's last reported viewport with
 * `fitWindowBounds` — moved back on screen first, shrunk only if larger than the desktop.
 * A 1400px window asked for at x=306 on a 1600px desktop otherwise opened with its window
 * controls and right-hand buttons off screen (#182). When the caller's own numbers were
 * changed, `adjusted` says how, so the agent does not go on believing its requested bounds.
 * A phone is left alone: there every standard window is a full-screen card, and the
 * stored bounds are what the window will use when it is next seen on a desktop.
 */
function resolveDefaultBounds(
  payload: Record<string, unknown>,
  appMeta: { defaultWidth?: number; defaultHeight?: number } | null,
  sizePreset: WindowSizePreset,
): { bounds: WindowBounds; adjusted?: string } {
  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  const monitorId = actionEmitter.resolveWindowMonitor();
  const viewport = session?.layoutContext.getViewport(monitorId);

  const fallback = defaultWindowSize(sizePreset, viewport);
  const w = (payload.width as number) ?? appMeta?.defaultWidth ?? fallback.w;
  const h = (payload.height as number) ?? appMeta?.defaultHeight ?? fallback.h;

  const explicitX = payload.x as number | undefined;
  const explicitY = payload.y as number | undefined;

  let requested: WindowBounds;
  if (explicitX != null && explicitY != null) {
    requested = { x: explicitX, y: explicitY, w, h };
  } else {
    const occupied = session
      ? session.windowState
          .listWindows()
          .filter((win) => session.windowState.getMonitorForWindow(win.id) === monitorId)
          .map((win) => win.bounds)
      : [];
    const cascaded = nextCascadeBounds(occupied, w, h, viewport);
    requested = { x: explicitX ?? cascaded.x, y: explicitY ?? cascaded.y, w, h };
  }

  if (!viewport || session?.layoutContext.getFormFactor(monitorId) === 'mobile') {
    return { bounds: requested };
  }
  // The bottom strip is the command palette's: a window reaching under it has its
  // bottom row (an app's Send button, say) covered.
  const area = { x: 0, y: 0, w: viewport.w, h: viewport.h - WINDOW_PLACEMENT.paletteInset };
  const bounds = fitWindowBounds(requested, area);
  const asked =
    payload.x != null || payload.y != null || payload.width != null || payload.height != null;
  if (!asked || sameBounds(bounds, requested)) return { bounds };
  return {
    bounds,
    adjusted:
      `The requested bounds (${describeBounds(requested)}) did not fit the ` +
      `${viewport.w}×${viewport.h} desktop, so the window opened at ${describeBounds(bounds)} ` +
      `instead — moved back on screen, and shrunk only where it was larger than the desktop.`,
  };
}

function sameBounds(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function describeBounds(b: WindowBounds): string {
  return `${b.w}×${b.h} at x=${b.x}, y=${b.y}`;
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
        const result = parseComponentLayout(JSON.parse(raw));
        if (!result.ok) return error(`Invalid .yaarcomponent.json: ${result.message}`);
        layoutData = result.layout;
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
      const { components, cols, gap } = payload.content as Record<string, unknown>;
      const result = parseComponentLayout({ components, cols, gap });
      if (!result.ok) return error(result.message);
      layoutData = result.layout;
    } else {
      return error(
        'Provide "content" with { components: [...] } or "jsonfile" for component renderer.',
      );
    }

    const appMeta = payload.appId ? await getAppMeta(payload.appId as string) : null;
    const { windowSize } = await readSettings();

    const componentAppId = payload.appId as string | undefined;
    const placement = resolveDefaultBounds(payload, appMeta, windowSize);
    const osAction: OSAction = {
      type: 'window.create',
      windowId: actualId,
      title,
      bounds: placement.bounds,
      content: { renderer: 'component', data: layoutData },
      ...getAppMetaOverrides(appMeta),
      ...(componentAppId ? { appId: componentAppId } : {}),
      ...(payload.minimized ? { minimized: true } : {}),
    };

    actionEmitter.emitAction(osAction);
    return okJson({
      windowId: actualId,
      message: `Created component window "${formatWindowRef(actualId)}"`,
      ...(placement.adjusted ? { boundsAdjusted: placement.adjusted } : {}),
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

  // A URI where a text renderer expects text. `iframe` resolved its own above; the
  // others used to display the pointer verbatim and report success — see
  // inline-content.ts. Substituted into the action, so the window holds what it shows.
  if (namesInlinableUri(renderer, data)) {
    const inlined = await inlineUriContent(renderer, data);
    if (!inlined.ok) return error(inlined.message);
    data = inlined.data;
  }

  const appMeta = appId ? await getAppMeta(appId) : null;
  const { windowSize } = await readSettings();

  // App-origin isolation (docs/guides/remote_mode.md). The frontend does the actual
  // origin swap; here we only mark it.
  const originMarks = renderer === 'iframe' ? appOriginMarks(appId) : {};

  // Pin the monitor now, using the same resolution the emitter will stamp on the create
  // action below. Left to be derived later from the window id, it is ambiguous whenever
  // the app is open on more than one monitor. Used twice: on the token, and as the scope
  // of the grants recorded for this window.
  const windowMonitorId = renderer === 'iframe' ? actionEmitter.resolveWindowMonitor() : undefined;

  const placement = resolveDefaultBounds(payload, appMeta, windowSize);
  const boundsNote = placement.adjusted ? { boundsAdjusted: placement.adjusted } : {};
  const osAction: OSAction = {
    type: 'window.create',
    windowId: actualId,
    title,
    bounds: placement.bounds,
    content: { renderer, data },
    ...getAppMetaOverrides(appMeta),
    ...(appId ? { appId } : {}),
    ...originMarks,
    ...(payload.minimized ? { minimized: true } : {}),
    ...(renderer === 'iframe'
      ? {
          // Identity only — see http/iframe-tokens.ts. Everything this window was
          // *granted* goes on the registry, below.
          iframeToken: await generateAppIframeToken(actualId, getSessionId() ?? '', {
            appId,
            monitorId: windowMonitorId,
            appMeta,
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
    // What the same payload named and did *not* get, when the caller may not delegate —
    // `openPreview` passing a `permissions` array is this case, and its discard is as
    // silent as the relay's. Remembered so the resulting 403 can name its own reason.
    session?.windowState.noteUndelegatedUris(actualId, undelegatedUris(payload), windowMonitorId);

    const askedAt = Date.now();
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
      // A render confirmation comes from the page, so a backgrounded tab produces this
      // for every window it is asked to make — which reads as each one failing.
      const away = clientAwayNote(getActiveSessionId(), askedAt);
      return okJson({
        windowId: actualId,
        renderConfirmed: false,
        message:
          `Created window "${formatWindowRef(actualId)}", but its iframe did not confirm ` +
          `rendering within ${IFRAME_RENDER_TIMEOUT_MS / 1000}s (${outcome.reason}). It may still ` +
          `be loading, or may have failed silently — read ${formatWindowRef(actualId)} to see it ` +
          `before telling the user it is ready. Do not create the window again.` +
          (away ? ` ${away}` : ''),
        ...boundsNote,
      });
    }

    return okJson({
      windowId: actualId,
      renderConfirmed: true,
      message: `Created window "${formatWindowRef(actualId)}" with embedded iframe`,
      ...boundsNote,
    });
  }

  actionEmitter.emitAction(osAction);
  return okJson({
    windowId: actualId,
    message: `Created window "${formatWindowRef(actualId)}"`,
    ...boundsNote,
  });
}
