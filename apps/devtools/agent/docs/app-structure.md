---
name: app-structure
description: Read before laying out a new project's src/ — the standard file split and where assets sit.
audience: agent
---

## App Structure

Entry point is always `src/main.ts`. Split code across files:

```
src/
├── main.ts        # Entry point: the single `export default defineApp({...})`
├── styles.css     # All CSS (imported via `import './styles.css'`)
├── protocol.ts    # Command/state descriptor maps, spread into defineApp
├── store.ts       # Signals and shared state
├── types.ts       # Type definitions
├── helpers.ts     # Pure utility functions
└── sprite.png     # Static assets — imported, not fetched
```

**Mounting and design tokens are specified in the App Authoring Contract appended to your
prompt** — generated from the compiler itself and authoritative. Read it rather than guessing
a token name or a mount id; the compiler rejects both a wrong render target and an undefined
token, so a build error naming one is telling you the truth.
