# Sandbox (run_js) Guide

Code runs in an async IIFE — `await` is supported at the top level. Use `return` to return a value.

## Available Globals

- `console` (log, info, warn, error, debug) — output is captured and returned
- `fetch`, `Headers`, `Request`, `Response` — HTTP requests (restricted to allowed domains)
- `JSON`, `Math`, `Date`
- `Object`, `Array`, `String`, `Number`, `Boolean`, `Map`, `Set`, etc.
- `RegExp`, Error types
- `URL`, `URLSearchParams`
- `TextEncoder`, `TextDecoder`, `atob`, `btoa`
- `parseInt`, `parseFloat`, `isNaN`, `isFinite`
- `Promise`, `structuredClone`, `crypto.createHash`

## NOT Available (Security)

- `process`, `require`, `import` — no Node.js access
- `setTimeout`, `setInterval` — could escape timeout
- `eval`, `Function` — no dynamic code generation
- `fs`, `child_process`, `os` — no system access
