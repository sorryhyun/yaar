/**
 * Codex authentication helpers.
 *
 * - hasCodexAuth()        — passive filesystem check (env var or auth.json)
 * - invalidateCodexAuth() — clear stale auth.json
 * - checkAndLoginCodex()  — RPC-based auth check + browser OAuth login
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { spawn } from 'child_process';
import type { AppServer } from './app-server.js';
import type { AccountLoginCompletedNotification } from './types.js';

function authJsonPath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

/** Returns true if OPENAI_API_KEY is set or ~/.codex/auth.json exists. */
export function hasCodexAuth(): boolean {
  if (process.env.OPENAI_API_KEY) return true;
  return existsSync(authJsonPath());
}

/**
 * Deletes ~/.codex/auth.json so the next auth check triggers login.
 * No-op if the file doesn't exist.
 */
export function invalidateCodexAuth(): void {
  const path = authJsonPath();
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      console.log('[codex] Removed stale auth.json');
    }
  } catch (err) {
    console.error('[codex] Failed to remove auth.json:', err);
  }
}

/**
 * Open a URL in the user's default browser (cross-platform).
 */
function openUrl(url: string): void {
  const p = platform();
  if (p === 'win32') {
    // Quote the URL so cmd.exe doesn't treat & as a command separator
    spawn('cmd', ['/c', `start "" "${url}"`], { detached: true, stdio: 'ignore' }).unref();
  } else if (p === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * Check auth state via the AppServer's JSON-RPC API and trigger browser OAuth if needed.
 * Returns true if authenticated, false on failure.
 *
 * Flow:
 * 1. account/read → check if already logged in
 * 2. If not → account/login/start → open browser to authUrl
 * 3. Wait for account/login/completed notification (120s timeout)
 */
export async function checkAndLoginCodex(appServer: AppServer): Promise<boolean> {
  try {
    const status = await appServer.accountRead({ refreshToken: false });

    // Already authenticated
    if (status.account !== null) {
      const label = status.account.type === 'chatgpt' ? status.account.email : status.account.type;
      console.log(`[codex] Authenticated as ${label}`);
      return true;
    }

    // No auth required (e.g. OPENAI_API_KEY set externally)
    if (!status.requiresOpenaiAuth) {
      console.log('[codex] No OpenAI auth required');
      return true;
    }

    // Need to login — initiate ChatGPT OAuth
    console.log('[codex] No authentication found, initiating browser login...');
    const loginResponse = await appServer.accountLoginStart({ type: 'chatgpt' });

    if (loginResponse.type !== 'chatgpt') {
      console.error('[codex] Unexpected login response type:', loginResponse.type);
      return false;
    }

    const { authUrl, loginId } = loginResponse;
    console.log(`[codex] Opening browser for OAuth login...`);
    openUrl(authUrl);

    // Wait for the login completion notification
    const result = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        appServer.off('notification', handler);
        console.error('[codex] Login timed out after 120s');
        // Cancel the pending login
        appServer.accountLoginCancel({ loginId }).catch(() => {});
        resolve(false);
      }, 120_000);

      const handler = (method: string, params: unknown) => {
        if (method === 'account/login/completed') {
          const notification = params as AccountLoginCompletedNotification;
          // Match by loginId if present, or accept null (legacy)
          if (notification.loginId === null || notification.loginId === loginId) {
            clearTimeout(timeout);
            appServer.off('notification', handler);
            if (notification.success) {
              console.log('[codex] Browser login successful');
            } else {
              console.error('[codex] Browser login failed:', notification.error);
            }
            resolve(notification.success);
          }
        }
      };

      appServer.on('notification', handler);
    });

    return result;
  } catch (err) {
    console.error('[codex] Auth check failed:', err);
    return false;
  }
}
