# Backend Architecture Audit

Date: 2026-03-06
Scope: `packages/server` static review focused on backend architecture, security, isolation, and operational performance.

## Summary

The backend has a clear modular shape: HTTP, WebSocket/session management, MCP tools, storage, browser automation, and provider orchestration are separated reasonably well. The main architectural problems are not about code organization; they are about trust boundaries and session scoping.

## Performance and Operational Notes

### Good

- Clear separation of concerns between HTTP, WebSocket, providers, MCP, storage, and logging.
- Warm provider pool is a sensible latency optimization.
- Monitor/window agent split is a pragmatic concurrency model.
- `ContextTape` has a bounded main-message policy, which is better than unbounded transcript growth in memory.

### Watchlist

- The system is heavily singleton-driven (`BroadcastCenter`, warm pool, session hub, browser pool). That is fine for a single-process desktop backend, but it makes correctness depend on consistent session routing.
- Domain policy is global, not per-session or per-app. That is operationally simple but broadens blast radius.

## URI-Based Access Patterns

Short version: the URI design is good as an addressing model. It is not yet a strong authority model.

### What is solid about it

- `yaar://apps/...`, `yaar://storage/...`, `yaar://sandbox/...`, and window-resource URIs give the system a uniform resource vocabulary.
- This helps the AI/tooling layer reason about resources without hard-coding transport paths everywhere.
- It creates a clean seam for future backends because callers operate on logical resources first.
- The code already gets real value from this in:
  - content resolution
  - shortcut targets
  - app deployment flows
  - window/app protocol resource naming

Relevant code:

- `packages/shared/src/yaar-uri.ts`
- `packages/server/src/mcp/basic/uri.ts`
- `packages/server/src/mcp/window/create.ts`

### Where it is weak today

- URIs are resolved early into normal HTTP paths, so policy context is lost quickly.
- The URI itself does not encode capability, subject, or permission scope.
- The same resource name can be reachable by any caller that already has general backend access.
- In other words, the URI layer names resources, but the real authorization still happens elsewhere, and that authorization is currently too coarse in a few places.

Example:

- `yaar://storage/foo.txt` is a nice logical identifier.
- But once it becomes `/api/storage/foo.txt`, access depends on the route-level auth model, not the URI model.
- If the caller is an iframe app with broad same-origin access, the URI abstraction is not protecting anything by itself.

### My assessment

The idea is solid if you intend URIs to be:

- a canonical naming scheme
- a transport-independent API surface
- a typed resource layer for tools and AI orchestration

The idea is not sufficient on its own if you want URIs to act as a security boundary.

### What would make it much stronger

1. Centralize resolution and authorization together.
   - Do not just resolve `yaar://...` into `/api/...`.
   - Resolve into a typed internal object like `{ kind, absolutePath, sessionScope, readOnly, owner, appId }`.

2. Bind resource access to session/app identity.
   - Window URIs should always be checked against the active session.
   - App-facing access should be scoped to the app and the minimal host capabilities it needs.

3. Separate naming from capability.
   - Keep `yaar://...` as the stable resource name.
   - Use short-lived capability tokens or server-side policy objects when granting direct fetchable access.

4. Canonicalize file-backed authorities completely.
   - Current normalization is decent for traversal checks.
   - For stronger hardening, also use `realpath`/symlink-aware containment checks where file exposure matters.

5. Distinguish public app content from privileged host APIs.
   - `yaar://apps/...` is fine as a content address.
   - It should not imply that the loaded app gets broad host backend access.

### Bottom line on the URI idea

I would keep it.

It is one of the better architectural ideas in this codebase because it gives you a stable resource grammar across AI tools, frontend rendering, and storage/app workflows.

What needs work is not the existence of the URI layer. What needs work is turning it from "resource naming" into "resource naming plus scoped authorization."

## Recommended Next Steps

1. Keep the URI model, but move toward capability-aware resolution rather than direct path translation.
