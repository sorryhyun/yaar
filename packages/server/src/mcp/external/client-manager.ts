/**
 * MCP Client Manager — manages connections to external MCP servers.
 *
 * Lazily connects on first use, caches tool lists, and persists
 * config to config/mcp-servers.json.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { configRead, configWrite } from '../../storage/storage-manager.js';
import type {
  McpServerConfig,
  McpServersConfig,
  CachedTool,
  ConnectionState,
  McpServerStatus,
} from './types.js';

const CONNECT_TIMEOUT_MS = 30_000;
const CONFIG_FILE = 'mcp-servers.json';

class McpClientManager {
  private configs: McpServersConfig = {};
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();
  private states = new Map<string, ConnectionState>();
  private errors = new Map<string, string>();
  private toolCache = new Map<string, CachedTool[]>();

  /** Load config from config/mcp-servers.json. */
  async loadConfig(): Promise<void> {
    const result = await configRead(CONFIG_FILE);
    if (!result.success) {
      // File doesn't exist yet — use empty config
      this.configs = {};
      return;
    }
    try {
      const parsed = JSON.parse(result.content!) as McpServersConfig;
      // Disconnect servers that were removed from config
      for (const name of this.clients.keys()) {
        if (!(name in parsed)) {
          await this.disconnect(name);
        }
      }
      this.configs = parsed;
    } catch {
      console.warn('[MCP External] Invalid mcp-servers.json — using empty config');
      this.configs = {};
    }
  }

  /** Resolve env var references: values starting with "$" become process.env lookups. */
  private resolveEnv(env: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value.startsWith('$')) {
        const envKey = value.slice(1);
        resolved[key] = process.env[envKey] ?? '';
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  /** Connect to a specific external MCP server. */
  async connect(name: string): Promise<void> {
    const state = this.states.get(name);
    if (state === 'connected' || state === 'connecting') return;

    const config = this.configs[name];
    if (!config) throw new Error(`MCP server "${name}" not configured`);

    this.states.set(name, 'connecting');
    this.errors.delete(name);

    try {
      const transport = this.createTransport(config);
      const client = new Client({ name: `yaar-${name}`, version: '1.0.0' });

      // Connect with timeout
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timed out')), CONNECT_TIMEOUT_MS),
        ),
      ]);

      this.clients.set(name, client);
      this.transports.set(name, transport);
      this.states.set(name, 'connected');
      console.log(`[MCP External] Connected to "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown connection error';
      this.states.set(name, 'error');
      this.errors.set(name, msg);
      // Clean up partial state
      this.clients.delete(name);
      this.transports.delete(name);
      throw new Error(`Failed to connect to MCP server "${name}": ${msg}`);
    }
  }

  private createTransport(config: McpServerConfig): Transport {
    if (config.type === 'stdio') {
      if (!config.command) throw new Error('stdio transport requires "command"');
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...this.resolveEnv(config.env ?? {}) } as Record<string, string>,
        cwd: config.cwd,
      });
    }

    if (config.type === 'http') {
      if (!config.url) throw new Error('http transport requires "url"');
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }

    throw new Error(`Unsupported transport type: ${config.type}`);
  }

  /** Lazy connect: ensures connection exists, returns client. */
  async ensureConnected(name: string): Promise<Client> {
    if (!this.configs[name]) {
      // Try loading config in case it was added
      await this.loadConfig();
      if (!this.configs[name]) throw new Error(`MCP server "${name}" not configured`);
    }

    const state = this.states.get(name);
    if (state !== 'connected') {
      await this.connect(name);
    }

    const client = this.clients.get(name);
    if (!client) throw new Error(`MCP server "${name}" not connected`);
    return client;
  }

  /** List tools from an external MCP server (cached unless forceRefresh). */
  async listTools(name: string, forceRefresh = false): Promise<CachedTool[]> {
    if (!forceRefresh) {
      const cached = this.toolCache.get(name);
      if (cached) return cached;
    }

    const client = await this.ensureConnected(name);
    const result = await client.listTools();

    const tools: CachedTool[] = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

    this.toolCache.set(name, tools);
    return tools;
  }

  /** Call a tool on an external MCP server. */
  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  }> {
    const client = await this.ensureConnected(name);

    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      return {
        content: (result.content ?? []) as Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
        }>,
        isError: result.isError as boolean | undefined,
      };
    } catch (err) {
      // Transport error — mark as disconnected for retry on next call
      this.states.set(name, 'error');
      this.errors.set(name, err instanceof Error ? err.message : 'Tool call failed');
      this.clients.delete(name);
      this.transports.delete(name);
      throw err;
    }
  }

  /** Disconnect from an external MCP server. */
  async disconnect(name: string): Promise<void> {
    const transport = this.transports.get(name);
    if (transport) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors
      }
    }
    this.clients.delete(name);
    this.transports.delete(name);
    this.toolCache.delete(name);
    this.states.set(name, 'disconnected');
    this.errors.delete(name);
  }

  /** Disconnect all external MCP servers. */
  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }

  /** Get status of one or all servers. */
  getStatus(name?: string): McpServerStatus | McpServerStatus[] {
    if (name) {
      const config = this.configs[name];
      return {
        name,
        type: config?.type ?? 'stdio',
        state: this.states.get(name) ?? 'disconnected',
        error: this.errors.get(name),
        toolCount: this.toolCache.get(name)?.length,
      };
    }
    return Object.entries(this.configs).map(([n, c]) => ({
      name: n,
      type: c.type,
      state: this.states.get(n) ?? 'disconnected',
      error: this.errors.get(n),
      toolCount: this.toolCache.get(n)?.length,
    }));
  }

  /** Get all configured server names. */
  getConfiguredServers(): string[] {
    return Object.keys(this.configs);
  }

  /** Add a server config at runtime and persist. */
  async addServer(name: string, config: McpServerConfig): Promise<void> {
    this.configs[name] = config;
    await this.persistConfig();
  }

  /** Remove a server config at runtime and persist. */
  async removeServer(name: string): Promise<void> {
    await this.disconnect(name);
    delete this.configs[name];
    this.states.delete(name);
    await this.persistConfig();
  }

  private async persistConfig(): Promise<void> {
    await configWrite(CONFIG_FILE, JSON.stringify(this.configs, null, 2));
  }
}

let instance: McpClientManager | null = null;

/** Get the singleton McpClientManager. Loads config on first call. */
export async function getMcpClientManager(): Promise<McpClientManager> {
  if (!instance) {
    instance = new McpClientManager();
    await instance.loadConfig();
  }
  return instance;
}
