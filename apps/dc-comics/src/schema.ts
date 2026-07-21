// Boundary schemas for JSON that crosses a trust boundary.
//
// These validate JSON we read back but did not just produce in-scope: persisted
// blobs from app storage (whose shape can DRIFT across app versions — an older
// build may have written a different Subscription shape) and the JSON string
// handed back from an in-page evaluate() call. HTML scraping (DOMParser) is a
// separate boundary that zod cannot validate and is intentionally left alone.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.looseObject({...})`, `z.safeParse(Schema, data)`. Loose objects so additive
// fields from newer/older versions survive validation rather than being rejected.
import * as z from '@bundled/zod';

// SeriesPost: { id, title, date: string; isNew: boolean }
const SeriesPostSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  isNew: z.boolean(),
});

// Subscription — the persisted shape stored at
// yaar://storage/dc-comics/subscriptions.json. Mirrors the Subscription type.
export const SubscriptionSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  gallId: z.string(),
  lastPostId: z.string(),
  subscribedAt: z.string(),
  unreadCount: z.number(),
  latestPosts: z.array(SeriesPostSchema),
});

// Scroll telemetry returned as a JSON string from the headless page's
// evaluate() in fetchImageComments. We authored the expression, but the value
// still round-trips through JSON.parse of an untyped `data` field, so validate
// the numeric shape before trusting it to drive the scroll loop.
export const ScrollInfoSchema = z.looseObject({
  y: z.number(),
  h: z.number(),
  vh: z.number(),
  d: z.number(),
});
