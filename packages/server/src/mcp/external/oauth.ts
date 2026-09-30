/**
 * OAuth for external MCP servers — YAAR as the *client*.
 *
 * The SDK runs the whole MCP authorization flow (RFC 9728 resource discovery, AS metadata,
 * dynamic client registration, PKCE, refresh, RFC 9207 issuer checks) through `auth()` and
 * the transport's `authProvider`. What it cannot do is keep state or send a human to a
 * consent screen, so that is all this file is:
 *
 *   - **Durable state** in `config/credentials/mcp/{server}.json` (0600): the registered
 *     client, the tokens, and the discovery state. Bound to the server URL it was minted
 *     for — change the URL in config and the old credentials are ignored, never sent.
 *   - **The consent URL** is *captured*, not opened. `redirectToAuthorization` stores it and
 *     `beginAuth` (client-manager) answers it to whoever asked — the mcp-manager app opens
 *     it in the user's browser, an agent hands it to the user. Same reason as Google
 *     sign-in (`features/market/google-auth.ts`): the server may run where the user isn't.
 *   - **The redirect** lands on this server, `/api/auth/mcp/callback`, over loopback
 *     (RFC 8252 §7.3) — the same no-second-listener trick as Google sign-in. The `state`
 *     parameter maps the callback back to its server and is single-use.
 *
 * Pending logins (state + PKCE verifier) are memory-only: a restart mid-consent means
 * pressing Sign in again, which is the right answer for a half-finished login anyway.
 *
 * Not yet here, on purpose: a client ID metadata document (CIMD needs an HTTPS URL YAAR
 * cannot serve from loopback), and a redirect base for REMOTE mode. `redirectBase()` is
 * the one place the latter would change.
 */

import { join, dirname } from 'path';
import { mkdir, readFile, writeFile, unlink, chmod } from 'fs/promises';
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { getConfigDir, getPort } from '../../config.js';
import type { McpOAuthConfig } from './types.js';

/** Path of the OAuth callback on this server. Exempted from remote auth in `http/auth.ts`. */
export const MCP_OAUTH_CALLBACK_PATH = '/api/auth/mcp/callback';

/** How long an unfinished login stays claimable before its state is swept. */
const LOGIN_TTL_MS = 10 * 60_000;

/** What is persisted per server. Everything but `serverUrl` is the SDK's own shape. */
interface StoredMcpCredentials {
  /** The URL these were minted for. A mismatch means the config moved; nothing is sent. */
  serverUrl: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  updatedAt: string;
}

/** Callback `state` → the server whose login it finishes. Single-use, swept after the TTL. */
const pendingStates = new Map<string, { server: string; createdAt: number }>();

function sweepPendingStates(): void {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > LOGIN_TTL_MS) pendingStates.delete(state);
  }
}

/** Claim a callback's `state`: the server it belongs to, or null (unknown, spent, expired). */
export function consumeOAuthState(state: string): string | null {
  sweepPendingStates();
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  return entry.server;
}

function redirectBase(): string {
  // 127.0.0.1, not localhost: loopback redirects are matched by literal host, and this is
  // the form RFC 8252 recommends. The user's browser is on this machine in local mode.
  return `http://127.0.0.1:${getPort()}`;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** A filename for a server name the user typed: nothing that can leave the directory. */
function credentialsFile(server: string): string {
  return join(getConfigDir(), 'credentials', 'mcp', `${encodeURIComponent(server)}.json`);
}

/** `"$NAME"` resolves from the environment, so a client secret need not sit in config. */
function resolveSecret(value: string | undefined): string | undefined {
  if (value === undefined || !value.startsWith('$')) return value;
  return process.env[value.slice(1)] || undefined;
}

/**
 * One external server's OAuth state, in the shape the SDK asks for.
 *
 * One instance per configured server, kept for the manager's lifetime so the PKCE
 * verifier and the captured consent URL survive between `beginAuth` and the callback.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private stored: StoredMcpCredentials | null = null;
  private verifier: string | undefined;
  /** Set by `redirectToAuthorization`; read and cleared by `takeAuthorizationUrl`. */
  private authorizationUrl: URL | undefined;

  constructor(
    readonly server: string,
    readonly serverUrl: string,
    readonly options: McpOAuthConfig = {},
  ) {}

  /** Read the persisted credentials. Call once before handing the provider to a transport. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(credentialsFile(this.server), 'utf-8'),
      ) as StoredMcpCredentials;
      this.stored = parsed.serverUrl === this.serverUrl ? parsed : null;
    } catch {
      this.stored = null; // Never signed in, or the file was removed by hand.
    }
  }

  /** Holds tokens — not a promise they are still valid, only that there is something to send. */
  get signedIn(): boolean {
    return !!this.stored?.tokens?.access_token;
  }

  get scope(): string | undefined {
    return this.options.scope;
  }

  /** The consent URL the last `auth()` produced, once. */
  takeAuthorizationUrl(): URL | undefined {
    const url = this.authorizationUrl;
    this.authorizationUrl = undefined;
    return url;
  }

  /** Forget everything held for this server, on disk and in memory. */
  async clear(): Promise<void> {
    await unlink(credentialsFile(this.server)).catch(() => {});
    this.stored = null;
    this.verifier = undefined;
    this.authorizationUrl = undefined;
  }

  private async persist(patch: Partial<StoredMcpCredentials>): Promise<void> {
    const next: StoredMcpCredentials = {
      ...(this.stored ?? { serverUrl: this.serverUrl }),
      ...patch,
      serverUrl: this.serverUrl,
      updatedAt: new Date().toISOString(),
    };
    const path = credentialsFile(this.server);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    // writeFile's mode only applies on create; an existing file keeps its old bits.
    await chmod(path, 0o600).catch(() => {}); // No-op on Windows.
    this.stored = next;
  }

  // ── OAuthClientProvider ──

  get redirectUrl(): string {
    return `${redirectBase()}${MCP_OAUTH_CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'YAAR',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.options.clientSecret ? 'client_secret_post' : 'none',
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  state(): string {
    sweepPendingStates();
    const state = randomToken();
    pendingStates.set(state, { server: this.server, createdAt: Date.now() });
    return state;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    // A pre-registered client (config `oauth.clientId`) wins over a dynamic registration:
    // it is how a server that refuses DCR is reached at all.
    if (this.options.clientId) {
      const secret = resolveSecret(this.options.clientSecret);
      return { client_id: this.options.clientId, ...(secret ? { client_secret: secret } : {}) };
    }
    return this.stored?.client;
  }

  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    await this.persist({ client });
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.stored?.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.persist({ tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error('No sign-in is in progress for this server (was YAAR restarted?)');
    }
    return this.verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.persist({ discovery });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored?.discovery;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all') return this.clear();
    if (scope === 'verifier') {
      this.verifier = undefined;
      return;
    }
    const key = ({ client: 'client', tokens: 'tokens', discovery: 'discovery' } as const)[scope];
    if (this.stored?.[key] !== undefined) await this.persist({ [key]: undefined });
  }
}
