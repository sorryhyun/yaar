// Boundary schemas for the JSON devtools reads back out of another app.
//
// None of it is devtools' own state. `projects/{id}/app.json` and a project's
// `protocol.json` belong to the app the user is currently developing — written
// by the user's editor, by a clone of an arbitrary installed app, or by a
// compiler run that may have failed halfway — and the runtime manifest is
// whatever the previewed app handed back from its own `defineApp()` config.
//
// Unvalidated, a truncated protocol.json produces a manifest of garbage keys,
// indistinguishable from the legitimate "no such file" case. The app.json schema
// matters for `permissions`, which is handed straight to window creation as a grant
// list. It must accept everything an app.json may say, including `{ uri, verbs }`
// grant objects: a schema narrower than the format rejects valid apps.
//
// Loose: an app.json carries far more than the two fields devtools reads (icon,
// version, bundles, controls...), and none of it is re-declared here.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`.
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

/**
 * What `spawn` hands back, and what `read`ing the persona serves — one shape,
 * because the server builds both from the same projection. `lastResponse` is
 * only ever present on the read: it is the final text of the worker's last
 * completed turn, and the recovery path for an answer the stream could not
 * carry (see `settleFromPersonaRead` in services/worker.ts).
 */
export const PersonaHandleSchema = z.looseObject({
  personaId: z.string(),
  instanceId: z.string(),
  streamUri: z.string(),
  lastResponse: z.optional(z.string()),
});

/**
 * The `data` payload of the worker's stream frames. Every field optional on
 * purpose: one schema covers `start`, `text`, `thinking`, `done`, and `error`,
 * and which fields are present is what `kind` already says. Validating shape
 * rather than presence keeps a new frame kind from being a crash.
 *
 * All-optional has one cost worth naming, because it bit us: a frame the server
 * capped in transit parses *cleanly* here and reads as a frame that simply
 * carried nothing. `truncated` is the field that tells the two apart, so it is
 * declared even though nothing but the cap ever sets it.
 */
export const WorkerFrameDataSchema = z.looseObject({
  /** `text` and `thinking` frames carry an incremental `delta`, never a whole. */
  delta: z.optional(z.string()),
  text: z.optional(z.string()),
  error: z.optional(z.string()),
  /**
   * Set by the server when this frame's payload exceeded the wire cap, in which
   * case every other field here is *gone* — not empty. Never treat one as an
   * empty turn; see the `done` case in services/worker.ts.
   */
  truncated: z.optional(z.boolean()),
  /**
   * On a `done` frame: how the turn ended ('completed' | 'interrupted'). Read
   * rather than ignored because the two are otherwise indistinguishable here —
   * an interrupted turn carries whatever text it had managed, so without this a
   * half-answer reads as a finished one.
   */
  status: z.optional(z.string()),
});

/**
 * One step of an edit the worker proposes through its `edit_request` tool.
 *
 * Mirrors `EditSpec` in lib/edits.ts, and is declared again rather than derived
 * from it because this is a boundary in a way the interface is not: the value
 * arrives as JSON a model typed into a string argument, so nothing has checked
 * it before this point. `oldString`/`newString` are accepted for the same reason
 * `editFile` accepts them — a worker that reaches for the alias should be
 * corrected by the dry run's real errors, not rejected at the parse.
 */
const WorkerEditSpecSchema = z.looseObject({
  search: z.optional(z.string()),
  replace: z.optional(z.string()),
  oldString: z.optional(z.string()),
  newString: z.optional(z.string()),
  startLine: z.optional(z.number()),
  endLine: z.optional(z.number()),
  anchor: z.optional(z.string()),
});

/** The whole `edits` payload of one edit request: a non-empty list of steps. */
export const WorkerEditListSchema = z.array(WorkerEditSpecSchema);

export type PersonaHandle = z.infer<typeof PersonaHandleSchema>;
export type WorkerFrameData = z.infer<typeof WorkerFrameDataSchema>;
