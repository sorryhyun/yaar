/**
 * MCP Client Manager — manages connections to external MCP servers.
 *
 * Lazily connects on first use, caches tool lists, and persists
 * config to config/mcp-servers.json.
 *
 * An http server that answers 401 is signed in to with OAuth (`oauth.ts`): the connect
 * fails with a sign-in-required status, `beginAuth` answers the consent URL for the user
 * to open, and the redirect back lands in `completeAuth`.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MAX_REQUEST_DEADLINE_MS } from '../../config.js';
import { configRead, configWrite } from '../../storage/storage-manager.js';
import { consumeOAuthState, McpOAuthProvider } from './oauth.js';
import type {
  McpServerConfig,
  McpServersConfig,
  CachedTool,
  ConnectionState,
  McpServerStatus,
} from './types.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('MCP External');

const CONNECT_TIMEOUT_MS = 30_000;
/**
 * Per-tool-call timeout. The MCP SDK defaults to 60s, which is too strict for
 * slow tools like image generators (e.g. anima routinely takes 60s+ per image).
 * We give tool calls a generous ceiling and reset the clock whenever the server
 * reports progress, so a genuinely-working tool is never aborted mid-flight.
 *
 * The ceiling is the shared request budget, not a number picked here: this call is made
 * while an inbound MCP request is held open, and it used to sit at 300s — past the
 * transport's own idle timeout, so the connection waiting for the answer was already
 * closed 45s before this timer could fire.
 */
const CALL_TIMEOUT_MS = MAX_REQUEST_DEADLINE_MS;
const CONFIG_FILE = 'mcp-servers.json';

class McpClientManager {
  private configs: McpServersConfig = {};
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();
  private states = new Map<string, ConnectionState>();
  private errors = new Map<string, string>();
  private toolCache = new Map<string, CachedTool[]>();
  /** One OAuth provider per http server, kept so a login's PKCE state outlives the request. */
  private oauth = new Map<string, McpOAuthProvider>();
  /** Servers whose last connect or call was refused for want of a sign-in. */
  private authRequired = new Set<string>();

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
      log.warn('invalid mcp-servers.json — using empty config');
      this.configs = {};
    }
    // Loaded up front so `getStatus` (synchronous) can say who is signed in.
    await Promise.all(Object.keys(this.configs).map((name) => this.oauthProvider(name)));
  }

  /**
   * The OAuth provider for an http server, or undefined for stdio / `oauth: false`.
   * Rebuilt when the configured URL or OAuth settings change, so credentials minted for
   * one server are never offered to another.
   */
  private async oauthProvider(name: string): Promise<McpOAuthProvider | undefined> {
    const config = this.configs[name];
    if (config?.type !== 'http' || !config.url || config.oauth === false) {
      this.oauth.delete(name);
      return undefined;
    }
    const options = config.oauth ?? {};
    const existing = this.oauth.get(name);
    if (
      existing?.serverUrl === config.url &&
      JSON.stringify(existing.options) === JSON.stringify(options)
    ) {
      return existing;
    }
    const provider = new McpOAuthProvider(name, config.url, options);
    await provider.load();
    this.oauth.set(name, provider);
    return provider;
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
      const transport = this.createTransport(config, await this.oauthProvider(name));
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
      this.authRequired.delete(name);
      log.info('connected to external server', { server: name });
    } catch (err) {
      const msg =
        err instanceof UnauthorizedError
          ? this.markAuthRequired(name)
          : err instanceof Error
            ? err.message
            : 'Unknown connection error';
      this.states.set(name, 'error');
      this.errors.set(name, msg);
      // Clean up partial state
      this.clients.delete(name);
      this.transports.delete(name);
      throw new Error(`Failed to connect to MCP server "${name}": ${msg}`);
    }
  }

  /** Record that `name` needs a sign-in; answers the message that says how to give one. */
  private markAuthRequired(name: string): string {
    this.authRequired.add(name);
    return (
      `Sign-in required. invoke('yaar://mcp', { action: 'login', name: '${name}' }) answers ` +
      'a URL for the user to open in their browser (MCP Manager has a Sign in button for it).'
    );
  }

  private createTransport(config: McpServerConfig, oauth?: McpOAuthProvider): Transport {
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
        authProvider: oauth,
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
      const result = await client.callTool(
        { name: toolName, arguments: args },
        {
          timeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: CALL_TIMEOUT_MS,
        },
      );
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
      this.errors.set(
        name,
        err instanceof UnauthorizedError
          ? this.markAuthRequired(name)
          : err instanceof Error
            ? err.message
            : 'Tool call failed',
      );
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

  /**
   * Start signing in to an http server: the consent URL for the user to open, or no URL
   * when the tokens held already work.
   *
   * Runs as a fresh connect rather than a bare `auth()`, so discovery starts from the
   * server's own 401 (`WWW-Authenticate: resource_metadata=…`) exactly as a tool call would.
   * The SDK hands the consent URL to the provider and throws `UnauthorizedError`.
   */
  async beginAuth(name: string): Promise<{ authUrl?: string }> {
    if (!this.configs[name]) await this.loadConfig();
    const provider = await this.oauthProvider(name);
    if (!provider) {
      throw new Error(
        `MCP server "${name}" does not use OAuth (only http servers without "oauth": false do).`,
      );
    }
    await this.disconnect(name);
    provider.takeAuthorizationUrl(); // A stale URL from an earlier attempt is not this login's.
    try {
      await this.connect(name);
      return {};
    } catch (err) {
      const authUrl = provider.takeAuthorizationUrl();
      if (authUrl) return { authUrl: authUrl.href };
      throw err;
    }
  }

  /**
   * Finish a sign-in from the redirect's query string. Answers the server's name.
   *
   * The `state` names the server and is spent here, so a replayed callback is refused.
   * The exchange runs through a transport's `finishAuth`, which also checks the `iss`
   * parameter against the issuer recorded at discovery (RFC 9207).
   */
  async completeAuth(params: URLSearchParams): Promise<string> {
    const name = consumeOAuthState(params.get('state') ?? '');
    if (!name) throw new Error('This sign-in link has expired or was already used. Start again.');
    const provider = this.oauth.get(name);
    const config = this.configs[name];
    if (!provider || !config?.url) throw new Error(`MCP server "${name}" is no longer configured.`);

    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
      authProvider: provider,
    });
    await transport.finishAuth(params);
    // The next call connects with the new tokens.
    await this.disconnect(name);
    this.authRequired.delete(name);
    log.info('signed in to external server', { server: name });
    return name;
  }

  /** Forget a server's OAuth credentials and drop its connection. */
  async signOut(name: string): Promise<void> {
    await this.oauth.get(name)?.clear();
    await this.disconnect(name);
    this.authRequired.delete(name);
  }

  /** Disconnect all external MCP servers. */
  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }

  /** OAuth standing: `required` wins over held tokens, which a 401 just proved stale. */
  private authState(name: string): McpServerStatus['auth'] {
    if (this.authRequired.has(name)) return 'required';
    return this.oauth.get(name)?.signedIn ? 'signed_in' : undefined;
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
        auth: this.authState(name),
      };
    }
    return Object.entries(this.configs).map(([n, c]) => ({
      name: n,
      type: c.type,
      state: this.states.get(n) ?? 'disconnected',
      error: this.errors.get(n),
      toolCount: this.toolCache.get(n)?.length,
      auth: this.authState(n),
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
    await this.oauthProvider(name);
  }

  /** Remove a server config at runtime and persist. */
  async removeServer(name: string): Promise<void> {
    await this.signOut(name);
    this.oauth.delete(name);
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
