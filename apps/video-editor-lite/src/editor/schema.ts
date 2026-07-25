// Boundary schema for `prefs.json`, the only thing this editor persists.
//
// Persisted JSON is untrusted input: written by an older build, hand-edited, or
// truncated by a crashed write. It reaches the app through two doors — the
// awaitable `loadPrefs()` used once at startup, and the `createPersistedSignal`
// that every later read goes through — and until now only the first door had a
// check. That asymmetry was the bug: whatever the signal loaded went straight
// into the player, so a `playbackRate` of `"fast"` reached `video.playbackRate`.
// Both doors now share `revivePrefs` in prefs.ts, and this schema is what it
// validates against.
//
// Loose so a field added by a newer build survives the *read* rather than
// failing it. Not the round-trip: `revivePrefs` rebuilds an explicit
// EditorPrefs, so the unknown field is dropped from whatever the signal next
// persists — looseness buys tolerance here, not preservation.
//
// Every field is optional and defaulted per-field rather than required: a single
// unreadable preference should cost that preference, not the whole file —
// losing `lastStorageListPath` because `loopPreview` was garbage would be a
// worse outcome than the garbage itself. `revivePrefs` enforces that with
// per-field parses; the whole-record parse against this schema is only the
// detector that makes a broken file loud.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would
// add ~260KB.
import * as z from '@bundled/zod';

export const EditorPrefsSchema = z.looseObject({
  // Deliberately not constrained to ALLOWED_PLAYBACK_RATES here: an unknown
  // rate (an older build's 0.75, say) is normalized to the default in
  // revivePrefs, which keeps it a one-field migration instead of a whole-record
  // rejection. The schema's job is only to guarantee it is a real number —
  // `z.number()` already rejects NaN and ±Infinity (checked against the bundled
  // zod 4.3.6), so no extra finiteness refinement is needed.
  playbackRate: z.optional(z.number()),
  loopPreview: z.optional(z.boolean()),
  lastUrl: z.optional(z.string()),
  lastStoragePath: z.optional(z.string()),
  lastStorageListPath: z.optional(z.string()),
});
