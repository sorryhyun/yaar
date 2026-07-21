// Boundary schemas for the Hugging Face daily-papers API (untrusted external JSON).
//
// These validate ONLY the shape the app relies on, and use looseObject so additive
// upstream fields survive into the spread in `fetchHfPapers`. A parse failure means
// HF returned something we can't interpret (e.g. an `{ error }` envelope instead of a
// list) — the caller turns that into a concise user-facing error, with full issues in
// the console. This is a trust-boundary check, not a second copy of the domain types.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would add ~260KB.
import * as z from '@bundled/zod';

const HfAuthor = z.looseObject({ name: z.optional(z.string()) });

const HfPaperInner = z.looseObject({
  id: z.optional(z.string()),
  title: z.optional(z.string()),
  summary: z.optional(z.string()),
  publishedAt: z.optional(z.string()),
  ai_summary: z.optional(z.string()),
  upvotes: z.optional(z.number()),
  authors: z.optional(z.array(HfAuthor)),
});

const HfContributor = z.looseObject({
  fullname: z.optional(z.string()),
  name: z.optional(z.string()),
});

/** One entry of GET /api/daily_papers. Loose: the app spreads the whole item. */
export const DailyPaperItemSchema = z.looseObject({
  paper: z.optional(HfPaperInner),
  id: z.optional(z.string()),
  title: z.optional(z.string()),
  summary: z.optional(z.string()),
  publishedAt: z.optional(z.string()),
  thumbnail: z.optional(z.string()),
  numComments: z.optional(z.number()),
  upvotes: z.optional(z.number()),
  submittedBy: z.optional(HfContributor),
  organization: z.optional(HfContributor),
});

export const DailyPapersResponse = z.array(DailyPaperItemSchema);

/**
 * GET /api/papers/:id. Every field is optional and loosely typed because the caller
 * already coerces/normalizes each one; the schema's job is only to reject a non-object
 * response (null, an array, an error string) before normalization reads `data.field`.
 */
export const PaperDetailResponse = z.looseObject({
  id: z.optional(z.string()),
  title: z.optional(z.string()),
  summary: z.optional(z.string()),
  ai_summary: z.optional(z.string()),
  ai_keywords: z.optional(z.array(z.string())),
  authors: z.optional(z.array(z.looseObject({ name: z.optional(z.string()) }))),
  upvotes: z.optional(z.number()),
  publishedAt: z.optional(z.string()),
  projectPage: z.optional(z.string()),
  githubRepo: z.optional(z.string()),
  githubStars: z.optional(z.number()),
});
