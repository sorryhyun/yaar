// Boundary schemas for untrusted external JSON fetched by the dock.
//
// These validate the responses from the two network calls in main.ts:
//   - Open-Meteo current-weather forecast
//   - Nominatim reverse-geocoding
// Only the fields the dock actually reads are validated. Loose objects so
// additive upstream fields survive; nested/leaf fields are optional because
// either service may omit them, and the dock degrades gracefully rather than
// throwing (it is core chrome).
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
