/**
 * Environment bootstrap — the one module that reads `.env` into `process.env`.
 *
 * Every other module under `config/` imports from here, so `loadRootEnv()` has already
 * run by the time any environment-derived constant is evaluated, regardless of which
 * consumer imported `../config.js` first. Do not read `process.env` for a module-level
 * constant anywhere that does not (transitively) import this file.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

export function getEnvInt(key: string, defaultValue: number): number {
  return parseInt(process.env[key] ?? String(defaultValue), 10);
}

// __YAAR_BUNDLED is injected at compile time via bun build --define
declare const __YAAR_BUNDLED: boolean | undefined;
export const IS_BUNDLED_EXE = typeof __YAAR_BUNDLED !== 'undefined' && __YAAR_BUNDLED;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Project root directory.
 * - Bundled exe: directory containing the executable
 * - Development: 4 levels up from src/config/ (packages/server/src/config → project root)
 */
export const PROJECT_ROOT = IS_BUNDLED_EXE
  ? dirname(process.execPath)
  : join(__dirname, '..', '..', '..', '..');

/** Directory of this module — the base for dev-time package resolution. */
export const CONFIG_MODULE_DIR = __dirname;

/**
 * Load `PROJECT_ROOT/.env` into `process.env`.
 *
 * Bun auto-loads `.env` from the *current working directory*, and the server is never
 * started from the repo root: `scripts/dev.sh` runs `bun run --filter @yaar/server dev`,
 * whose cwd is `packages/server/`. So the root `.env` — the one file the README and
 * CLAUDE.md tell you to put credentials in — was silently never read, and every var in
 * it read back as undefined. Anchoring to PROJECT_ROOT instead of cwd fixes that for
 * every consumer at once, and gets the bundled exe a `.env` next to the executable for
 * free (PROJECT_ROOT is the exe's own directory there).
 *
 * The real environment always wins: `PORT=9000 make claude-dev` and a test's YAAR_CONFIG
 * must not lose to a stale file on disk. That also keeps this a no-op in CI.
 *
 * `YAAR_SKIP_DOTENV=1` skips the file entirely. That is `scripts/test-env.ts` — a test run
 * pins every knob explicitly, and "fill in what is unset" is exactly the door a developer's
 * `.env` would otherwise walk back through after the scrub.
 *
 * Deliberately a small parser rather than a dependency: `KEY=VALUE`, `#` comments,
 * optional `export ` prefix, optional surrounding quotes. Values are taken literally
 * to the end of the line — no inline-comment stripping, since a `#` inside an
 * unquoted secret is far likelier than a trailing comment on a credential.
 */
