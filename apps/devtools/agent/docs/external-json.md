---
name: external-json
description: Read before reading back persisted JSON or validating external data — Zod Mini only, and "missing" must stay distinguishable from "malformed".
audience: agent
---

## Validating External JSON

Validate at the trust boundary — external HTTP responses, persisted JSON (written by an older
build, hand-edited, truncated by a crashed write, or written by another live copy), command
`params` — with `@bundled/zod`. Not ordinary internal state, and only what you read. **It is
Zod Mini** — the functional API, not the chained one: `z.optional(z.string())` not
`z.string().optional()`, `z.safeParse(Schema, data)` not `Schema.safeParse(data)`; same `z` you
use for `params` in the App Protocol. The usage patterns (`z.looseObject` for items spread
downstream, the safeParse-log-throw shape) are in
`command({ command: "describeBundledLibrary", params: { name: "zod" } })` — read it before
writing schemas.

### Missing is quiet, malformed is loud

`readJsonOr(path, fallback)` answers "no file" and "garbage file" with the same value, so a
broken app renders exactly like a fresh one and the user's data is gone with no trace. Keep
the two apart:

```ts
const raw = await appStorage.readJsonOr<unknown>('prefs.json', undefined);
const prefs = safeParseOr(PrefsSchema, raw, DEFAULTS, { label: 'prefs.json' });
```

`undefined` (nothing stored) takes the fallback silently; a present-but-wrong value takes it and
logs the schema's issues. `onInvalid` replaces that log line: throw from it for parse-or-throw,
toast from it when the fallback would mislead the user. Never toast from a poll or subscription
callback; report only the transition into failure. Hand-roll `z.safeParse` only for per-field
or per-row recovery, so one drifted field does not cost the rest. Schemas go in `src/schema.ts`,
with a header naming the boundaries they guard.

For `createPersistedSignal`, the parse goes in `revive`. It also runs on the **fallback** when
nothing is stored, so a fallback that fails the schema logs an error on every fresh install.
`revive` validates and migrates; clamping against the current window belongs on the read.
