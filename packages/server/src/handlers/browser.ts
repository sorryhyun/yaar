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
import { isDomainAllowed, extractDomain } from '../features/config/domains.js';
import { ok, error, okWithImages, assertUri, requireAction } from './utils.js';
import { resolveSession, formatPageState, findMainContent } from '../features/browser/shared.js';

export async function registerBrowserHandlers(registry: ResourceRegistry): Promise<void> {
  const pool = getBrowserPool();
  if (!(await pool.isAvailable())) return;

  // ── yaar://browser — list all browsers ──
  registry.register('yaar://browser', {
    description: 'List all open browser instances.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const browsers = pool.getAllSessions();
      if (browsers.size === 0) return ok('No browsers open.');
      const items = [...browsers.entries()].map(([bid, s]) => ({
        uri: `yaar://browser/${bid}`,
        id: bid,
        url: s.currentUrl,
        title: s.currentTitle || '(no title)',
      }));
      return ok(JSON.stringify(items, null, 2));
    },
  });

  // ── yaar://browser/* — browser instance operations ──
  registry.register('yaar://browser/*', {
    description:
      'Browser instance. Read for current state (URL, title). ' +
      'Invoke actions: open, navigate, click, type, press, scroll, hover, wait_for, screenshot, extract. ' +
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
        return ok(
          JSON.stringify(
            {
              id: resolved.resource,
              url: session.currentUrl,
              title: session.currentTitle,
            },
            null,
            2,
          ),
        );
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
          case 'open': {
            const url = p.url as string;
            if (!url) return error('"url" is required for open.');
            const domain = extractDomain(url);
            if (!domain) return error('Invalid URL');
            if (!(await isDomainAllowed(domain))) {
              return error(
                `Domain "${domain}" not allowed. Use invoke('yaar://config/domains', { domain: "${domain}" }) first.`,
              );
            }
            const { session, browserId: bid } = await pool.createSession(browserId);
            const windowId = `browser-${bid}`;
            session.windowId = windowId;
            const state = await session.navigate(
              url,
              p.waitUntil as 'load' | 'domcontentloaded' | 'networkidle' | undefined,
            );
            await actionEmitter.emitActionWithFeedback(
              {
                type: 'window.create' as const,
                windowId,
                title: `Browser — ${state.title || domain}`,
                bounds: {
                  x: 80 + Number(bid) * 30,
                  y: 60 + Number(bid) * 30,
                  w: 900,
                  h: 650,
                },
                content: {
                  renderer: 'iframe',
                  data: `/api/apps/browser/index.html?browserId=${bid}`,
                },
              },
              3000,
            );
            return ok(`[browser:${bid}]\n${formatPageState(state)}`);
          }

          case 'click': {
            const session = resolveSession(browserId);
            if (!p.selector && !p.text && (p.x === undefined || p.y === undefined)) {
              return error('Provide "selector", "text", or both "x" and "y".');
            }
            const state = await session.click(
              p.selector as string | undefined,
              p.text as string | undefined,
              p.x as number | undefined,
              p.y as number | undefined,
              p.index as number | undefined,
            );
            return ok(formatPageState(state));
          }

          case 'type': {
            const session = resolveSession(browserId);
            if (!p.selector) return error('"selector" is required for type.');
            if (!p.text) return error('"text" is required for type.');
            const state = await session.type(p.selector as string, p.text as string);
            return ok(`Typed into ${p.selector}\n\n${formatPageState(state)}`);
          }

          case 'press': {
            const session = resolveSession(browserId);
            if (!p.key) return error('"key" is required for press.');
            const state = await session.press(p.key as string, p.selector as string | undefined);
            return ok(formatPageState(state));
          }

          case 'scroll': {
            const session = resolveSession(browserId);
            const dir = p.direction as string;
            if (dir !== 'up' && dir !== 'down') return error('"direction" must be "up" or "down".');
            const state = await session.scroll(dir);
            return ok(formatPageState(state));
          }

          case 'navigate': {
            const session = resolveSession(browserId);
            const dir = p.direction as string;
            if (dir !== 'back' && dir !== 'forward')
              return error('"direction" must be "back" or "forward".');
            const state = await session.navigateHistory(dir);
            return ok(formatPageState(state));
          }

          case 'hover': {
            const session = resolveSession(browserId);
            if (!p.selector && !p.text && (p.x === undefined || p.y === undefined)) {
              return error('Provide "selector", "text", or both "x" and "y".');
            }
            const state = await session.hover(p as Parameters<typeof session.hover>[0]);
            return ok(formatPageState(state));
          }

          case 'wait_for': {
            const session = resolveSession(browserId);
            if (!p.selector) return error('"selector" is required for wait_for.');
            const state = await session.waitForSelector(
              p.selector as string,
              p.timeout as number | undefined,
            );
            return ok(formatPageState(state));
          }

          case 'screenshot': {
            const session = resolveSession(browserId);
            const hasRegion =
              p.x0 !== undefined && p.y0 !== undefined && p.x1 !== undefined && p.y1 !== undefined;
            const clip = hasRegion
              ? {
                  x: p.x0 as number,
                  y: p.y0 as number,
                  width: (p.x1 as number) - (p.x0 as number),
                  height: (p.y1 as number) - (p.y0 as number),
                }
              : undefined;
            const buffer = await session.screenshot(clip ? { clip } : undefined);
            const label = clip
              ? `Magnified region (${p.x0},${p.y0})→(${p.x1},${p.y1}) @4x:`
              : 'Current browser screenshot:';
            return okWithImages(label, [
              { data: buffer.toString('base64'), mimeType: 'image/webp' },
            ]);
          }

          case 'extract': {
            const session = resolveSession(browserId);
            const effectiveSelector =
              p.mainContentOnly && !p.selector
                ? await findMainContent(session)
                : (p.selector as string | undefined);
            const content = await session.extractContent(effectiveSelector);
            const maxText = (p.maxTextLength as number) ?? 3000;
            const maxLinks = (p.maxLinks as number) ?? 50;

            let result = `URL: ${content.url}\nTitle: ${content.title}\n`;
            if (content.fullText) {
              const text =
                content.fullText.length > maxText
                  ? content.fullText.slice(0, maxText) + '\n... (truncated)'
                  : content.fullText;
              result += `\n--- Text ---\n${text}\n`;
            }
            if (content.links.length > 0) {
              const linkLines = content.links
                .slice(0, maxLinks)
                .map((l) => `  [${l.text}](${l.href})`)
                .join('\n');
              result += `\n--- Links (${content.links.length}) ---\n${linkLines}\n`;
              if (content.links.length > maxLinks)
                result += `  ... and ${content.links.length - maxLinks} more\n`;
            }
            if (content.forms.length > 0) {
              const formLines = content.forms.map((f, i) => {
                const fields = f.fields.map((fld) => `    ${fld.name} (${fld.type})`).join('\n');
                return `  Form ${i + 1}: action=${f.action}\n${fields}`;
              });
              result += `\n--- Forms (${content.forms.length}) ---\n${formLines.join('\n')}\n`;
            }
            return ok(result.trim());
          }

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
