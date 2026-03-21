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
import { ok, error, validateRelativePath } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionId } from '../../agents/session.js';
import { getSessionHub } from '../../session/session-hub.js';
import { resolveResourceUri } from '../../handlers/uri-resolve.js';
import { generateAppIframeToken } from '../../http/iframe-tokens.js';
import { getAppMeta } from '../apps/discovery.js';
import { PROJECT_ROOT } from '../../config.js';
import { formatWindowRef, deriveWindowId, getAppMetaOverrides } from './helpers.js';

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

      const fullPath = join(PROJECT_ROOT, 'apps', filePath);
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
    } else if (payload.components) {
      // Legacy: top-level components/cols/gap (from deprecated create_component)
      layoutData = {
        components: payload.components as ComponentLayout['components'],
        cols: payload.cols as ComponentLayout['cols'],
        gap: payload.gap as ComponentLayout['gap'],
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
        w: (payload.width as number) ?? 500,
        h: (payload.height as number) ?? 400,
      },
      content: { renderer: 'component', data: layoutData },
      ...getAppMetaOverrides(appMeta),
      ...(componentAppId ? { appId: componentAppId } : {}),
      ...(payload.minimized ? { minimized: true } : {}),
    };

    actionEmitter.emitAction(osAction);
    return ok(`Created component window "${formatWindowRef(actualId)}"`);
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
      w: (payload.width as number) ?? 500,
      h: (payload.height as number) ?? 400,
    },
    content: { renderer, data },
    ...getAppMetaOverrides(appMeta),
    ...(appId ? { appId } : {}),
    ...(payload.minimized ? { minimized: true } : {}),
    ...(renderer === 'iframe'
      ? {
          iframeToken: await generateAppIframeToken(
            actualId,
            getSessionId() ?? '',
            appId,
            Array.isArray(payload.permissions) ? (payload.permissions as string[]) : undefined,
          ),
        }
      : {}),
  };

  if (renderer === 'iframe') {
    const feedback = await actionEmitter.emitActionWithFeedback(osAction, 2000);
    if (feedback && !feedback.success) {
      const isNotFound = feedback.error?.toLowerCase().includes('not found');
      const hint = isNotFound
        ? ' If this is an app, use load_skill to learn how to use it.'
        : ' The site likely blocks embedding.';
      return error(`Failed to embed iframe in window "${actualId}": ${feedback.error}.${hint}`);
    }
    return ok(`Created window "${formatWindowRef(actualId)}" with embedded iframe`);
  }

  actionEmitter.emitAction(osAction);
  return ok(`Created window "${formatWindowRef(actualId)}"`);
}
