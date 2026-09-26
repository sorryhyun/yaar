/**
 * Shared MCP tool-result → text formatting.
 *
 * Both providers bridge an MCP `CallToolResult` (`content` blocks, optionally
 * `structuredContent`, optionally `isError`) into `StreamMessage.content`, a
 * plain string. That degradation is deliberate — never a raw `JSON.stringify`
 * dump of the whole result — and used to be written twice, once per provider,
 * which had let it drift: no separator between joined blocks on one side, no
 * `isError` prefix, an unrecognized block type silently dropped instead of
 * surfaced. This is the one place the policy lives now.
 */

/** The MCP-shaped fields both providers' tool-result mappers need to format. */
export interface McpResultLike {
  /** A plain string (Claude's tool_result blocks), an array of content blocks, or absent. */
  content?: unknown;
  /** MCP's structured-output companion to `content` — used only when `content` yields nothing. */
  structuredContent?: unknown;
  /** MCP's own error flag, distinct from a transport-level failure the caller reports separately. */
  isError?: boolean;
}

/**
 * Format a single MCP content block as text.
 *
 * Binary-carrying blocks (`image`, `audio`, a blob `resource`) become a short
 * marker instead of their base64 payload — this channel is the transcript/UI
 * one, and the model gets the real bytes through its own tool-result path.
 * `resource`/`resource_link` surface their text or URI. Only a genuinely
 * unknown shape falls back to stringification. Returns `''` for a block that
 * contributes nothing (e.g. an explicit empty-string text block); the caller
 * filters those out before joining.
 */
export function formatMcpContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return String(JSON.stringify(block));

  const b = block as Record<string, unknown>;
  const type = typeof b.type === 'string' ? b.type : undefined;

  // Plain text (either an explicit text block or a bare { text } shape).
  if (typeof b.text === 'string' && (type === undefined || type === 'text')) {
    return b.text;
  }

  switch (type) {
    case 'image':
      return '[image omitted]';
    case 'audio':
      return '[audio omitted]';
    case 'resource': {
      const res = (b.resource ?? {}) as { text?: unknown; uri?: unknown };
      if (typeof res.text === 'string') return res.text;
      if (typeof res.uri === 'string') return `[resource: ${res.uri}]`;
      return '[resource omitted]';
    }
    case 'resource_link': {
      const uri = typeof b.uri === 'string' ? b.uri : '';
      const name = typeof b.name === 'string' ? b.name : 'link';
      return `[${name}](${uri})`;
    }
    default:
      return JSON.stringify(block);
  }
}

/**
 * Format an MCP tool result into the string a `tool_result` `StreamMessage`
 * carries. The caller emits that message whether or not this produces
 * readable text — an image-only result (`previewScreenshot`, every
 * window/browser capture) still degrades to a `[image omitted]` marker, not
 * nothing, and a result with no blocks at all degrades to `'Tool completed'`
 * rather than an empty string a UI would render as "did nothing".
 *
 * Priority: a plain string `content` wins outright (Claude's tool_result
 * blocks carry one directly, and it may legitimately be empty); otherwise
 * content blocks are joined with `\n`; otherwise `structuredContent`, stringified;
 * otherwise the `'Tool completed'` default. `isError` prefixes whichever of
 * the first two branches produced the text — never the structured/default
 * fallback, which is not the tool's own words to begin with.
 */
export function formatMcpResult(result: McpResultLike | undefined | null): string {
  if (!result) return 'Tool completed';

  const { content, structuredContent, isError } = result;

  if (typeof content === 'string') {
    return isError ? `Error: ${content}` : content;
  }

  if (Array.isArray(content) && content.length > 0) {
    const parts = content.map(formatMcpContentBlock).filter(Boolean);
    if (parts.length > 0) {
      const body = parts.join('\n');
      return isError ? `Error: ${body}` : body;
    }
  }

  if (structuredContent != null) {
    return JSON.stringify(structuredContent, null, 2);
  }

  return 'Tool completed';
}
