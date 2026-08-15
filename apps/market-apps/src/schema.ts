// Boundary schemas for market-apps' untrusted external JSON.
//
// Two sources cross a trust boundary here: the marketplace domain and GitHub's public
// status page (fully external), and YAAR's own origin (the Google publisher-auth
// routes — local, but persisted/served shapes drift too, so they get a loose check).
// Each schema validates ONLY the fields the app actually reads, and uses looseObject so
// additive upstream fields pass through untouched. A parse failure means the endpoint
// returned something we can't interpret; every caller already degrades safely (healthy
// banner / signed-out account / "Refresh failed") when the boundary throws.
//
// `@bundled/zod` is Zod Mini (functional API): `z.looseObject({...})`,
// `z.optional(z.string())`, `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB;
// standard Zod would add ~260KB.
import * as z from '@bundled/zod';

// Marketplace domain: GET /api/apps/
//
// parseMarket returns `.marketApps` / `.apps` entries directly as ListedApp. An entry
// needs at least an id (to install) and a name (to render as a card) to be usable, so
// those are required — a card missing either is worth rejecting. Everything else the UI
// reads is optional. Loose so the card gains fields without a schema change.
const ListedAppSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.optional(z.string()),
  version: z.optional(z.string()),
  author: z.optional(z.string()),
  icon: z.optional(z.string()),
});

export const MarketPayloadSchema = z.looseObject({
  apps: z.optional(z.array(ListedAppSchema)),
  marketApps: z.optional(z.array(ListedAppSchema)),
});

// GitHub status: GET githubstatus.com/api/v2/summary.json
//
// parseGithubStatus only reaches `.components[].{name,status}` and
// `.incidents[].{name, incident_updates[].body}`, and already treats every missing
// field as "healthy" — so every field here is optional. The check only rejects a
// non-object envelope, which the caller turns into silence.
export const GithubStatusSummarySchema = z.looseObject({
  components: z.optional(
    z.array(z.looseObject({ name: z.optional(z.string()), status: z.optional(z.string()) })),
  ),
  incidents: z.optional(
    z.array(
      z.looseObject({
        name: z.optional(z.string()),
        incident_updates: z.optional(z.array(z.looseObject({ body: z.optional(z.string()) }))),
      }),
    ),
  ),
});

// YAAR origin: GET /api/auth/google/status
//
// refreshAccount copies all four fields straight into the `account` signal, so a
// well-formed status response must carry them; a malformed one degrades to the
// signed-out default via the caller's catch.
export const AuthStatusSchema = z.looseObject({
  configured: z.boolean(),
  signedIn: z.boolean(),
  email: z.nullable(z.string()),
  pending: z.boolean(),
});

// YAAR origin: GET /api/auth/google/me
//
// Best-effort call; the caller guards both reads (`Array.isArray(me.apps)`,
// `me.email ?? ...`), so both fields stay optional.
export const AuthMeSchema = z.looseObject({
  email: z.optional(z.nullable(z.string())),
  apps: z.optional(z.array(z.string())),
});

// YAAR origin: POST /api/auth/google/login
//
// The caller ignores the body; this only asserts the sign-in kickoff returned a
// well-formed JSON object rather than an error page or HTML.
export const AuthLoginSchema = z.looseObject({
  authUrl: z.optional(z.string()),
});
