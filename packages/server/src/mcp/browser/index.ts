/**
 * MCP browser tools — visible browser automation via CDP.
 *
 * The agent controls a headless Chromium browser, screenshots are displayed
 * in a YAAR window via the browser app, and text content is returned to the agent.
 *
 * The browser app iframe subscribes to SSE updates (/api/browser/{browserId}/events)
 * so screenshot refreshes happen automatically — no App Protocol round-trip needed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBrowserPool } from '../../lib/browser/index.js';
import type { BrowserSession, PageState } from '../../lib/browser/index.js';
import { actionEmitter } from '../action-emitter.js';
import { isDomainAllowed, extractDomain } from '../domains.js';
import { ok, okWithImages, error } from '../utils.js';

/**
 * Resolve a browser session by browserId.
 * If browserId is given, look up that specific browser.
 * If not given, use the only browser (or error if 0 or multiple).
 */
function resolveSession(browserId?: string): BrowserSession {
  const pool = getBrowserPool();
  if (browserId !== undefined) {
    const session = pool.getSession(browserId);
    if (!session) throw new Error(`No browser with ID ${browserId}. Use browser:open first.`);
    return session;
  }
  const browsers = pool.getAllSessions();
  if (browsers.size === 0) throw new Error('No browser open. Use browser:open first.');
  if (browsers.size === 1) return browsers.values().next().value!;
  const ids = [...browsers.keys()].join(', ');
  throw new Error(`Multiple browsers open (${ids}). Specify browserId.`);
}

function formatPageState(state: PageState): string {
  let result = `URL: ${state.url}`;
  if (state.urlChanged) result += ' (changed)';
  result += `\nTitle: ${state.title}`;
  if (state.activeElement) {
    const ae = state.activeElement;
    let desc = `<${ae.tag}`;
    if (ae.name) desc += ` name="${ae.name}"`;
    if (ae.id) desc += ` id="${ae.id}"`;
    if (ae.type) desc += ` type="${ae.type}"`;
    desc += '>';
    result += `\nActive element: ${desc}`;
  }
  if (state.scrollHeight && state.viewportHeight && state.scrollHeight > state.viewportHeight) {
    const percent = Math.round(
      ((state.scrollY ?? 0) / (state.scrollHeight - state.viewportHeight)) * 100,
    );
    result += `\nScroll: ${state.scrollY ?? 0}/${state.scrollHeight} (${percent}% scrolled)`;
  }
  if (state.clickTarget) {
    const ct = state.clickTarget;
    result += `\nClicked: <${ct.tag}> "${ct.text}"`;
    if (ct.candidateCount > 1) result += ` (${ct.candidateCount} candidates)`;
  }
  if (state.textSnippet) {
    result += `\n\nPage content:\n${state.textSnippet}`;
  }
  return result;
}

/** Heuristic: find the CSS selector for the largest text-containing block element. */
async function findMainContent(session: BrowserSession): Promise<string | undefined> {
  return session.findMainContentSelector();
}

let _available = false;

/**
 * Whether browser tools were successfully registered (Chrome/Edge was found).
 */
export function isBrowserAvailable(): boolean {
  return _available;
}

/**
 * Register browser automation tools on the given MCP server.
 * Silently skips if Chrome/Edge is not found.
 */
