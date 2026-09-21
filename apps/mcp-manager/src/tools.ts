// Tool-list parsing, shared by the two boundaries that produce one.
//
// A remote server's `tools/list` RPC result and the gateway's
// `list('yaar://mcp/{name}')` carry the same payload. One parser means one answer
// to "what happens to a malformed row".
import { safeParseOr } from '@bundled/yaar';
import { logError } from './log';
import { McpToolInfo, McpToolListEnvelope } from './schema';
import type { McpTool } from './types';

/**
 * Validate a tool-list envelope and its rows.
 *
 * `label` names the source in log lines (a URL, or `server "foo"`). A malformed
 * *envelope* throws — the caller cannot show a meaningful list and should say
 * so — while a malformed *row* is dropped and logged, so one odd tool costs
 * that tool rather than the whole list.
 */
export function parseToolList(raw: unknown, label: string): McpTool[] {
  const envelope = safeParseOr(McpToolListEnvelope, raw, undefined, {
    onInvalid: (issues) => {
      logError(`tool list from ${label} failed validation`, issues);
      throw new Error('Malformed MCP tool list');
    },
  });

  const tools: McpTool[] = [];
  for (const entry of envelope?.tools ?? []) {
    const row = safeParseOr(McpToolInfo, entry, undefined, {
      label: `mcp:tool-entry:${label}`,
    });
    if (!row) continue;
    tools.push({ name: row.name, description: row.description });
  }
  return tools;
}