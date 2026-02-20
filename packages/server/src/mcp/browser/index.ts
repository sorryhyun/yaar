/**
 * MCP browser tools — visible browser automation via CDP.
 *
 * The agent controls a headless Chromium browser, screenshots are displayed
 * in a YAAR window via the browser app, and text content is returned to the agent.
 *
 * The browser app iframe subscribes to SSE updates (/api/browser/{sessionId}/events)
 * so screenshot refreshes happen automatically — no App Protocol round-trip needed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBrowserPool } from '../../lib/browser/index.js';
import type { BrowserSession, PageState } from '../../lib/browser/index.js';
import { actionEmitter } from '../action-emitter.js';
import { getAgentId } from '../../agents/session.js';
import { getSessionHub } from '../../session/live-session.js';
import { isDomainAllowed, extractDomain } from '../domains.js';
import { ok, okWithImages, error } from '../utils.js';

function getSessionId(): string {
  // Prefer agent-specific ID (Claude sets X-Agent-Id header), fall back to LiveSession ID
  const agentId = getAgentId();
  if (agentId) return agentId;
  const session = getSessionHub().getDefault();
  if (!session) throw new Error('No active session — connect via WebSocket first.');
  return session.sessionId;
}

function getSession(): BrowserSession {
  const id = getSessionId();
  const session = getBrowserPool().getSession(id);
  if (!session) throw new Error('No browser session open. Use browser:open first.');
  return session;
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

/**
 * Update the window title bar to reflect the current browser state.
 * Screenshot updates are handled by the SSE stream (browser app subscribes
 * to /api/browser/{sessionId}/events).
 */
function updateWindowTitle(session: BrowserSession, title: string): void {
  if (!session.windowId) return;
  actionEmitter.emitAction({
    type: 'window.setTitle',
    windowId: session.windowId,
    title: `Browser — ${title}`,
  });
}

/** Heuristic: find the CSS selector for the largest text-containing block element. */
async function findMainContent(session: BrowserSession): Promise<string | undefined> {
  return session.findMainContentSelector();
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

  // ── open ────────────────────────────────────────────────────────────

  server.registerTool(
    'open',
    {
      description:
        'Open a URL in a visible browser. Creates a browser window on the desktop. Returns page title, URL, and text content.',
      inputSchema: {
        url: z.string().url().describe('The URL to navigate to'),
      },
    },
    async (args) => {
      const domain = extractDomain(args.url);
      if (!domain) return error('Invalid URL');

      if (!(await isDomainAllowed(domain))) {
        return error(`Domain "${domain}" not allowed. Use request_allowing_domain first.`);
      }

      const sessionId = getSessionId();
      let session = pool.getSession(sessionId);

      if (!session) {
        // Create new session + window
        session = await pool.createSession(sessionId);
        const windowId = `browser-${sessionId.slice(0, 8)}`;
        session.windowId = windowId;

        // Navigate first so we have a screenshot before showing the window
        const state = await session.navigate(args.url);

        // Create YAAR window with browser app iframe
        const osAction = {
          type: 'window.create' as const,
          windowId,
          title: `Browser — ${state.title || domain}`,
          bounds: { x: 80, y: 60, w: 900, h: 650 },
          content: {
            renderer: 'iframe',
            data: `/api/apps/browser/static/index.html?sessionId=${sessionId}`,
          },
        };

        await actionEmitter.emitActionWithFeedback(osAction, 3000);
        // The browser app subscribes to SSE (/api/browser/{sessionId}/events)
        // which pushes the initial state + subsequent updates automatically.

        return ok(formatPageState(state));
      }

      // Existing session — just navigate
      const state = await session.navigate(args.url);
      updateWindowTitle(session, state.title || domain);
      return ok(formatPageState(state));
    },
  );

  // ── click ──────────────────────────────────────────────────────────

  server.registerTool(
    'click',
    {
      description:
        'Click an element on the page by CSS selector or visible text. Returns updated page state.',
      inputSchema: {
        selector: z.string().optional().describe('CSS selector of the element to click'),
        text: z
          .string()
          .optional()
          .describe('Visible text of the element to click (for buttons/links)'),
      },
    },
    async (args) => {
      if (!args.selector && !args.text) {
        return error('Provide either "selector" or "text" to identify the element to click.');
      }
      const session = getSession();
      const state = await session.click(args.selector, args.text);
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
      },
    },
    async (args) => {
      const session = getSession();
      const state = await session.type(args.selector, args.text);
      return ok(`Typed into ${args.selector}\n\n${formatPageState(state)}`);
    },
  );

  // ── press ──────────────────────────────────────────────────────────

  server.registerTool(
    'press',
    {
      description:
        'Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.). Returns updated page state.',
      inputSchema: {
        key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")'),
      },
    },
    async (args) => {
      const session = getSession();
      const state = await session.press(args.key);
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
      },
    },
    async (args) => {
      const session = getSession();
      const state = await session.scroll(args.direction);
      return ok(formatPageState(state));
    },
  );

  // ── screenshot ─────────────────────────────────────────────────────

  server.registerTool(
    'screenshot',
    {
      description:
        'Get the current page screenshot as an image. Use when you need to visually inspect the page layout.',
      inputSchema: {},
    },
    async () => {
      const session = getSession();
      const buffer = await session.screenshot();
      return okWithImages('Current browser screenshot:', [
        { data: buffer.toString('base64'), mimeType: 'image/jpeg' },
      ]);
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
      },
    },
    async (args) => {
      const session = getSession();
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

  // ── close ──────────────────────────────────────────────────────────

  server.registerTool(
    'close',
    {
      description: 'Close the browser session and its window. Frees resources.',
      inputSchema: {},
    },
    async () => {
      const sessionId = getSessionId();
      const session = pool.getSession(sessionId);
      if (!session) return ok('No browser session to close.');

      // Close the YAAR window
      if (session.windowId) {
        actionEmitter.emitAction({
          type: 'window.close',
          windowId: session.windowId,
        });
      }

      await pool.closeSession(sessionId);
      return ok('Browser closed.');
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
  'mcp__browser__close',
] as const;

/**
 * Get the tool names registered by this module.
 */
export function getBrowserToolNames(): string[] {
  return [...BROWSER_TOOL_NAMES];
}
