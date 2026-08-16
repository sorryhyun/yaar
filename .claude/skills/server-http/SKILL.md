---
name: server-http
description: The YAAR server's HTTP layer - REST routes, the access chokepoint, principals, iframe tokens. Use when editing packages/server/src/http/ or adding/changing a route or permission gate.
paths:
  - "packages/server/src/http/**"
---

This skill covers the YAAR server's HTTP layer: the REST route list and the access chokepoint
(`http/access.ts`) — principals, permission gates, delegated grants, and iframe/MCP token
handling. The content below is carried over verbatim from `packages/server/CLAUDE.md`.

## REST API

Routes in `http/routes/`: `GET /health`, `GET /api/version`, `/api/providers`, `/api/apps`,
`/api/sessions`, `/api/shortcuts`, `/api/settings`, `/api/domains`, `/api/agents/stats`,
`/api/storage/*`, `/api/pdf/*`, `/api/browser/*`, `/api/fetch`, `/api/pick-directory`, `/api/embeddable`,
`/api/remote-info`, `POST /api/iframe-token`, `POST /api/verb`, `POST /api/verb/subscribe`. See
`routes/api.ts`, `routes/verb.ts`, and `routes/files.ts` for full signatures.

### The access chokepoint (`http/access.ts`)

**A route never invents its own permission check.** It resolves the caller to a `Principal` and
names the `yaar://` URI + verb it is about to perform:

```ts
const principal = resolvePrincipal(req, url);        // host | app  (or a 403 Response)
if (principal instanceof Response) return principal;
const denied = requirePermission(principal, 'yaar://config/domains', 'invoke');
if (denied) return denied;
```

This is the same check `POST /api/verb` runs, shared rather than duplicated — the REST routes used
to reach storage, config, and session logs with no check at all.

- **`host`** — the desktop (no iframe token). Unconfined; in `REMOTE=1` it has already proven the remote token in `auth.ts`.
- **`app`** — an iframe token. Confined to its app.json `permissions`, plus auto-granted self-storage, the commons, and whatever a caller granted to its window at runtime.

**`access.ts`'s header is the authority on what a principal is and how the origin boundary
attributes a request** — read it before adding a gate. The gates it exports:

| Function | Use |
|---|---|
| `requirePermission()` | The main check — canonicalization, `self`, verbs |
| `requireApp()` | Insist the caller is a real app. Needed because `requirePermission` returns `null` for `host`, so a door that only asks it is open to anyone who omits a token |
| `requireHost()` | Routes no app can hold a permission for (`/api/iframe-token`, `/api/pick-directory`, `/api/remote-info`, `/api/agents/stats`, `/api/embeddable`, `/api/dev/preview/{appId}`, session restore) |
| `requireBundle()` | Gated SDK doors (`/api/dev/*` → `yaar-dev`; `/api/browser`, `/api/bridge` → `yaar-web`; `/api/ml-weights*` → `yaar-ml`) |
| `permissionsAllow()` | The matching rule as a boolean, for a caller with a permission list and no `Principal` (the app-agent storage door) |
| `storageUriFor()` | Maps an HTTP storage path to the URI that names the same file |
| `resolveSelf()` / `namesSelf()` | **The** expansion of `yaar://apps/self/…` |

Four invariants worth knowing before you touch any of it:

- **The token is identity; `WindowStateRegistry` is authority.** A token carries who an iframe *is*; everything a caller granted *to this window* at runtime lives on `WindowStateRegistry.delegatedGrants`, read per request through `setWindowGrantResolver`. A token is not durable and a window is — every reconnect re-mints one, so authority baked in at mint time vanished on the first page refresh.
- **Three producers, one home.** Delegated grants (`features/window/delegated-grants.ts` — its 65-line header is the full story), caller-supplied `permissions` on `window.create`, and the window's own document. Each narrows; the registry only stores.
- **A token dies with its window.** `revokeTokensForWindow` is wired into `LiveSession`'s `setOnWindowClose`, registered in the **constructor** because windows outlive the pool.
- **The copy shape is shared** (`handlers/storage-copy.ts`). `invoke { action: 'copy', from }` reads a URI the caller did not name as its target, so `POST /api/verb` re-checks `read` on `from` — per element, since a batched invoke is N calls the registry runs without returning to the door.

Tokens for subresources that cannot set a header (`<img src>`, `EventSource`) ride as
`?__yaar_token=`. `extractIframeToken()` is the one definition of "presenting a token" and all
three layers that ask call it.

**MCP principal:** each agent gets a token minted by `mcp/agent-tokens.ts` and bound to its id
server-side; providers send it as `X-Agent-Token`. The shared bearer token (`getMcpToken()`) is
transport auth only. There is deliberately no `x-agent-id` header — an agent that can name a
principal can become it.
