/**
 * MCP Gateway handlers — expose external MCP server tools via yaar://mcp/ URIs.
 *
 *   list   yaar://mcp                    → list configured servers
 *   list   yaar://mcp/{server}           → list tools on a server
 *   describe yaar://mcp/{server}/{tool}  → tool input schema
 *   invoke yaar://mcp/{server}/{tool}    → call the tool
 *   invoke yaar://mcp                    → manage servers (add/remove/reload/refresh)
 */

import type { ResourceRegistry } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJson, error } from './utils.js';
import { getMcpClientManager } from '../mcp/external/index.js';
import type { McpServerConfig } from '../mcp/external/types.js';

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
        // yaar://mcp/{server} — describe the server
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

    async invoke(
      resolved: ResolvedUri,
      payload?: Record<string, unknown>,
    ): Promise<ReturnType<typeof ok>> {
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

        // Map MCP content to VerbResult content
        // Flatten to text — most MCP tools return text content
        const text = result.content
          .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n');
        return ok(text || '(empty response)');
      } catch (err) {
        return error(err instanceof Error ? err.message : 'Tool call failed');
      }
    },
  });
}
