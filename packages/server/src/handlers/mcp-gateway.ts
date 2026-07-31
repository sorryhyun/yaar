/**
 * MCP Gateway handlers — expose external MCP server tools via yaar://mcp/ URIs.
 *
 *   list   yaar://mcp                    → list configured servers
 *   list   yaar://mcp/{server}           → list tools on a server
 *   describe yaar://mcp/{server}/{tool}  → tool input schema
 *   invoke yaar://mcp/{server}/{tool}    → call the tool
 *   invoke yaar://mcp                    → manage servers (add/remove/reload/refresh)
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJson, error } from './utils.js';
import { getMcpClientManager } from '../mcp/external/index.js';
import type { McpServerConfig } from '../mcp/external/types.js';
import { storageWrite } from '../storage/index.js';
import { genStamp } from '../lib/ids.js';

/** File extension for a persisted image, derived from its MIME type. */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/** Filesystem-safe slug for use in a generated filename. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Persist any image content blocks returned by an external MCP tool into
 * `storage/generated/` so the calling agent gets a durable `yaar://storage/...`
 * URI it can drop into an iframe window — rather than a base64 blob it cannot
 * render (and which, as text, the CLI truncates to a file). The image blocks are
 * kept inline too, so the agent still *sees* what the tool produced.
 *
 * Returns extra text content blocks (one per saved image, plus a display hint),
 * or an empty array if there were no images / all writes failed.
 */
async function persistImageBlocks(
  server: string,
  tool: string,
  content: Array<{ type: string; data?: string; mimeType?: string }>,
): Promise<Array<{ type: 'text'; text: string }>> {
  const images = content.filter((c) => c.type === 'image' && c.data);
  if (images.length === 0) return [];

  const stamp = genStamp(6);
  const saved: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = IMAGE_EXT[(img.mimeType ?? '').toLowerCase()] ?? 'png';
    const suffix = images.length > 1 ? `-${i}` : '';
    const path = `generated/${slug(server)}-${slug(tool)}-${stamp}${suffix}.${ext}`;
    try {
      const buf = Buffer.from(img.data!, 'base64');
      const res = await storageWrite(path, buf);
      if (res.success) saved.push(path);
    } catch {
      // Best-effort — a failed persist just means no durable URI for this image.
    }
  }

  if (saved.length === 0) return [];
  const uris = saved.map((p) => `yaar://storage/${p}`);
  const hint =
    uris.length === 1
      ? `Saved the image to ${uris[0]}. To display it, create an iframe window with content="${uris[0]}".`
      : `Saved the images to:\n${uris.map((u) => `- ${u}`).join('\n')}\nTo display one, create an iframe window with content="<uri>".`;
  return [{ type: 'text' as const, text: hint }];
}

/** Parse yaar://mcp/{server}/{tool} from a raw URI string. */
function parseMcpUri(uri: string): { serverName: string; toolName?: string } | null {
  const match = uri.match(/^yaar:\/\/mcp\/([^/]+)(?:\/(.+))?$/);
  if (!match) return null;
  return { serverName: match[1], toolName: match[2] };
}

