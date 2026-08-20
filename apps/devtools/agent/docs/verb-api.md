---
name: verb-api
description: Read before writing protocol.ts or verb calls in app code — params schemas, the html-template extraction trap, splitting descriptors.
audience: agent
---

## App Protocol & Verb API

`createProject` already scaffolds this shape — one state key and one Zod-validated command —
so a new project is agent-controllable from its first compile and there is nothing to
convert later.

The `defineApp` entrypoint shape — registration timing, `get`/`run`, the imperative
`view: { mount(el) }` escape hatch, keybindings — is stated in the **App Authoring Contract**
appended to your prompt; read it there. On top of it: **prefer a Zod schema for `params`,
with one exception below** — a JSON Schema literal is checked for required and unknown keys
only, so a `type: "string"` param accepts the number `12345` and hands it to `run`, while a
Zod schema validates the type and `run` receives the parsed value. Declare `replay: 'never'`
on any command whose effect must not be re-applied when the iframe remounts.

**The exception is an app that evaluates an `` html`` `` template at module scope** — the
common shape here, since most apps build their view with `@bundled/solid-js/html`. A Zod
schema is a call result, so the compiler cannot read it from source and instead *imports the
app* to ask it, in a worker with a stubbed DOM. A module-scope `` html`` `` builds a
`<template>` element on import, which the stub cannot do, so the whole extraction fails —
one Zod command is enough to take the app's entire manifest with it. Use JSON Schema
literals in those apps, or keep every `` html`` `` call inside a function so it runs at
mount. The compile names this now, but it is cheaper not to hit it.

Apps talk to the server through 5 verbs exported from `@bundled/yaar`: `read`, `list`,
`invoke`, `describe`, `del`. For HTTP, use `httpFetch` from the same barrel — it is `fetch`,
standard `Response` and all, and cross-origin calls route through the server's proxy
automatically (so `yaar://http` must still be declared). Prefer it over
`invoke('yaar://http', ...)`, which returns YAAR's internal envelope and has led every app
that used it to hand-roll a response type.

**Splitting a large `protocol.ts`.** Descriptor maps may live in `src/protocol/<domain>.ts`
and be spread back in — `commands: { ...fileCommands, ...gitCommands }`. The compiler
resolves relative imports and spreads, so this reaches the manifest intact. The constraint
is that every descriptor stays statically readable: a `const` object literal, no
`...buildCommands()` call result, no `` `${x}` `` description, no map built in a loop.
Violations are a build error with `file:line:col`, never a silently shrunken manifest. Later
spreads win on duplicate names, at runtime and in the manifest alike.

**When handlers need a context.** A descriptor map at module scope cannot close over a
constructor parameter, and wrapping it in a factory is the call result the extractor
refuses. Use `createProtocolContext` instead — set it where the context first exists
(typically inside `view.mount(el)`) and have handlers read it back. `defineApp` registers
before it mounts, which is fine: a handler only reaches the context when a command actually
runs. The context becomes module state shared by every descriptor, which fits an app that
registers once per document — the normal case.

Verify a split with the `manifest` command — a pure move must not change its diff.
