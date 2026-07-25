// Boundary schema for the one untrusted blob this app reads: the pre-appDb
// `memos.json` file.
//
// Everything else memo touches comes from appDb, which the server shapes. The
// legacy file does not: it was written by an older build, may have been
// hand-edited, and may have been truncated by a crashed write. It is read
// exactly once, at migration time, and the rows go straight into the
// collection — so an unvalidated read is how malformed data becomes permanent.
//
// The distinction this schema buys: "no legacy file" (nothing to migrate,
// silent, normal) versus "a legacy file we cannot read" (logged, loudly). The
// old code could not tell those apart — both fell out of the same early return.
//
// The envelope is validated strictly (a `memos` array must be there); the
// per-memo fields are all optional, because `toMemo` already defaults every one
// of them, and dropping a memo that merely lacks a timestamp would be worse
// than migrating it. A row that is not an object at all is skipped and logged.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would
// add ~260KB.
import * as z from '@bundled/zod';

/** One row of the legacy file. Loose so an unknown extra field is carried over. */
export const LegacyMemoSchema = z.looseObject({
  id: z.optional(z.string()),
  title: z.optional(z.string()),
  content: z.optional(z.string()),
  createdAt: z.optional(z.string()),
  updatedAt: z.optional(z.string()),
});

/** The legacy `memos.json` envelope. */
export const LegacyMemoStoreSchema = z.looseObject({
  memos: z.array(z.unknown()),
});
