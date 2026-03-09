/**
 * MCP browser tools — visible browser automation via CDP.
 * @deprecated Legacy MCP tool registration. Browser availability in domains/browser/availability.ts.
 *
 * The agent controls a headless Chromium browser, screenshots are displayed
 * in a YAAR window via the browser app, and text content is returned to the agent.
 *
 * The browser app iframe subscribes to SSE updates (/api/browser/{browserId}/events)
 * so screenshot refreshes happen automatically — no App Protocol round-trip needed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getBrowserPool } from '../../../lib/browser/index.js';
import { isBrowserAvailable as _isBrowserAvailable } from '../../../features/browser/availability.js';
import { registerOpenTool } from './open.js';
import { registerInteractTools } from './interact.js';
import { registerNavigateTools } from './navigate.js';
import { registerContentTools } from './content.js';
import { registerManageTools } from './manage.js';

/**
 * Whether browser tools were successfully registered (Chrome/Edge was found).
 * @deprecated Import from '../../../features/browser/availability.js' instead.
 */
export const isBrowserAvailable = _isBrowserAvailable;

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

  console.log('[browser] Chrome found — registering browser tools');

  registerOpenTool(server, pool);
  registerInteractTools(server);
  registerNavigateTools(server);
  registerContentTools(server);
  registerManageTools(server, pool);
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
