// ── Network + host verb helpers ──────────────────────────────────────────
//
// The I/O boundary: talking to the marketplace domain (apiGet), to YAAR's own
// origin for publisher auth (yaarGet / yaarPost), and to the host via the apps
// verb (install / delete / list). Everything here returns plain data; loading
// state and status text are the caller's concern (see actions.ts).

import * as z from '@bundled/zod';
import { del, invoke, list } from '@bundled/yaar';
import { GITHUB_STATUS_URL, MARKET_DOMAIN } from './constants.js';
import { parseInstalledAny } from './parsers.js';
import { GithubStatusSummarySchema } from './schema.js';
import type { ConfirmOutcome, InstalledApp, PreparedPublication } from './types.js';

// ── Marketplace domain ───────────────────────────────────────────────

export async function apiGet<S extends z.ZodMiniType>(
  path: string,
  schema: S,
): Promise<z.infer<S>> {
  const res = await fetch(`${MARKET_DOMAIN}${path}`, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  const parsed = z.safeParse(schema, await res.json());
  if (!parsed.success) {
    console.error(`GET ${path} response failed validation`, parsed.error.issues);
    throw new Error('The marketplace returned an unexpected response.');
  }
  return parsed.data;
}

// ── GitHub health ────────────────────────────────────────────────────
//
// Cross-origin, so this goes through YAAR's fetch proxy (SSRF checks + the domain
// allowlist) on the strength of this app's `yaar://http` permission. Unauthenticated
// and uncredentialed by design — it is a public status page, and it must never look
// like a request worth attaching a token to.

export async function fetchGithubStatus(): Promise<unknown> {
  const res = await fetch(GITHUB_STATUS_URL, { method: 'GET' });
  if (!res.ok) throw new Error(`GitHub status check failed (${res.status})`);
  const parsed = z.safeParse(GithubStatusSummarySchema, await res.json());
  if (!parsed.success) {
    console.error('GitHub status summary failed validation', parsed.error.issues);
    throw new Error('GitHub status page returned an unexpected response.');
  }
  return parsed.data;
}

// ── Host verbs (yaar://apps/) ──────────────────────────────────────────

/** Install an app via yaar://apps/{appId}. Requires yaar://apps/ permission. */
export async function hostInstall(app: { id: string }): Promise<void> {
  await invoke('yaar://apps/' + app.id, { action: 'install' });
}

/** Delete an app via yaar://apps/{appId}. Requires yaar://apps/ permission. */
export async function hostDelete(app: { id: string }): Promise<void> {
  await del('yaar://apps/' + app.id);
}

/** Fetch installed apps via yaar://apps list verb. Requires yaar://apps/ permission. */
export async function hostListInstalled(): Promise<InstalledApp[]> {
  const result = await list('yaar://apps');
  return parseInstalledAny(result);
}

/**
 * Two-phase publish over `yaar://apps/{id}`. `prepare` freezes the exact bytes and
 * returns their digest; `confirm` ships those frozen bytes after the user approves;
 * `cancel` discards the freeze. The host refuses `confirm` on source drift unless
 * `acknowledgeDrift` is set — the dialog surfaces that as a "Publish anyway" step.
 */
export async function hostPreparePublish(app: { id: string }): Promise<PreparedPublication> {
  return (await invoke('yaar://apps/' + app.id, {
    action: 'publish_prepare',
  })) as PreparedPublication;
}

export async function hostConfirmPublish(
  app: { id: string },
  publicationId: string,
  acknowledgeDrift: boolean,
): Promise<ConfirmOutcome> {
  return (await invoke('yaar://apps/' + app.id, {
    action: 'publish_confirm',
    publicationId,
    acknowledgeDrift,
  })) as ConfirmOutcome;
}

export async function hostCancelPublish(app: { id: string }, publicationId: string): Promise<void> {
  await invoke('yaar://apps/' + app.id, { action: 'publish_cancel', publicationId });
}

// ── Publisher auth (YAAR's own origin, relative paths) ─────────────────────────
//
// These hit YAAR's *own* origin (relative paths), not the marketplace domain — the
// fetch proxy attaches this app's iframe token automatically, and the server only
// answers because market-apps is a bundled system app. `login` opens a real Google
// consent screen, which is why the routes are closed to ordinary apps.

export async function yaarGet<S extends z.ZodMiniType>(
  path: string,
  schema: S,
): Promise<z.infer<S>> {
  const res = await fetch(path, { method: 'GET' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `GET ${path} failed (${res.status})`);
  }
  const parsed = z.safeParse(schema, await res.json());
  if (!parsed.success) {
    console.error(`GET ${path} response failed validation`, parsed.error.issues);
    throw new Error(`GET ${path} returned an unexpected response.`);
  }
  return parsed.data;
}

/**
 * POST to a YAAR auth route. `schema` is optional: the callers here (login/logout)
 * never read the response body, so passing a schema only asserts the endpoint
 * answered with well-formed JSON of the expected shape; omit it to skip that check.
 */
export async function yaarPost<S extends z.ZodMiniType>(
  path: string,
  schema?: S,
): Promise<z.infer<S> | undefined> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `POST ${path} failed (${res.status})`);
  }
  if (!schema) return undefined;
  const parsed = z.safeParse(schema, await res.json());
  if (!parsed.success) {
    console.error(`POST ${path} response failed validation`, parsed.error.issues);
    throw new Error(`POST ${path} returned an unexpected response.`);
  }
  return parsed.data;
}
