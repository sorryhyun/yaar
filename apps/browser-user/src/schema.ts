// Boundary schema for the `/api/bridge` `{ ok, data?, error? }` envelope. Validates the
// wrapper only; `data` stays `unknown` and callers cast it to their per-action `T` after
// this check passes. Loose object so additive envelope fields survive.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.unknown())`,
// `z.safeParse(Schema, data)`.
import * as z from '@bundled/zod';

export const BridgeEnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  data: z.optional(z.unknown()),
  error: z.optional(z.string()),
});
