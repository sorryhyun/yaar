/**
 * Window domain handlers for the verb layer.
 *
 * Maps window operations to the verb layer:
 *
 *   list('yaar://windows/')               → list all windows
 *   invoke('yaar://windows/', ...)        → create window (windowId auto-derived from payload)
 *   read('yaar://windows/{w}')            → view window content/metadata
 *   invoke('yaar://windows/{w}', ...)     → update, manage, app_query, app_command
 *   delete('yaar://windows/{w}')          → close window
 */

import { join } from 'path';
import {
  type OSAction,
  type ComponentLayout,
  type WindowVariant,
  type ContentUpdateOperation,
  type AppProtocolRequest,
  componentLayoutSchema,
  parseWindowKey,
  extractAppId,
} from '@yaar/shared';
import type { ResourceRegistry, VerbResult, ResourceHandler } from '../../uri/registry.js';
import type { ResolvedUri, ResolvedWindow } from '../../uri/resolve.js';
import { actionEmitter } from '../action-emitter.js';
import type { WindowStateRegistry } from '../window-state.js';
import { ok, error } from '../utils.js';
import { getAgentId, getSessionId } from '../../agents/session.js';
import { getSessionHub } from '../../session/session-hub.js';
import { resolveResourceUri } from '../../uri/index.js';
import { generateIframeToken } from '../../http/iframe-tokens.js';
import { getAppMeta } from '../apps/discovery.js';
import { PROJECT_ROOT } from '../../config.js';
import { enrichManifestWithUris } from './manifest-utils.js';

function assertWindow(resolved: ResolvedUri): asserts resolved is ResolvedWindow {
  if (resolved.kind !== 'window') throw new Error(`Expected window URI, got ${resolved.kind}`);
}

function isWindowCollection(resolved: ResolvedUri): resolved is ResolvedWindow & { windowId: '' } {
  return resolved.kind === 'window' && (resolved as ResolvedWindow).windowId === '';
}

function formatWindowRef(windowId: string): string {
  return `yaar://windows/${windowId}`;
}

/** Derive a window ID from payload fields. */
function deriveWindowId(appId?: string, name?: string, title?: string): string {
  if (appId) return appId;
  const source = name ?? title ?? '';
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `win-${Date.now().toString(36)}`;
}

