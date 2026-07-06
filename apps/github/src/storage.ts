import { storage } from '@bundled/yaar';
import type { RepoRef } from './types';
import { DEFAULT_REPO, setState, state } from './store';

const TOKEN_PATH = 'github/token';
const CONFIG_PATH = 'github/config.json';

/** Read the PAT from yaar storage (github/token). Returns '' when absent. */
export async function readToken(): Promise<string> {
  try {
    const raw = await storage.read(TOKEN_PATH);
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

/** Read the active repo from github/config.json, falling back to the default. */
export async function readConfig(): Promise<RepoRef> {
  try {
    const raw = await storage.read(CONFIG_PATH);
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

/** Load token + config into the store on boot. */
export async function bootstrapStorage(): Promise<void> {
  const [token, cfg] = await Promise.all([readToken(), readConfig()]);
  setState('token', token);
  setState('repo', cfg);
  void state;
}
