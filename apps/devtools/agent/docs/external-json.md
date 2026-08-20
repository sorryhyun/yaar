---
name: external-json
description: Read before validating external data — the bundled Zod is Zod Mini, functional API only.
audience: agent
---

## Validating External JSON

Validate at the trust boundary — external HTTP responses, persisted JSON whose shape has
changed across app versions, command `params` — with `@bundled/zod`. Not ordinary internal
state, and only what you read. **It is Zod Mini** — the functional API, not the chained one:
`z.optional(z.string())` not `z.string().optional()`, `z.safeParse(Schema, data)` not
`Schema.safeParse(data)`; same `z` you use for `params` in the App Protocol. The usage
patterns (`z.looseObject` for items spread downstream, the safeParse-log-throw shape) are in
`command({ command: "describeBundledLibrary", params: { name: "zod" } })` — read it before
writing schemas.
