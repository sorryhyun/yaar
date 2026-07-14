/**
 * Window creation logic.
 */

import { join } from 'path';
import {
  type OSAction,
  type ComponentLayout,
  componentLayoutSchema,
  extractAppId,
} from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { okJson, error, validateRelativePath } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionId } from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';
import { resolveResourceUri } from '../../handlers/uri-resolve.js';
import { generateAppIframeToken } from '../../http/iframe-tokens.js';
import { storageUriForPath } from '../../http/access.js';
import { parseContentPath } from '../../lib/yaar-uri-server.js';
import { getAppMeta } from '../apps/discovery.js';
import { APPS_DIR, resolveAppDir } from '../apps/roots.js';
import { formatWindowRef, deriveWindowId, getAppMetaOverrides } from './helpers.js';

/** How long an iframe window gets to report that its content rendered. */
const IFRAME_RENDER_TIMEOUT_MS = 2_000;

/**
 * Name the `yaar://` URI of an iframe's own document, when storage is what serves it.
 *
 * The browser fetches this URL under the window's iframe token, so it passes through
 * the same gate as any other storage read — and it is parsed here the same way the
 * gate parses it (`parseContentPath` over a decoded pathname), so the URI granted is
 * the URI checked. Returns undefined for content storage does not serve — an external
 * site, or a bundled app under `/api/apps/`, which is not permission-gated at all.
 */
function storageDocumentUri(data: unknown): string | undefined {
  if (typeof data !== 'string') return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(data.split('?')[0]);
  } catch {
    return undefined; // malformed escape — names no file
  }
  const parsed = parseContentPath(decoded);
  if (parsed?.authority !== 'storage') return undefined;
  return storageUriForPath(parsed.path) ?? undefined;
}

/** Cascade offset per window (px). */
const CASCADE_STEP = 32;
/** Maximum cascade offset before wrapping back to origin. */
const CASCADE_MAX = 320;

/**
 * Compute cascade offset for default window positions.
 * Returns { x, y } offset based on existing window count in the session.
 */
function getCascadeOffset(): { x: number; y: number } {
  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  if (!session) return { x: 0, y: 0 };
  const count = session.windowState.getWindowCount();
  const offset = (count * CASCADE_STEP) % CASCADE_MAX;
  return { x: offset, y: offset };
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
  const actualId = windowId || derivedId;

  // Cascade offset: when no explicit position, offset based on existing window count
  const cascade = payload.x == null && payload.y == null ? getCascadeOffset() : { x: 0, y: 0 };

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
      bounds: {
        x: (payload.x as number) ?? 100 + cascade.x,
        y: (payload.y as number) ?? 100 + cascade.y,
        w: (payload.width as number) ?? appMeta?.defaultWidth ?? 500,
        h: (payload.height as number) ?? appMeta?.defaultHeight ?? 400,
      },
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

  // Non-component renderers
  let data = payload.content as string | { headers: string[]; rows: string[][] };

  // Auto-extract appId from content URI (e.g. yaar://apps/word-lite) when not explicit
  const appId =
    (payload.appId as string | undefined) ||
    (renderer === 'iframe' && typeof data === 'string' && extractAppId(data)) ||
    undefined;

  // Resolve yaar:// URIs for iframe content
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

  const osAction: OSAction = {
    type: 'window.create',
    windowId: actualId,
    title,
    bounds: {
      x: (payload.x as number) ?? 100 + cascade.x,
      y: (payload.y as number) ?? 100 + cascade.y,
      w: (payload.width as number) ?? appMeta?.defaultWidth ?? 500,
      h: (payload.height as number) ?? appMeta?.defaultHeight ?? 400,
    },
    content: { renderer, data },
    ...getAppMetaOverrides(appMeta),
    ...(appId ? { appId } : {}),
    ...(payload.minimized ? { minimized: true } : {}),
    ...(renderer === 'iframe'
      ? {
          iframeToken: await generateAppIframeToken(actualId, getSessionId() ?? '', {
            appId,
            permissions: Array.isArray(payload.permissions)
              ? (payload.permissions as string[])
              : undefined,
            // Pin the monitor now, using the same resolution the emitter will stamp on
            // the create action below. Left to be derived later from the window id, it
            // is ambiguous whenever the app is open on more than one monitor.
            monitorId: actionEmitter.resolveWindowMonitor(),
            documentUri: storageDocumentUri(data),
          }),
        }
      : {}),
  };

  if (renderer === 'iframe') {
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
