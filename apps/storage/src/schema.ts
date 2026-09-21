// Boundary schema for the one thing this app persists: `layout.json` (untrusted: it may be
// from an older build, hand-edited, or truncated). `createPersistedSignal`'s `revive` runs
// the check and logs a record it cannot read; an absent one stays silent.
//
// Loose so a field added by a newer build does not fail an older build's read. The field is
// still dropped on the next write, because `reviveLayout` returns an explicit
// `{ panelWidth, viewMode }`.
//
// `panelWidth` is not clamped here; see `reviveLayout` in layout.ts.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`.
import * as z from '@bundled/zod';

export const LayoutPrefsSchema = z.looseObject({
  // `z.number()` rejects NaN and ±Infinity; a non-finite width would poison every later clamp.
  panelWidth: z.optional(z.number()),
  viewMode: z.optional(z.enum(['list', 'grid'])),
});