export function registerWindowHandlers(
  registry: ResourceRegistry,
  getWindowState: () => WindowStateRegistry,
): void {
  const listHandler: ResourceHandler = {
    description: 'List all open windows.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const windows = getWindowState().listWindows();
      if (windows.length === 0) return ok('No windows are currently open.');

      const windowList = windows.map((win) => {
        const parsed = parseWindowKey(win.id);
        const windowId = parsed?.windowId ?? win.id;
        return {
          id: windowId,
          uri: `yaar://windows/${windowId}`,
          title: win.title,
          position: `(${win.bounds.x}, ${win.bounds.y})`,
          size: `${win.bounds.w}x${win.bounds.h}`,
          renderer: win.content.renderer,
          locked: win.locked,
          lockedBy: win.lockedBy,
          ...(win.appProtocol ? { appProtocol: true } : {}),
          ...(win.variant && win.variant !== 'standard' ? { variant: win.variant } : {}),
          ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
        };
      });

      return ok(JSON.stringify(windowList, null, 2));
    },
  };
  registry.register('yaar://windows', listHandler);

  // ── yaar://windows/{windowId} — window operations ──
  const windowHandler: ResourceHandler = {
    description:
      'Window resource. Use yaar://windows/{windowId} to address windows (monitor is automatic). ' +
      'Invoke to create (on bare yaar://windows/), update, manage; read to view content; delete to close. ' +
      'Invoke actions: create, create_component, update, update_component, close, lock, unlock, app_query, app_command.',
    verbs: ['describe', 'list', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'create_component',
            'update',
            'update_component',
            'close',
            'lock',
            'unlock',
            'app_query',
            'app_command',
          ],
        },
        // create fields
        title: { type: 'string' },
        renderer: { type: 'string', enum: ['markdown', 'html', 'text', 'table', 'iframe'] },
        content: {},
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        appId: { type: 'string' },
        minimized: { type: 'boolean' },
        // create_component fields
        components: { type: 'array' },
        cols: {},
        gap: { type: 'string', enum: ['none', 'sm', 'md', 'lg'] },
        jsonfile: { type: 'string' },
        // update fields
        operation: { type: 'string', enum: ['append', 'prepend', 'replace', 'insertAt', 'clear'] },
        position: { type: 'number' },
        // app_command fields
        command: { type: 'string' },
        params: { type: 'object' },
        stateKey: { type: 'string' },
      },
    },

    async list(): Promise<VerbResult> {
      return listHandler.list!({} as ResolvedUri);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      // Collection-level: yaar://windows/ (bare, no windowId)
      if (isWindowCollection(resolved)) {
        const sid = getSessionId();
        const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
        const pool = session?.getPool();
        if (!pool) return error('Session not initialized.');

        const monitorId = resolved.monitorId;
        const stats = pool.getStats();
        const windows = getWindowState()
          .listWindows()
          .filter((w) => {
            const parsed = parseWindowKey(w.id);
            return parsed?.monitorId === monitorId;
          });

        return ok(
          JSON.stringify(
            {
              monitorId,
              hasMainAgent: pool.hasMainAgent(monitorId),
              windows: windows.map((w) => ({
                id: w.id,
                title: w.title,
              })),
              stats: {
                totalAgents: stats.totalAgents,
                mainQueueSize: stats.mainQueueSize,
              },
            },
            null,
            2,
          ),
        );
      }

      // Window resource: yaar://windows/{windowId}
      assertWindow(resolved);
      const win = getWindowState().getWindow(resolved.windowId);
      if (!win) {
        return error(`Window "${resolved.windowId}" not found. Use list to see available windows.`);
      }

      const windowInfo = {
        id: win.id,
        title: win.title,
        renderer: win.content.renderer,
        content: win.content.data,
        position: { x: win.bounds.x, y: win.bounds.y },
        size: { width: win.bounds.w, height: win.bounds.h },
        locked: win.locked,
        lockedBy: win.lockedBy,
        ...(win.variant && win.variant !== 'standard' ? { variant: win.variant } : {}),
        ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
        ...(win.appProtocol ? { appProtocol: true } : {}),
      };

      return ok(JSON.stringify(windowInfo, null, 2));
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload?.action) return error('Payload must include "action".');

      const action = payload.action as string;

      // Collection-level invoke: only create/create_component (windowId derived from payload)
      if (isWindowCollection(resolved)) {
        if (action === 'create') return handleCreate('', payload);
        if (action === 'create_component') return handleCreateComponent('', payload);
        return error(
          `Action "${action}" requires a window URI (yaar://windows/{windowId}). ` +
            'Only "create" and "create_component" can be invoked on a bare windows URI.',
        );
      }

      assertWindow(resolved);
      const windowId = resolved.windowId;

      switch (action) {
        case 'create':
          return handleCreate(windowId, payload);
        case 'create_component':
          return handleCreateComponent(windowId, payload);
        case 'update':
          return handleUpdate(getWindowState(), windowId, payload);
        case 'update_component':
          return handleUpdateComponent(getWindowState(), windowId, payload);
        case 'close':
          return handleManage(getWindowState(), windowId, 'close');
        case 'lock':
          return handleManage(getWindowState(), windowId, 'lock');
        case 'unlock':
          return handleManage(getWindowState(), windowId, 'unlock');
        case 'app_query':
          return handleAppQuery(getWindowState(), windowId, payload);
        case 'app_command':
          return handleAppCommand(getWindowState(), windowId, payload);
        default:
          return error(`Unknown action "${action}".`);
      }
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertWindow(resolved);
      return handleManage(getWindowState(), resolved.windowId, 'close');
    },
  };
  registry.register('yaar://windows/*', windowHandler);
}

// ── Action handlers ──

