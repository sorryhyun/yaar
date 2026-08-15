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
// guarded with a bare `Array.isArray`, so an array of arbitrary junk went through.)
//
// Tightening it is only safe if it matches what an app.json may actually say —
// the first version accepted `string[]` alone and so declared every app that
// narrows a grant to `{ uri, verbs }` invalid. A boundary schema narrower than
// the format it guards is not strictness, it is a false negative.
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
 * One entry in an app.json `permissions` list. Both forms the server accepts:
 * a bare URI prefix, or `{ uri, verbs }` restricting the grant to some verbs
 * (`PermissionEntry` in `packages/server/src/http/access.ts`). Accepting only
 * the string form here rejected every cloned app that had ever narrowed a
 * grant — a real, common app.json read as corrupt, and the clone previewed
 * with no permissions at all.
 *
 * `verbs` stays `z.string()` rather than an enum of the five verbs: this is a
 * boundary check on someone else's file, and an unknown verb is the server's to
 * reject, not devtools' reason to discard the whole project's grants.
 */
const PermissionEntrySchema = z.union([
  z.string(),
  z.looseObject({
    uri: z.string(),
    verbs: z.optional(z.array(z.string())),
  }),
]);

export type PermissionEntry = z.infer<typeof PermissionEntrySchema>;

/**
 * A project's `app.json`, as far as devtools reads it: `name` for the project
 * list, `permissions` for the preview iframe.
 *
 * Both are optional — a project whose app.json has neither is perfectly normal
 * (createProject writes only `name`, and most projects declare no permissions),
 * so their absence is not a validation failure. What this rejects is a non-object
 * file, or a `permissions` that is not a list of grant entries — the latter
 * matters because the value is handed straight to window creation as a grant list.
 */
export const ProjectAppJsonSchema = z.looseObject({
  name: z.optional(z.string()),
  permissions: z.optional(z.array(PermissionEntrySchema)),
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

// The worker sub-agent's wire (yaar://apps/self/agents): same rationale as the
// manifests above. The envelope is JSON pulled out of a verb result, and a
// malformed one would otherwise surface as `undefined.streamUri` three frames
// into a subscription — far from the call that produced it.

/** What `spawn` hands back. Loose — the server may add fields. */
export const PersonaHandleSchema = z.looseObject({
  personaId: z.string(),
  instanceId: z.string(),
  streamUri: z.string(),
});

/**
 * The `data` payload of the worker's stream frames. Every field optional on
 * purpose: one schema covers `start`, `text`, `thinking`, `done`, and `error`,
 * and which fields are present is what `kind` already says. Validating shape
 * rather than presence keeps a new frame kind from being a crash.
 */
export const WorkerFrameDataSchema = z.looseObject({
  content: z.optional(z.string()),
  text: z.optional(z.string()),
  error: z.optional(z.string()),
});

export type PersonaHandle = z.infer<typeof PersonaHandleSchema>;
export type WorkerFrameData = z.infer<typeof WorkerFrameDataSchema>;
