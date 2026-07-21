// Boundary schema for the `/api/bridge` envelope (untrusted structured JSON).
//
// The Bridge relays actions to the user's REAL Chrome tabs via the extension,
// then returns a `{ ok, data?, error? }` envelope that crosses a process boundary
// before we read it. This schema confirms the ENVELOPE WRAPPER is well-formed —
// it does NOT re-validate `data`, whose shape is generic over `T` per action and
// is left as `unknown` by design. Callers cast `data` to their expected `T` only
// after the envelope shape has been confirmed here.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.unknown())`,
// `z.safeParse(Schema, data)`. Loose object so additive envelope fields survive.
import * as z from '@bundled/zod';

export const BridgeEnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  data: z.optional(z.unknown()),
  error: z.optional(z.string()),
});
