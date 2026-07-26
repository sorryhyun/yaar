/**
 * Boundary schemas — everything this app is *handed* rather than owns.
 *
 * Two wires, and they fail differently, which is why they are parsed rather than
 * cast:
 *
 *   1. The persona verbs (`yaar://apps/self/agents`). The envelope is JSON pulled
 *      out of a text block, and a malformed one would otherwise be discovered as
 *      `undefined.instanceId` three frames into a stream subscription — far from
 *      the call that produced it.
 *   2. Agent stream frames. `kind` is source-defined and `data` is `unknown` by
 *      declaration; a frame kind gaining a field, or an `error` arriving where
 *      `text` was expected, is a normal event on a live wire, not an exception.
 *
 * `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
 * `z.safeParse(Schema, data)`.
 */
import * as z from '@bundled/zod';

/** What `spawn` and `message` hand back. Loose — the server may add fields. */
export const PersonaHandleSchema = z.looseObject({
  personaId: z.string(),
  instanceId: z.string(),
  streamUri: z.string(),
});

/** The roster from `list('yaar://apps/self/agents')`. */
export const RosterSchema = z.looseObject({
  max: z.number(),
  personas: z.array(z.looseObject({ personaId: z.string(), busy: z.optional(z.boolean()) })),
});

/**
 * The `data` payload of the stream frames this app reads.
 *
 * Every field optional on purpose: one schema covers `start`, `text`, `thinking`,
 * `done`, and `error`, and which fields are present is what `kind` already says.
 * Validating shape rather than presence keeps a new frame kind from being a crash.
 */
export const FrameDataSchema = z.looseObject({
  content: z.optional(z.string()),
  text: z.optional(z.string()),
  error: z.optional(z.string()),
  status: z.optional(z.string()),
});

export type PersonaHandle = z.infer<typeof PersonaHandleSchema>;
export type Roster = z.infer<typeof RosterSchema>;
export type FrameData = z.infer<typeof FrameDataSchema>;

/** Parse or throw with a message naming the call that produced the bad shape. */
export function parseOrThrow<T>(schema: z.ZodMiniType<T>, value: unknown, what: string): T {
  const result = z.safeParse(schema, value);
  if (!result.success) {
    console.error(`[chitchats] ${what} failed validation`, result.error.issues, value);
    throw new Error(`${what} returned an unexpected shape`);
  }
  return result.data;
}
