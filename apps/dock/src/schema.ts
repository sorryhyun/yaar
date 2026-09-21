// Boundary schemas for untrusted JSON read by the dock:
//   - Open-Meteo current-weather forecast (main.ts)
//   - Nominatim reverse-geocoding (main.ts)
//   - the yaar://session/agents roster (agents.ts)
// Only the fields the dock reads are validated. Loose objects so additive
// upstream fields survive; nested/leaf fields are optional because either
// service may omit them, and the dock degrades instead of throwing.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.looseObject({...})`, `z.safeParse(Schema, data)`.
import * as z from '@bundled/zod';

// Open-Meteo forecast — main.ts reads data.current.temperature_2m and
// data.current.weather_code.
export const OpenMeteoResponse = z.looseObject({
  current: z.optional(
    z.looseObject({
      temperature_2m: z.optional(z.number()),
      weather_code: z.optional(z.number()),
    })
  ),
});

// `list('yaar://session/agents')` — the roster Process Explorer renders. The
// server owns this shape and may run a different version, so every counter is
// optional and rows are parsed one at a time in agents.ts: one unreadable agent
// costs that row, not the badge.
export const AgentUsage = z.looseObject({
  inputTokens: z.optional(z.number()),
  outputTokens: z.optional(z.number()),
  cacheReadTokens: z.optional(z.number()),
  cacheWriteTokens: z.optional(z.number()),
});

export const AgentEntry = z.looseObject({
  id: z.string(),
  type: z.string(),
  label: z.optional(z.string()),
  busy: z.optional(z.boolean()),
  appId: z.optional(z.string()),
  usage: z.optional(AgentUsage),
});

export const AgentRoster = z.looseObject({
  totalAgents: z.optional(z.number()),
  busyAgents: z.optional(z.number()),
  usage: z.optional(AgentUsage),
  agents: z.optional(z.array(z.unknown())),
});

// Nominatim reverse geocode — main.ts reads data.address.{city,town,county}.
export const NominatimResponse = z.looseObject({
  address: z.optional(
    z.looseObject({
      city: z.optional(z.string()),
      town: z.optional(z.string()),
      county: z.optional(z.string()),
    })
  ),
});
