// Boundary schema for the one thing this app persists: `layout.json`.
//
// Persisted JSON is untrusted input — written by an older build, hand-edited,
// or truncated by a crashed write — so it is validated before it reaches the
// signal. `createPersistedSignal`'s `revive` is where that check runs; it logs
// (never swallows) a record it cannot read, so a broken layout.json is
// distinguishable from an absent one, which stays silent.
//
// Loose so an additive layout field written by a newer build does not fail an
// older build's *read* — not so it survives the round-trip: `reviveLayout`
// returns an explicit `{ panelWidth }`, and that is what the signal re-persists
// on the next write, so the unknown field is dropped there.
//
// `panelWidth` is checked for finiteness here rather than in a hand-rolled
// `typeof` chain, but it is deliberately NOT clamped — see `reviveLayout` in
// layout.ts for why that distinction matters.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would
// add ~260KB.
import * as z from '@bundled/zod';

export const LayoutPrefsSchema = z.looseObject({
  // `z.number()` already rejects NaN and ±Infinity (checked against zod 4.3.6),
  // which is exactly the guarantee the old hand-rolled `Number.isFinite` check
  // was there to provide — a non-finite width would poison every later clamp.
  panelWidth: z.optional(z.number()),
});