async function handleCreate(
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const title = payload.title as string;
  if (!title) return error('"title" is required for create.');

  const renderer = payload.renderer as string;
  if (!renderer) return error('"renderer" is required for create.');

  let data = payload.content as string | { headers: string[]; rows: string[][] };
  const derivedId = deriveWindowId(
    payload.appId as string | undefined,
    payload.name as string | undefined,
    title,
  );
  const actualId = windowId || derivedId;

  // Resolve yaar:// URIs for iframe content
  if (renderer === 'iframe' && typeof data === 'string') {
    const resolved = resolveResourceUri(data);
    if (resolved) {
      data = resolved.apiPath;
    } else if (data.startsWith('yaar://')) {
      const appId = extractAppId(data);
      return error(
        `Unknown app "${appId || data}". Use list to see available apps, or load_skill to learn how to use one.`,
      );
    }
  }

  const appMeta = payload.appId ? await getAppMeta(payload.appId as string) : null;

  const osAction: OSAction = {
    type: 'window.create',
    windowId: actualId,
    title,
    bounds: {
      x: (payload.x as number) ?? 100,
      y: (payload.y as number) ?? 100,
      w: (payload.width as number) ?? 500,
      h: (payload.height as number) ?? 400,
    },
    content: { renderer, data },
    ...(appMeta?.variant ? { variant: appMeta.variant as WindowVariant } : {}),
    ...(appMeta?.dockEdge ? { dockEdge: appMeta.dockEdge as 'top' | 'bottom' } : {}),
    ...(appMeta?.frameless ? { frameless: true } : {}),
    ...(appMeta?.windowStyle ? { windowStyle: appMeta.windowStyle } : {}),
    ...(payload.minimized ? { minimized: true } : {}),
    ...(renderer === 'iframe'
      ? {
          iframeToken: generateIframeToken(
            actualId,
            getSessionId() ?? '',
            payload.appId as string | undefined,
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

async function handleCreateComponent(
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const title = payload.title as string;
  if (!title) return error('"title" is required for create_component.');

  const derivedId = deriveWindowId(
    payload.appId as string | undefined,
    payload.name as string | undefined,
    title,
  );
  const actualId = windowId || derivedId;

  let layoutData: ComponentLayout;

  if (payload.jsonfile) {
    const filePath = payload.jsonfile as string;
    if (!filePath.endsWith('.yaarcomponent.json'))
      return error('jsonfile must end with .yaarcomponent.json');
    if (filePath.includes('..') || filePath.startsWith('/')) return error('Invalid jsonfile path.');

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
  } else if (payload.components) {
    layoutData = {
      components: payload.components as ComponentLayout['components'],
      cols: payload.cols as ComponentLayout['cols'],
      gap: payload.gap as ComponentLayout['gap'],
    };
  } else {
    return error('Provide either jsonfile or components.');
  }

  const appMeta = payload.appId ? await getAppMeta(payload.appId as string) : null;

  const osAction: OSAction = {
    type: 'window.create',
    windowId: actualId,
    title,
    bounds: {
      x: (payload.x as number) ?? 100,
      y: (payload.y as number) ?? 100,
      w: (payload.width as number) ?? 500,
      h: (payload.height as number) ?? 400,
    },
    content: { renderer: 'component', data: layoutData },
    ...(appMeta?.variant ? { variant: appMeta.variant as WindowVariant } : {}),
    ...(appMeta?.dockEdge ? { dockEdge: appMeta.dockEdge as 'top' | 'bottom' } : {}),
    ...(appMeta?.frameless ? { frameless: true } : {}),
    ...(appMeta?.windowStyle ? { windowStyle: appMeta.windowStyle } : {}),
    ...(payload.minimized ? { minimized: true } : {}),
  };

  actionEmitter.emitAction(osAction);
  return ok(`Created component window "${formatWindowRef(actualId)}"`);
}

async function handleUpdate(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  if (!windowState.hasWindow(windowId)) return error(`Window "${windowId}" does not exist.`);

  const agentId = getAgentId();
  const lockedBy = windowState.isLockedByOther(windowId, agentId);
  if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);

  const opType = payload.operation as string;
  if (!opType) return error('"operation" is required (append, prepend, replace, insertAt, clear).');

  const data = (payload.content as string | { headers: string[]; rows: string[][] }) ?? '';

  let operation: ContentUpdateOperation;
  switch (opType) {
    case 'append':
      operation = { op: 'append', data };
      break;
    case 'prepend':
      operation = { op: 'prepend', data };
      break;
    case 'replace':
      operation = { op: 'replace', data };
      break;
    case 'insertAt':
      if (payload.position === undefined) return error('position is required for insertAt.');
      operation = { op: 'insertAt', position: payload.position as number, data };
      break;
    case 'clear':
      operation = { op: 'clear' };
      break;
    default:
      return error(`Unknown operation "${opType}".`);
  }

  const osAction = {
    type: 'window.updateContent' as const,
    windowId,
    operation,
    renderer: payload.renderer as string | undefined,
  };

  const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);
  if (feedback && !feedback.success)
    return error(`Window "${windowId}" is locked by another agent.`);

  return ok(`Updated window "${formatWindowRef(windowId)}" (${opType})`);
}

async function handleUpdateComponent(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  if (!windowState.hasWindow(windowId)) return error(`Window "${windowId}" does not exist.`);

  const agentId = getAgentId();
  const lockedBy = windowState.isLockedByOther(windowId, agentId);
  if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);

  if (!payload.components) return error('"components" is required for update_component.');

  const layoutData: ComponentLayout = {
    components: payload.components as ComponentLayout['components'],
    cols: payload.cols as ComponentLayout['cols'],
    gap: payload.gap as ComponentLayout['gap'],
  };

  const osAction = {
    type: 'window.updateContent' as const,
    windowId,
    operation: { op: 'replace' as const, data: layoutData },
    renderer: 'component' as const,
  };

  const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);
  if (feedback && !feedback.success)
    return error(`Window "${windowId}" is locked by another agent.`);

  return ok(`Updated component window "${formatWindowRef(windowId)}"`);
}

async function handleManage(
  windowState: WindowStateRegistry,
  windowId: string,
  action: 'close' | 'lock' | 'unlock',
): Promise<VerbResult> {
  if (!windowState.hasWindow(windowId)) return error(`Window "${windowId}" does not exist.`);

  const agentId = getAgentId();
  const lockedBy = windowState.isLockedByOther(windowId, agentId);

  switch (action) {
    case 'close': {
      if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
      const feedback = await actionEmitter.emitActionWithFeedback(
        { type: 'window.close', windowId } satisfies OSAction,
        500,
      );
      if (feedback && !feedback.success)
        return error(`Failed to close window "${windowId}": ${feedback.error}`);
      return ok(`Closed window "${formatWindowRef(windowId)}"`);
    }

    case 'lock': {
      if (!agentId) return error('Cannot determine agent identity.');
      if (lockedBy) return error(`Window "${windowId}" is already locked by agent "${lockedBy}".`);
      actionEmitter.emitAction({ type: 'window.lock', windowId, agentId } satisfies OSAction);
      return ok(`Locked window "${formatWindowRef(windowId)}"`);
    }

    case 'unlock': {
      if (!agentId) return error('Cannot determine agent identity.');
      if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
      actionEmitter.emitAction({ type: 'window.unlock', windowId, agentId } satisfies OSAction);
      return ok(`Unlocked window "${formatWindowRef(windowId)}"`);
    }
  }
}

async function handleAppQuery(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  // Ensure app protocol is ready
  if (!win.appProtocol) {
    const ready = await actionEmitter.waitForAppReady(windowId, 5000);
    if (!ready) return error('App did not register with the App Protocol (timeout).');
  }

  const stateKey = (payload.stateKey as string) || 'manifest';

  if (stateKey === 'manifest') {
    const response = await actionEmitter.emitAppProtocolRequest(
      windowId,
      { kind: 'manifest' },
      5000,
    );
    if (!response) return error('App did not respond to manifest request (timeout).');
    if (response.kind !== 'manifest') return error('Unexpected response kind.');
    if (response.error) return error(response.error);
    if (response.manifest) enrichManifestWithUris(response.manifest, win.id);
    return ok(JSON.stringify(response.manifest, null, 2));
  }

  const response = await actionEmitter.emitAppProtocolRequest(
    windowId,
    { kind: 'query', stateKey },
    5000,
  );
  if (!response) return error('App did not respond (timeout).');
  if (response.kind !== 'query') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  return ok(JSON.stringify(response.data, null, 2));
}

async function handleAppCommand(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  if (!payload.command) return error('"command" is required for app_command.');

  if (!win.appProtocol) {
    const ready = await actionEmitter.waitForAppReady(windowId, 5000);
    if (!ready) return error('App did not register with the App Protocol (timeout).');
  }

  const request: AppProtocolRequest = {
    kind: 'command',
    command: payload.command as string,
    params: payload.params as Record<string, unknown> | undefined,
  };

  const response = await actionEmitter.emitAppProtocolRequest(windowId, request, 5000);
  if (!response) return error('App did not respond (timeout).');
  if (response.kind !== 'command') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  windowState.recordAppCommand(windowId, request);
  return ok(JSON.stringify(response.result, null, 2));
}
