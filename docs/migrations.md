# Migrations

## Vite → Bun Bundler (2026-03-25)

Replaced Vite with Bun's built-in bundler for the frontend. Everything now runs on a single port (8000).

### Why

- Eliminate the dual-port dev setup (Vite on 5173 proxying to server on 8000)
- Simplify the stack — Bun already serves as runtime and package manager
- Single-process `make dev` instead of coordinating two servers

### What changed

**New files:**
- `packages/frontend/build.ts` — Production build via `Bun.build()` (CSS Modules, `@/` alias, HTML generation, public file copy)
- `packages/server/src/http/dev-bundler.ts` — Dev mode: `Bun.build()` + `fs.watch()` + SSE live reload

**Removed:**
- `packages/frontend/vite.config.ts`
- `packages/frontend/tsconfig.node.json`
- `vite` and `@vitejs/plugin-react-oxc` dependencies

**Key modifications:**
- `tokens.css` import moved from `index.html` `<link>` to `main.tsx` JS import (so Bun.build picks it up)
- `api.ts` — removed Vite port 5173 WebSocket workaround (same-origin now)
- `dev.sh` — simplified to single-process (server handles frontend)
- `index.html` — no longer used directly; generated at build time
- Server gains `IS_DEV` flag, `/dev-reload` SSE endpoint, and `registerDevReloadHandler()`

### How it works

| Mode | Frontend build | Served from | Live reload |
|------|---------------|-------------|-------------|
| `make dev` | Dev bundler (on server start) | Server :8000 | SSE → page reload |
| `make claude` | `bun build.ts` (once) | Server :8000 | No |
| `build:exe` | `bun build.ts` → embedded | Bundled exe | No |

### Trade-offs

- **No HMR** — full page reload instead of React Fast Refresh. Session state survives via WebSocket reconnection.
- **Bun.build plugin** needed for `@/` alias resolution (Bun doesn't auto-resolve extensionless imports from plugins) and to externalize absolute font URLs in CSS.
