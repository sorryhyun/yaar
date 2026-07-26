// Boundary schemas for the JSON devtools reads back out of another app.
//
// None of it is devtools' own state. `projects/{id}/app.json` and a project's
// `protocol.json` belong to the app the user is currently developing — written
// by the user's editor, by a clone of an arbitrary installed app, or by a
// compiler run that may have failed halfway — and the runtime manifest is
// whatever the previewed app handed back from its own `defineApp()` config.
//
// Treating them as trusted (`readJsonOr<{ name: string }>` and friends) meant a
// truncated protocol.json produced a manifest of garbage keys, indistinguishable
// from the legitimate "no such file" case. (The project *name* was never at
// risk: the old reader started from `let name = id` and only overwrote it on a
// truthy `meta.name`. What the app.json schema tightens is `permissions` — a
// value handed straight to window creation as a grant list, which the old code
// guarded with a bare `Array.isArray`, so an array of non-strings went through.)
//
// Loose on purpose: an app.json carries far more than the two fields devtools
// reads (icon, version, bundles, controls...), and none of it should have to be
// re-declared here to survive.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would
// add ~260KB.
import * as z from '@bundled/zod';

/**
 * A project's `app.json`, as far as devtools reads it: `name` for the project
 * list, `permissions` for the preview iframe.
 *
 * Both are optional — a project whose app.json has neither is perfectly normal
 * (createProject writes only `name`, and most projects declare no permissions),
 * so their absence is not a validation failure. What this rejects is a non-object
 * file, or a `permissions` that is not a list of strings — the latter matters
 * because the value is handed straight to window creation as a grant list.
 */
export const ProjectAppJsonSchema = z.looseObject({
  name: z.optional(z.string()),
  permissions: z.optional(z.array(z.string())),
});

/**
 * The shape shared by both protocol manifests devtools reads.
 *
 * Only the key *sets* of `state` and `commands` are read (they become the
 * manifests the drift check diffs), so the values stay `unknown` — but both must
 * be objects, or `Object.keys` on a string would silently yield character
 * indices and report a manifest of "0", "1", "2".
 */
const ManifestShapeSchema = z.looseObject({
  state: z.optional(z.record(z.string(), z.unknown())),
  commands: z.optional(z.record(z.string(), z.unknown())),
});

/** A project's compiler-written `protocol.json`, read from project storage. */
export const ProjectProtocolJsonSchema = ManifestShapeSchema;

/**
 * The live manifest the previewed app registered, read back over `app_query`.
 *
 * Same shape, equally untrusted, and untrusted for a *stronger* reason: the
 * project's protocol.json at least came from the compiler, while this one is
 * whatever arbitrary in-development code passed to `defineApp()`.
 */
export const AppManifestSchema = ManifestShapeSchema;
