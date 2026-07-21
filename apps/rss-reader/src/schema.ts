// Boundary schema for the rss2json envelope (untrusted external JSON).
//
// Validates only what fetchFeed reads. Loose objects so additive upstream fields
// survive; every field optional because rss2json omits fields per-feed. A parse
// failure means the service returned something we can't interpret at all — distinct
// from a well-formed `{ status: 'error' }` envelope, which stays a normal feed error.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would add ~260KB.
import * as z from '@bundled/zod';

const Rss2JsonItem = z.looseObject({
  link: z.optional(z.string()),
  title: z.optional(z.string()),
  pubDate: z.optional(z.string()),
  author: z.optional(z.string()),
  description: z.optional(z.string()),
  content: z.optional(z.string()),
  thumbnail: z.optional(z.string()),
});

export const Rss2JsonResponse = z.looseObject({
  status: z.optional(z.string()),
  message: z.optional(z.string()),
  items: z.optional(z.array(Rss2JsonItem)),
});