export function registerMcpGatewayHandlers(registry: ResourceRegistry): void {
  // ── yaar://mcp — list all servers, manage config ──
  registry.register('yaar://mcp', {
    description:
      'External MCP server gateway. List configured servers or manage them (add/remove/reload/refresh).',
    verbs: ['describe', 'list', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'reload', 'refresh'],
          description:
            'add: register a new server, remove: unregister a server, reload: re-read config file, refresh: force-refresh tool cache for a server',
        },
        name: { type: 'string', description: 'Server name (required for add/remove/refresh)' },
        config: {
          type: 'object',
          description: 'Server config (required for add)',
          properties: {
            type: { type: 'string', enum: ['stdio', 'http'] },
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            env: { type: 'object' },
            cwd: { type: 'string' },
            url: { type: 'string' },
            headers: { type: 'object' },
          },
        },
      },
      required: ['action'],
    },

    async list(): Promise<ReturnType<typeof okJson>> {
      const manager = await getMcpClientManager();
      const servers = manager.getStatus() as Array<{
        name: string;
        type: string;
        state: string;
        error?: string;
        toolCount?: number;
      }>;
      return okJson({ servers });
    },

    async invoke(
      _resolved: ResolvedUri,
      payload?: Record<string, unknown>,
    ): Promise<ReturnType<typeof ok>> {
      if (!payload?.action) return error('Missing "action" field');
      const action = payload.action as string;
      const name = payload.name as string | undefined;
      const manager = await getMcpClientManager();

      switch (action) {
        case 'add': {
          if (!name) return error('Missing "name" for add action');
          const config = payload.config as McpServerConfig | undefined;
          if (!config?.type) return error('Missing "config" with "type" field for add action');
          await manager.addServer(name, config);
          return ok(`Server "${name}" added.`);
        }
        case 'remove': {
          if (!name) return error('Missing "name" for remove action');
          await manager.removeServer(name);
          return ok(`Server "${name}" removed.`);
        }
        case 'reload': {
          await manager.loadConfig();
          const servers = manager.getConfiguredServers();
          return ok(`Config reloaded. ${servers.length} server(s) configured.`);
        }
        case 'refresh': {
          if (!name) return error('Missing "name" for refresh action');
          const tools = await manager.listTools(name, true);
          return ok(`Refreshed "${name}": ${tools.length} tool(s).`);
        }
        default:
          return error(`Unknown action "${action}". Use: add, remove, reload, refresh.`);
      }
    },
  });

  // ── yaar://mcp/* — server tools ──
  registry.register('yaar://mcp/*', {
    description:
      'Access an external MCP server. ' +
      'list yaar://mcp/{server} for tools, ' +
      'describe yaar://mcp/{server}/{tool} for schema, ' +
      'invoke yaar://mcp/{server}/{tool} to call it.',
    verbs: ['describe', 'list', 'invoke'],
    invokeSchema: {
      type: 'object',
      description: 'Tool-specific input arguments (see describe for schema)',
      additionalProperties: true,
    },

    async list(resolved: ResolvedUri): Promise<ReturnType<typeof okJson>> {
      const parsed = parseMcpUri(resolved.sourceUri);
      if (!parsed) return error('Invalid MCP URI');

      const manager = await getMcpClientManager();

      if (parsed.toolName) {
        // yaar://mcp/{server}/{tool} — no children to list
        return okJson({ tools: [] });
      }

      // yaar://mcp/{server} — list tools
      try {
        const tools = await manager.listTools(parsed.serverName);
        return okJson({
          server: parsed.serverName,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : 'Failed to list tools');
      }
    },

    async describe(resolved: ResolvedUri): Promise<ReturnType<typeof okJson>> {
      const parsed = parseMcpUri(resolved.sourceUri);
      if (!parsed) return error('Invalid MCP URI');

      const manager = await getMcpClientManager();

      if (!parsed.toolName) {
        // yaar://mcp/{server} — describe the server.
        //
        // Guarded here rather than in `getStatus`, whose "fill in the blanks" shape the
        // list path relies on: asked about a name it has never seen, it fabricates
        // `{ state: 'disconnected' }`, so describing a server nobody configured used to
        // read as a plausible success — a configured server that happens to be down.
        if (!manager.getConfiguredServers().includes(parsed.serverName)) {
          const configured = manager.getConfiguredServers();
          return error(
            `No MCP server "${parsed.serverName}" is configured. ` +
              (configured.length
                ? `Configured: ${configured.join(', ')}.`
                : 'None are configured — add one with invoke("yaar://mcp", { action: "add", … }).'),
          );
        }
        const status = manager.getStatus(parsed.serverName) as {
          name: string;
          type: string;
          state: string;
          error?: string;
          toolCount?: number;
        };
        return okJson({
          ...status,
          verbs: ['list', 'describe', 'invoke'],
          description: `External MCP server "${parsed.serverName}". Use list to see available tools.`,
        });
      }

      // yaar://mcp/{server}/{tool} — describe the tool
      try {
        const tools = await manager.listTools(parsed.serverName);
        const tool = tools.find((t) => t.name === parsed.toolName);
        if (!tool)
          return error(`Tool "${parsed.toolName}" not found on server "${parsed.serverName}"`);
        return okJson({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          verbs: ['describe', 'invoke'],
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : 'Failed to describe tool');
      }
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const parsed = parseMcpUri(resolved.sourceUri);
      if (!parsed) return error('Invalid MCP URI');
      if (!parsed.toolName) return error('Specify a tool name: yaar://mcp/{server}/{tool}');

      const manager = await getMcpClientManager();

      try {
        const result = await manager.callTool(parsed.serverName, parsed.toolName, payload ?? {});

        if (result.isError) {
          const text = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          return error(text || 'Tool returned an error');
        }

        // Map MCP content to VerbResult content. Preserve text AND image blocks
        // so tools that return images (e.g. an image generator) reach the agent
        // as real images, not a stringified base64 blob. Other block types
        // (embedded resources, etc.) fall back to a text representation.
        const content = result.content.map((c) => {
          if (c.type === 'text') return { type: 'text' as const, text: c.text ?? '' };
          if (c.type === 'image' && c.data && c.mimeType)
            return { type: 'image' as const, data: c.data, mimeType: c.mimeType };
          return { type: 'text' as const, text: JSON.stringify(c) };
        });

        // Persist returned images to storage and append their yaar:// URIs, so the
        // agent has a durable, renderable handle (not just an inline blob).
        const pointers = await persistImageBlocks(parsed.serverName, parsed.toolName, content);
        content.push(...pointers);

        return content.length ? { content } : ok('(empty response)');
      } catch (err) {
        return error(err instanceof Error ? err.message : 'Tool call failed');
      }
    },
  });
}
