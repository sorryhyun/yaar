// Everything this app fetches over HTTP, and the two rules every one of those
// calls follows: a non-OK status throws, and a body that does not match its
// schema throws rather than being handed on half-understood. Callers `await`
// these inside `runAction`/`withLoading`, which turns either throw into a status line.

import * as z from '@bundled/zod';
import { safeParseOr } from '@bundled/yaar';
import { GITHUB_STATUS_URL, MARKET_DOMAIN } from '../constants.js';
import { GithubStatusSummarySchema } from '../schema.js';

/**
 * Parse-or-throw. `onInvalid` is what makes that expressible — it runs instead of
 * safeParseOr's "using fallback" line, and the fallback is never reached because
 * it throws first. The two messages are separate on purpose: the log carries the
 * endpoint for a developer, the thrown one is what a user reads on the status line.
 */
function validate<S extends z.ZodMiniType>(
  schema: S,
  data: unknown,
  logMessage: string,
  errorMessage: string,
): z.infer<S> {
  return safeParseOr(schema, data, undefined, {
    onInvalid: (issues) => {
      console.error(logMessage, issues);
      throw new Error(errorMessage);
    },
  });
}

/** YAAR's own routes report failures as `{ error }` JSON; fall back to the status code. */
async function yaarError(res: Response, method: string, path: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error || `${method} ${path} failed (${res.status})`);
}

// ── The marketplace domain ─────────────────────────────────────────────

export async function apiGet<S extends z.ZodMiniType>(
  path: string,
  schema: S,
): Promise<z.infer<S>> {
  const res = await fetch(`${MARKET_DOMAIN}${path}`, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return validate(
    schema,
    await res.json(),
    `GET ${path} response failed validation`,
    'The marketplace returned an unexpected response.',
  );
}

// ── GitHub's public status page ─────────────────────────────────────────
//
// Cross-origin, so this goes through YAAR's fetch proxy (SSRF checks + the domain
// allowlist) on the strength of this app's `yaar://http` permission. Unauthenticated
// and uncredentialed by design — it is a public status page, and it must never look
// like a request worth attaching a token to.

export async function fetchGithubStatus(): Promise<z.infer<typeof GithubStatusSummarySchema>> {
  const res = await fetch(GITHUB_STATUS_URL, { method: 'GET' });
  if (!res.ok) throw new Error(`GitHub status check failed (${res.status})`);
  return validate(
    GithubStatusSummarySchema,
    await res.json(),
    'GitHub status summary failed validation',
    'GitHub status page returned an unexpected response.',
  );
}

// ── YAAR's own origin ───────────────────────────────────────────────────
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
  if (!res.ok) throw await yaarError(res, 'GET', path);
  return validate(
    schema,
    await res.json(),
    `GET ${path} response failed validation`,
    `GET ${path} returned an unexpected response.`,
  );
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
  if (!res.ok) throw await yaarError(res, 'POST', path);
  if (!schema) return undefined;
  return validate(
    schema,
    await res.json(),
    `POST ${path} response failed validation`,
    `POST ${path} returned an unexpected response.`,
  );
}