export async function registerBrowserTools(server: McpServer): Promise<void> {
  const pool = getBrowserPool();
  if (!(await pool.isAvailable())) {
    console.log(
      '[browser] Chrome/Edge not found — browser tools disabled. Set CHROME_PATH if needed.',
    );
    return;
  }

  _available = true;
  console.log('[browser] Chrome found — registering browser tools');

  // ── open ────────────────────────────────────────────────────────────

  server.registerTool(
    'open',
    {
      description:
        'Open a URL in a visible browser. Always creates a new browser tab/window. Returns page title, URL, text content, and the assigned browser ID.',
      inputSchema: {
        url: z.string().url().describe('The URL to navigate to'),
        browserId: z
          .string()
          .optional()
          .describe('Optional browser ID. If omitted, auto-assigns next available ID.'),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle'])
          .optional()
          .describe(
            'When to consider navigation complete: "load" (default), "domcontentloaded", or "networkidle"',
          ),
      },
    },
    async (args) => {
      try {
        const domain = extractDomain(args.url);
        if (!domain) return error('Invalid URL');

        if (!(await isDomainAllowed(domain))) {
          return error(`Domain "${domain}" not allowed. Use request_allowing_domain first.`);
        }

        const { session, browserId } = await pool.createSession(args.browserId);
        const windowId = `browser-${browserId}`;
        session.windowId = windowId;

        // Navigate first so we have a screenshot before showing the window
        const state = await session.navigate(args.url, args.waitUntil);

        // Create YAAR window with browser app iframe
        const osAction = {
          type: 'window.create' as const,
          windowId,
          title: `Browser — ${state.title || domain}`,
          bounds: {
            x: 80 + Number(browserId) * 30,
            y: 60 + Number(browserId) * 30,
            w: 900,
            h: 650,
          },
          content: {
            renderer: 'iframe',
            data: `/api/apps/browser/index.html?browserId=${browserId}`,
          },
        };

        await actionEmitter.emitActionWithFeedback(osAction, 3000);
        console.log(`[browser:open] [browser:${browserId}] → ${state.title || '(no title)'}`);
        return ok(`[browser:${browserId}]\n${formatPageState(state)}`);
      } catch (err) {
        console.error(`[browser:open] Error:`, err);
        return error(`Browser open failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── click ──────────────────────────────────────────────────────────

  server.registerTool(
    'click',
    {
      description:
        'Click an element on the page by CSS selector, visible text, or x/y coordinates. Returns updated page state.',
      inputSchema: {
        selector: z.string().optional().describe('CSS selector of the element to click'),
        text: z
          .string()
          .optional()
          .describe('Visible text of the element to click (for buttons/links)'),
        x: z
          .number()
          .optional()
          .describe('X coordinate to click at (use with y for coordinate-based click)'),
        y: z
          .number()
          .optional()
          .describe('Y coordinate to click at (use with x for coordinate-based click)'),
        index: z
          .number()
          .optional()
          .describe('0-based index when multiple text matches exist (default: 0, first match)'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      if (!args.selector && !args.text && (args.x === undefined || args.y === undefined)) {
        return error('Provide "selector", "text", or both "x" and "y" to identify where to click.');
      }
      const session = resolveSession(args.browserId);
      const state = await session.click(args.selector, args.text, args.x, args.y, args.index);
      return ok(formatPageState(state));
    },
  );

  // ── type ───────────────────────────────────────────────────────────

  server.registerTool(
    'type',
    {
      description: 'Type text into an input field identified by CSS selector.',
      inputSchema: {
        selector: z.string().describe('CSS selector of the input field'),
        text: z.string().describe('Text to type into the field'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.type(args.selector, args.text);
      return ok(`Typed into ${args.selector}\n\n${formatPageState(state)}`);
    },
  );

  // ── press ──────────────────────────────────────────────────────────

  server.registerTool(
    'press',
    {
      description:
        'Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.). Optionally focus an element first by selector. Returns updated page state.',
      inputSchema: {
        key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")'),
        selector: z
          .string()
          .optional()
          .describe('CSS selector of the element to focus before pressing the key'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.press(args.key, args.selector);
      return ok(formatPageState(state));
    },
  );

  // ── scroll ─────────────────────────────────────────────────────────

  server.registerTool(
    'scroll',
    {
      description: 'Scroll the page up or down. Returns updated page state.',
      inputSchema: {
        direction: z.enum(['up', 'down']).describe('Scroll direction'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.scroll(args.direction);
      return ok(formatPageState(state));
    },
  );

  // ── screenshot ─────────────────────────────────────────────────────

  server.registerTool(
    'screenshot',
    {
      description:
        'Get the current page screenshot as an image. Optionally specify a region to magnify (4x zoom) for closer inspection of small elements.',
      inputSchema: {
        x0: z.number().optional().describe('Left edge of the region in pixels'),
        y0: z.number().optional().describe('Top edge of the region in pixels'),
        x1: z.number().optional().describe('Right edge of the region in pixels'),
        y1: z.number().optional().describe('Bottom edge of the region in pixels'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const hasRegion =
        args.x0 !== undefined &&
        args.y0 !== undefined &&
        args.x1 !== undefined &&
        args.y1 !== undefined;
      const clip = hasRegion
        ? { x: args.x0!, y: args.y0!, width: args.x1! - args.x0!, height: args.y1! - args.y0! }
        : undefined;
      const buffer = await session.screenshot(clip ? { clip } : undefined);
      const label = clip
        ? `Magnified region (${args.x0},${args.y0})→(${args.x1},${args.y1}) @4x:`
        : 'Current browser screenshot:';
      return okWithImages(label, [{ data: buffer.toString('base64'), mimeType: 'image/webp' }]);
    },
  );

  // ── extract ────────────────────────────────────────────────────────

  server.registerTool(
    'extract',
    {
      description:
        'Extract structured content from the page: full text, links, and form fields. Optionally scope to a CSS selector.',
      inputSchema: {
        selector: z
          .string()
          .optional()
          .describe('Optional CSS selector to scope extraction (default: entire page)'),
        maxLinks: z.number().optional().describe('Max links to return (default: 50)'),
        maxTextLength: z.number().optional().describe('Max text length (default: 3000)'),
        mainContentOnly: z
          .boolean()
          .optional()
          .describe('Extract only from the largest text-containing block element'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const effectiveSelector =
        args.mainContentOnly && !args.selector ? await findMainContent(session) : args.selector;
      const content = await session.extractContent(effectiveSelector);

      const maxText = args.maxTextLength ?? 3000;
      const maxLinks = args.maxLinks ?? 50;

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
    },
  );

  // ── navigate (history) ────────────────────────────────────────────

  server.registerTool(
    'navigate',
    {
      description: 'Navigate browser history back or forward. Returns updated page state.',
      inputSchema: {
        direction: z.enum(['back', 'forward']).describe('Direction to navigate in browser history'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.navigateHistory(args.direction);
      return ok(formatPageState(state));
    },
  );

  // ── hover ───────────────────────────────────────────────────────────

  server.registerTool(
    'hover',
    {
      description:
        'Hover over an element by CSS selector, visible text, or x/y coordinates. Returns updated page state with screenshot.',
      inputSchema: {
        selector: z.string().optional().describe('CSS selector of the element to hover'),
        text: z.string().optional().describe('Visible text of the element to hover'),
        x: z
          .number()
          .optional()
          .describe('X coordinate to hover at (use with y for coordinate-based hover)'),
        y: z
          .number()
          .optional()
          .describe('Y coordinate to hover at (use with x for coordinate-based hover)'),
        index: z
          .number()
          .optional()
          .describe('0-based index when multiple text matches exist (default: 0, first match)'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      if (!args.selector && !args.text && (args.x === undefined || args.y === undefined)) {
        return error('Provide "selector", "text", or both "x" and "y" to identify where to hover.');
      }
      const session = resolveSession(args.browserId);
      const state = await session.hover(args);
      return ok(formatPageState(state));
    },
  );

  // ── wait_for ────────────────────────────────────────────────────────

  server.registerTool(
    'wait_for',
    {
      description:
        'Wait for an element matching a CSS selector to appear on the page. Polls every 250ms. Returns page state when found.',
      inputSchema: {
        selector: z.string().describe('CSS selector to wait for'),
        timeout: z
          .number()
          .optional()
          .describe('Max time to wait in milliseconds (default: 10000)'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.waitForSelector(args.selector, args.timeout);
      return ok(formatPageState(state));
    },
  );

  // ── list ───────────────────────────────────────────────────────────

  server.registerTool(
    'list',
    {
      description: 'List all open browsers with their IDs, URLs, and titles.',
      inputSchema: {},
    },
    async () => {
      const browsers = pool.getAllSessions();
      if (browsers.size === 0) return ok('No browsers open.');
      const lines = [...browsers.entries()].map(
        ([bid, s]) => `[browser:${bid}] ${s.currentUrl} — ${s.currentTitle || '(no title)'}`,
      );
      return ok(lines.join('\n'));
    },
  );

  // ── close ──────────────────────────────────────────────────────────

  server.registerTool(
    'close',
    {
      description:
        'Close a browser and its window. If browserId is given, closes that browser. If omitted and exactly one browser is open, closes it. If multiple are open and no browserId is given, closes all.',
      inputSchema: {
        browserId: z
          .string()
          .optional()
          .describe('Browser ID to close. If omitted, closes the only browser or all browsers.'),
      },
    },
    async (args) => {
      const browsers = pool.getAllSessions();

      if (browsers.size === 0) return ok('No browser to close.');

      if (args.browserId !== undefined) {
        const session = pool.getSession(args.browserId);
        if (!session) return ok(`No browser with ID ${args.browserId}.`);
        if (session.windowId) {
          actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
        }
        await pool.closeSession(args.browserId);
        return ok(`Browser ${args.browserId} closed.`);
      }

      if (browsers.size === 1) {
        const [browserId, session] = [...browsers.entries()][0];
        if (session.windowId) {
          actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
        }
        await pool.closeSession(browserId);
        return ok('Browser closed.');
      }

      // Multiple browsers — close all
      const ids = [...browsers.keys()];
      for (const [browserId, session] of browsers) {
        if (session.windowId) {
          actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
        }
        await pool.closeSession(browserId);
      }
      return ok(`All browsers closed (${ids.join(', ')}).`);
    },
  );
}

export const BROWSER_TOOL_NAMES = [
  'mcp__browser__open',
  'mcp__browser__click',
  'mcp__browser__type',
  'mcp__browser__press',
  'mcp__browser__scroll',
  'mcp__browser__screenshot',
  'mcp__browser__extract',
  'mcp__browser__navigate',
  'mcp__browser__hover',
  'mcp__browser__wait_for',
  'mcp__browser__list',
  'mcp__browser__close',
] as const;

/**
 * Get the tool names registered by this module.
 */
export function getBrowserToolNames(): string[] {
  return [...BROWSER_TOOL_NAMES];
}
