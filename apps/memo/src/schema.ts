// Boundary schema for the pre-appDb `memos.json` file, the one untrusted blob
// this app reads (older build, possibly hand-edited or truncated). It is read
// once, at migration time, and its rows go straight into the collection.
//
// The envelope is strict (a `memos` array must be there); per-memo fields are
// all optional because `toMemo` defaults every one of them. A row that is not
// an object is skipped and logged.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`.
import * as z from '@bundled/zod';

/** Loose so an unknown extra field is carried over. */
export const LegacyMemoSchema = z.looseObject({
  id: z.optional(z.string()),
  title: z.optional(z.string()),
  content: z.optional(z.string()),
  createdAt: z.optional(z.string()),
  updatedAt: z.optional(z.string()),
});

export const LegacyMemoStoreSchema = z.looseObject({
  memos: z.array(z.unknown()),
});
