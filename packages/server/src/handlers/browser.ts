/**
 * Browser domain handlers for the verb layer.
 *
 * Maps browser operations to the verb layer:
 *
 *   list('yaar://browser/')               → list all open browsers
 *   read('yaar://browser/{id}')           → browser state (URL, title)
 *   invoke('yaar://browser/{id}', ...)    → open, navigate, click, type, press, scroll, hover, wait_for, screenshot, extract
 *   delete('yaar://browser/{id}')         → close browser
 *
 * Conditional on Chrome/Edge availability — skips registration if not found.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { getBrowserPool } from '../lib/browser/index.js';
import { actionEmitter } from '../session/action-emitter.js';
import { ok, okJson, error, assertUri, requireAction } from './utils.js';
import { resolveSession } from '../features/browser/shared.js';
import {
  handleOpen,
  handleClick,
  handleType,
  handlePress,
  handleScroll,
  handleNavigate,
  handleHover,
  handleWaitFor,
  handleScreenshot,
  handleExtract,
  handleExtractImages,
  handleHtml,
} from '../features/browser/actions.js';

export async function registerBrowserHandlers(registry: ResourceRegistry): Promise<void> {
  const pool = getBrowserPool();
  if (!(await pool.isAvailable())) return;

  // ── yaar://browser — list all browsers ──
  registry.register('yaar://browser', {
    description: 'List all open browser instances.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const browsers = pool.getAllSessions();
      if (browsers.size === 0) return okJson([]);
      const items = [...browsers.entries()].map(([bid, s]) => ({
        uri: `yaar://browser/${bid}`,
        id: bid,
        url: s.currentUrl,
        title: s.currentTitle || '(no title)',
      }));
      return okJson(items);
    },
  });

  // ── yaar://browser/* — browser instance operations ──
  registry.register('yaar://browser/*', {
    description:
      'Browser instance. Read for current state (URL, title). ' +
      'Invoke actions: open, navigate, click, type, press, scroll, hover, wait_for, screenshot, extract, extract_images, html. ' +
      'Delete to close.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'open',
            'navigate',
            'click',
            'type',
            'press',
            'scroll',
            'hover',
            'wait_for',
            'screenshot',
            'extract',
            'extract_images',
            'html',
          ],
        },
        url: { type: 'string', description: 'URL for open action' },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
        },
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        index: { type: 'number' },
        visible: { type: 'boolean', description: 'Show browser window on open (default: true)' },
        mobile: {
          type: 'boolean',
          description: 'Open in mobile mode with phone viewport and user-agent (default: false)',
        },
        key: { type: 'string', description: 'Key for press action' },
        direction: { type: 'string', enum: ['up', 'down', 'back', 'forward'] },
        timeout: { type: 'number' },
        // screenshot region
        x0: { type: 'number' },
        y0: { type: 'number' },
        x1: { type: 'number' },
        y1: { type: 'number' },
        // extract options
        maxLinks: { type: 'number' },
        maxTextLength: { type: 'number' },
        mainContentOnly: { type: 'boolean' },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'browser');
      try {
        const session = resolveSession(resolved.resource);
        return okJson({
          id: resolved.resource,
          url: session.currentUrl,
          title: session.currentTitle,
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      assertUri(resolved, 'browser');
      const actionErr = requireAction(payload);
      if (actionErr) return actionErr;
      // payload is guaranteed non-undefined after requireAction
      const p = payload!;

      const action = p.action as string;
      const browserId = resolved.resource;

      try {
        switch (action) {
          case 'open':
            return await handleOpen(pool, browserId, p);
          case 'click':
            return await handleClick(browserId, p);
          case 'type':
            return await handleType(browserId, p);
          case 'press':
            return await handlePress(browserId, p);
          case 'scroll':
            return await handleScroll(browserId, p);
          case 'navigate':
            return await handleNavigate(browserId, p);
          case 'hover':
            return await handleHover(browserId, p);
          case 'wait_for':
            return await handleWaitFor(browserId, p);
          case 'screenshot':
            return await handleScreenshot(browserId, p);
          case 'extract':
            return await handleExtract(browserId, p);
          case 'extract_images':
            return await handleExtractImages(browserId, p);
          case 'html':
            return await handleHtml(browserId, p);
          default:
            return error(`Unknown action "${action}".`);
        }
      } catch (err) {
        return error(`Browser error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'browser');
      const browserId = resolved.resource;
      const session = pool.getSession(browserId);
      if (!session) return error(`No browser with ID ${browserId}.`);
      if (session.windowId) {
        actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
      }
      await pool.closeSession(browserId);
      return ok(`Browser ${browserId} closed.`);
    },
  });
}