function loadRootEnv(): void {
  if (process.env.YAAR_SKIP_DOTENV === '1') return;
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return;

  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf-8');
  } catch {
    return; // Unreadable .env is not worth crashing the server over.
  }

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    if (key === '' || process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadRootEnv();

/**
 * Apply the persisted `remote` preference (`config/settings.json`) onto
 * `process.env.REMOTE`, unless an explicit `REMOTE` env var already set it.
 *
 * This is what makes remote mode togglable from the configurations app: the app writes
 * `remote` into settings.json, and the choice takes effect on the next start. A real
 * `REMOTE=1` (`make claude`, CI) always wins — we only fill in when the var is unset.
 *
 * Read synchronously here because `IS_REMOTE`, and everything derived from it (the bind
 * address in `main.ts`, the auth gate in `auth.ts`, app-origin isolation), are module-load
 * constants — the preference has to be resolved before they are evaluated, i.e. before any
 * async settings read could run. A malformed file falls back to the default (local).
 */
function loadPersistedRemote(): void {
  if (process.env.REMOTE !== undefined) return;
  const configDir = process.env.YAAR_CONFIG || join(PROJECT_ROOT, 'config');
  const settingsPath = join(configDir, 'settings.json');
  if (!existsSync(settingsPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (parsed && parsed.remote === true) process.env.REMOTE = '1';
  } catch {
    // Unreadable/malformed settings.json must not crash boot.
  }
}

loadPersistedRemote();

const DEFAULT_PORT = getEnvInt('PORT', 8000);

/** Current server port (may differ from default if the default was in use). */
export function getPort(): number {
  return getEnvInt('PORT', DEFAULT_PORT);
}

export function setPort(p: number): void {
  process.env.PORT = String(p);
}

/**
 * Remote mode — token auth, `0.0.0.0` bind, QR access.
 *
 * Driven purely by `REMOTE` (env var or the persisted `remote` setting applied above).
 * **The bundled exe no longer forces this on:** it defaults to local, so a shipped exe
 * runs single-user on loopback (no token) with app-origin isolation active, and the user
 * opts into remote from the configurations app when they want network/phone access.
 */
export const IS_REMOTE = process.env.REMOTE === '1';

/**
 * App-origin isolation — the origin boundary that makes an app's principal
 * unforgeable (Stages 1 + 2).
 *
 * When on, `source:'user'` app iframes are served from the `127.0.0.1` alias while
 * the desktop stays on `localhost` — the same socket, a distinct browser origin —
 * and `resolvePrincipal` refuses a token-less request that carries the app origin,
 * so an app can no longer omit its token and be read as the host.
 *
 * **Default on.** `YAAR_APP_ORIGIN_ISOLATION=0` forces it off; that switch is what
 * {@link isAppOriginIsolationRequested} reports, and it governs *both* ways of getting
 * a boundary.
 *
 * This predicate is only the **loopback-alias** way — the `localhost`/`127.0.0.1`
 * split, which has no meaning over a network and so is local-mode only. Remote mode
 * gets a boundary from the transport instead (two Tailscale Serve ports pointed at two
 * local sockets), installed at runtime by the lifecycle. Ask
 * `http/origin-boundary.ts` which boundary is actually in force; this function does not
 * know about the remote one.
 */
export function isAppOriginIsolationEnabled(): boolean {
  return isAppOriginIsolationRequested() && !IS_REMOTE;
}

/** Has the user left app-origin isolation switched on? (Independent of transport.) */
export function isAppOriginIsolationRequested(): boolean {
  return process.env.YAAR_APP_ORIGIN_ISOLATION !== '0';
}

export const APP_ORIGIN_ISOLATION = isAppOriginIsolationEnabled();

/**
 * The loopback hostnames the origin boundary pins to (Stage 2).
 *
 * The desktop lives on `localhost`; installed (`source:'user'`) apps are served
 * from `127.0.0.1` — the same socket, a distinct browser origin. The server keeps
 * the desktop off the app alias (redirects a document that lands on `127.0.0.1`
 * back to localhost), so a token-less request that *does* carry the app origin is
 * an app, never the host. Both sides — this constant and the frontend's
 * `siblingLoopbackOrigin()` — must agree on the assignment.
 */
export const DESKTOP_ORIGIN_HOST = 'localhost';
export const APP_ORIGIN_HOST = '127.0.0.1';

/** Dev mode: local development with live reload (not remote, not bundled). */
export const IS_DEV = !IS_REMOTE && !IS_BUNDLED_EXE;

export const MARKET_URL = process.env.MARKET_URL ?? 'https://yaarmarket.vercel.app';

/**
 * Google OAuth client — the publisher identity YAAR presents to the marketplace.
 *
 * Must be a **Desktop app** client. Only that client type accepts a loopback
 * redirect on an arbitrary port, and the port here is not fixed: `setPort()`
 * moves it whenever 8000 is taken. A Web client would have to pre-register every
 * possible `http://127.0.0.1:<port>/...` and would reject the rest.
 *
 * Baked in rather than asked for. This is YAAR's identity, not the user's — every
 * install presents the same client, and *who is signing in* is proven by the ID
 * token Google signs, which the marketplace verifies against Google's public keys
 * (`aud == GOOGLE_CLIENT_ID`, `email_verified`). A client id is public by
 * construction: it rides in every authorization URL, visible in the address bar.
 * Requiring each user to register their own Cloud project bought nothing and put
 * console busywork in front of publishing.
 *
 * **There is deliberately no client secret here.** Google's token endpoint demands
 * one for Desktop clients, but an open-source app installed on user machines has
 * nowhere to keep it — and a live `GOCSPX-` value in a public repo is reported to
 * Google as a leak by GitHub's scanner. So YAAR never holds one: it runs the
 * authorization step, then hands the code to the marketplace, which adds the secret
 * and calls Google (`features/market/google-auth.ts`). PKCE, not the secret, is what
 * binds a code to this process.
 *
 * Overridable by env for self-hosters running their own marketplace. If you change
 * it, change `GOOGLE_CLIENT_ID` on the marketplace deploy too — it is the `aud`
 * every ID token is checked against, and the two must match.
 */
export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ??
  '901803685747-rlve6phohc7lerkm1ivjufff8dm2anai.apps.googleusercontent.com';
