import { storage } from '@bundled/yaar';
import type { RepoRef } from './types';
import { DEFAULT_REPO, setState } from './store';

const TOKEN_PATH = 'github/token';
const CONFIG_PATH = 'github/config.json';
const CLIENT_ID_PATH = 'github/client_id';

/** Read the OAuth access token from yaar storage (github/token). Returns '' when absent. */
export async function readToken(): Promise<string> {
  try {
    // Force text: extensionless files are served as application/octet-stream, and
    // storage.read()'s auto mode would return a Blob (String(blob) === "[object Blob]").
    const raw = await storage.read(TOKEN_PATH, { as: 'text' });
    if (raw == null) return '';
    return String(raw).trim();
  } catch {
    return '';
  }
}

export async function writeToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) {
    try { await storage.remove(TOKEN_PATH); } catch { /* ignore */ }
  } else {
    await storage.save(TOKEN_PATH, trimmed);
  }
  setState('token', trimmed);
}

/**
 * Read the OAuth App Client ID override (github/client_id). Empty when unset —
 * callers fall back to the built-in client id baked into auth.ts.
 */
export async function readClientId(): Promise<string> {
  try {
    const raw = await storage.read(CLIENT_ID_PATH, { as: 'text' });
    if (raw == null) return '';
    return String(raw).trim();
  } catch {
    return '';
  }
}

export async function writeClientId(clientId: string): Promise<void> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    try { await storage.remove(CLIENT_ID_PATH); } catch { /* ignore */ }
  } else {
    await storage.save(CLIENT_ID_PATH, trimmed);
  }
}

/** Read the active repo from github/config.json, falling back to the default. */
export async function readConfig(): Promise<RepoRef> {
  try {
    const raw = await storage.read(CONFIG_PATH, { as: 'text' });
    if (raw == null) return { ...DEFAULT_REPO };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
    const owner = String((parsed as any)?.owner || '').trim();
    const name = String((parsed as any)?.name || '').trim();
    if (owner && name) return { owner, name };
    return { ...DEFAULT_REPO };
  } catch {
    return { ...DEFAULT_REPO };
  }
}

export async function writeConfig(repo: RepoRef): Promise<void> {
  await storage.save(CONFIG_PATH, JSON.stringify({ owner: repo.owner, name: repo.name }, null, 2));
  setState('repo', { ...repo });
}

async function doBootstrap(): Promise<void> {
  const [token, cfg] = await Promise.all([readToken(), readConfig()]);
  setState('token', token);
  setState('repo', cfg);
  if (token) setState('auth', 'status', 'authed');
}

let bootPromise: Promise<void> | null = null;

/**
 * Load token + config into the store on boot. Idempotent — repeated calls share
 * the same in-flight promise, so it is safe to await from anywhere.
 */
export function bootstrapStorage(): Promise<void> {
  // Never reject: a storage failure must not deadlock every data fetch behind
  // ready(). readToken/readConfig already fall back to sane defaults.
  if (!bootPromise) bootPromise = doBootstrap().catch(() => undefined);
  return bootPromise;
}

/**
 * Resolves once the active repo + token are loaded into the store.
 *
 * Every data fetch must await this before reading `state.repo` / `state.token`,
 * otherwise an early interaction (clicking a nav tab, or an agent driving the
 * app protocol right after the window opens) fetches DEFAULT_REPO unauthenticated
 * and caches the wrong result.
 */
export function ready(): Promise<void> {
  return bootstrapStorage();
}
