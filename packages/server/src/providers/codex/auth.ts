/**
 * Codex authentication helpers.
 *
 * - hasCodexAuth()        — passive filesystem check (env var or auth.json)
 * - invalidateCodexAuth() — clear stale auth.json
 * - checkAndLoginCodex()  — RPC-based auth check + browser OAuth login
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { openUrl } from '../../lib/open-url.js';
import type { AppServer } from './app-server.js';
import type { AccountLoginCompletedNotification } from './types.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('codex:auth');

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
      log.info('removed stale auth.json');
    }
  } catch (err) {
    log.error('failed to remove auth.json', { err });
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
      // The account label (an email, for a ChatGPT login) is kept: this is the user's own
      // machine and their own account, and "authenticated" without saying *as whom* is the
      // one thing that makes a wrong-account session impossible to diagnose.
      log.info('authenticated', { account: label });
      return true;
    }

    // No auth required (e.g. OPENAI_API_KEY set externally)
    if (!status.requiresOpenaiAuth) {
      log.info('no OpenAI auth required');
      return true;
    }

    // Need to login — initiate ChatGPT OAuth
    log.info('no authentication found, initiating browser login');
    const loginResponse = await appServer.accountLoginStart({ type: 'chatgpt' });

    if (loginResponse.type !== 'chatgpt') {
      log.error('unexpected login response type', { type: loginResponse.type });
      return false;
    }

    const { authUrl, loginId } = loginResponse;
    log.info('opening browser for OAuth login');
    openUrl(authUrl);

    // Wait for the login completion notification
    const result = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        appServer.off('notification', handler);
        log.error('login timed out', { waitedMs: 120_000 });
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
              log.info('browser login successful');
            } else {
              log.error('browser login failed', { err: notification.error });
            }
            resolve(notification.success);
          }
        }
      };

      appServer.on('notification', handler);
    });

    return result;
  } catch (err) {
    log.error('auth check failed', { err });
    return false;
  }
}
