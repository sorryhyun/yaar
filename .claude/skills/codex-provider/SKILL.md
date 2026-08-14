---
name: codex-provider
description: Working on the Codex provider - JSON-RPC app-server protocol, generated protocol types, version policy. Use when editing packages/server/src/providers/codex or regenerating types.
paths:
  - "**/providers/codex/**"
---

# Codex Provider

Codex talks JSON-RPC over WebSocket to `codex app-server` (not stdio, not MCP — see
`docs/reference/codex_protocol.md` "Why App Server Mode" for why). YAAR's TS bindings for that
protocol are **hand-generated**, not a versioned dependency, so an installed CLI can silently
drift away from the shapes the code was compiled against.

## Key files

- `packages/server/src/providers/codex/version.ts` — `CODEX_MIN_VERSION`, the parse/compare
  helpers, and `assertSupportedCodex()`. The one place that says which CLI versions are accepted.
  Dependency-free on purpose (imported directly by the codegen script).
- `packages/server/src/providers/codex/generated/` — the hand-generated bindings themselves,
  plus `codex-version.ts` recording `CODEX_GENERATED_FROM`.
- `packages/server/src/providers/codex/app-server.ts` — the `initialize` handshake that checks
  the live app-server's `userAgent` against the floor.
- `scripts/codegen/codex-types.js` — regeneration script, run via `make codex-types` (Makefile
  line ~99), optionally `CODEX_BIN=./my-codex make codex-types` to generate from a specific binary.
- `src/tests/codex-version.test.ts` — asserts `CODEX_GENERATED_FROM >= CODEX_MIN_VERSION` and
  pins the `@openai/codex` peer range, so the floor can't drift ahead of what was regenerated.

## Regeneration flow

```bash
make codex-types                    # bun scripts/codegen/codex-types.js
make codex-types CODEX_BIN=./codex  # generate from a specific binary
```

Raise `CODEX_MIN_VERSION` only alongside a regeneration — it's a claim about protocol shapes
actually seen, not a version bump for its own sake.

## Three refusal gates (each sees something the others can't)

1. **`make codex-types`** — refuses to generate from a CLI below the floor; fails closed if the
   version can't be parsed (`--force` overrides).
2. **Provider auto-detect** (`providers/factory.ts`) — treats an under-versioned codex as
   unavailable, so auto-detect silently falls back to Claude instead of booting a mismatched
   provider. Doesn't show up in `GET /api/providers`.
3. **`initialize` handshake** (`app-server.ts`) — checks the `userAgent` of whichever process
   actually answered (may differ from what `--version` resolved to, e.g. a stale process still
   holding `CODEX_WS_PORT`). Throws `CodexVersionError`, not retried.

Gates 2 and 3 fail **open** on an unparseable version string (format belongs to OpenAI, a
cosmetic change there shouldn't un-detect a working install) — only a parsed, too-low version
is refused.

## Forcing vs auto-detecting

- `PROVIDER=codex` (or `provider` in `config/settings.json`) with an unsupported CLI **refuses
  the boot** — single-line message, exit code 1. No silent fallback to Claude.
- Auto-detect (no `PROVIDER` set) just **skips** codex and picks Claude instead.

Full protocol reference, JSON-RPC basics, CLI args, and the "why app-server" rationale:
`docs/reference/codex_protocol.md`.
