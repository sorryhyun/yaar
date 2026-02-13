# YAAR (“AI OS”) Audit & Suggestions

Date: 2026-02-13

This document is a product + engineering audit of the `yaar/` codebase and its “AI OS” concept, with suggested nice-to-haves, killer features, and essential apps/capabilities to push toward “AI-to-do-everything” on a web platform.

Scope notes:
- Based on static reading of repository docs and source (not a full penetration test).
- Recommendations are prioritized for a future where YAAR is reachable beyond localhost (tunnel/LAN/public).

---

## 1) What YAAR Already Does Well (Strengths to Lean Into)

### 1.1 “AI OS” primitives are clean and scalable
- **Small OS Actions DSL** (`packages/shared/src/actions.ts`) keeps the AI control plane simple (window lifecycle, content updates, notifications, dialogs, desktop refresh).
- **Three-level runtime model** — `Session → Monitor → Window` (docs: `docs/monitor_and_windows_guide.md`) is a strong mental model for:
  - persistence (sessions survive disconnects),
  - concurrency (monitors/workspaces),
  - UI composition (windows as AI-driven surfaces).

### 1.2 Concurrency model is unusually solid for an AI UX
- **Main agent per monitor** + **window agents per window/group** + **ephemeral agents** + **task agents via `dispatch_task`** (docs: `docs/common_flow.md`, code: `packages/server/src/agents/*`) is a practical way to avoid “the whole UI blocks on one LLM call”.
- **Monitor budgets** already exist (`packages/server/src/agents/context-pool-policies/monitor-budget-policy.ts`), which is exactly what you need for background workflows.

### 1.3 App platform is real (not a toy)
- **Compiled apps** (iframe) + **App Protocol** (agent ↔ iframe) gives you a path to “rich UI + AI brain” without turning the server into a monolith.
  - App Protocol types + injected SDK: `packages/shared/src/app-protocol.ts`
  - Frontend relay: `packages/frontend/src/store/desktop.ts`
  - Server tools: `packages/server/src/mcp/window/app-protocol.ts`
- **Marketplace** exists (`packages/server/src/mcp/apps/market.ts`) and “desktop refresh” is wired.
- **App-dev toolchain** is cohesive (write → compile → deploy/clone) in `packages/server/src/mcp/dev/*` + `packages/server/src/lib/compiler/*`.

### 1.4 Baseline guardrails are present (good foundation)
- **Domain allowlist** and a **user-approved “request_allowing_domain”** flow (`config/curl_allowed_domains.yaml`, `packages/server/src/mcp/domains.ts`, `packages/server/src/mcp/http/permission.ts`).
- **Iframe fetch proxy** to enforce domain allowlist (`packages/shared/src/capture-helper.ts` + route `packages/server/src/http/routes/proxy.ts`).
- **Permissions memory** (`config/permissions.json`) via `packages/server/src/mcp/action-emitter.ts` and `packages/server/src/storage/permissions.ts` (plus dialogs in the frontend).

Takeaway: YAAR’s “OS-ness” is already credible. The next frontier is (a) platform hardening for remote access and (b) expanding capability via connectors + workflows + headless execution.

---

## 2) Non-Negotiables Before “Web Platform” (Must-Fix / Must-Design)

If you want “AI-to-do-everything” **and** remote access, the platform becomes a security product. These are the top risks.

### 2.1 Authentication + multi-tenancy boundary (critical)
Current state:
- Code/docs strongly indicate **no auth boundary** on WebSocket and `/api/*` endpoints (see `docs/beta_grounding_suggestions.md` “Authentication Boundary (Before Remote Exposure)”).
Why it matters:
- Without auth, any network-accessible deployment becomes “anyone can control your AI OS + read/write storage”.
Recommendations:
- Add an **auth middleware** for:
  - WebSocket upgrade (`/ws`)
  - all `/api/*` routes (especially `/api/storage/*`, `/api/apps/*`, `/api/sandbox/*`, `/api/fetch`)
- Add per-user or per-tenant roots:
  - storage isolation (`storage/{tenantId}/...`)
  - sessions isolation (`storage/sessions/{tenantId}/...`)
  - config isolation (`config/{tenantId}/...`) or separate config store
- Add **roles** for shared sessions:
  - `owner/admin` (full control),
  - `editor/controller`,
  - `viewer` (read-only).

Suggested minimal implementation path:
1. Introduce a `YAAR_AUTH_TOKEN` and require `Authorization: Bearer ...` for `/ws` and `/api/*`.
2. Add a `tenantId` claim (even if it’s 1 user initially) and route storage/sessions by tenant.
3. Add “remote safe mode” (`YAAR_REMOTE=1`) that disables high-risk capabilities by default (see 2.4).

### 2.2 App Protocol postMessage hardening (spoofing risk)
Current state:
- The frontend’s App Protocol response handler only checks `requestId` (see `packages/frontend/src/store/desktop.ts`, `handleAppProtocolRequest()`), and does **not** validate that the message came from the expected iframe window.
- The `yaar:app-ready` and `yaar:app-interaction` listeners (`packages/frontend/src/store/desktop.ts`, `initAppProtocolListeners()`) accept postMessages broadly and then try to map `e.source` to iframes, but there is no explicit trust model (origin allowlist, windowId binding, etc.).
Why it matters:
- Any script that can postMessage into the parent (including other iframes) may be able to spoof App Protocol responses, causing:
  - incorrect state reads,
  - executing unintended commands,
  - feeding the agent malicious “app_interaction” text (prompt injection vector).
Recommendations:
- In `handleAppProtocolRequest()`:
  - verify `e.source === iframe.contentWindow` (bind response to the iframe you sent the request to),
  - optionally verify `e.origin` when you expect same-origin apps,
  - treat cross-origin iframes as untrusted and disable App Protocol unless explicitly allowed.
- Add a **per-window secret handshake** (capability token):
  - parent generates `appProtocolToken` for the window,
  - inject token into iframe via querystring or injected script,
  - require token in every App Protocol request/response.
- Ensure `yaar:app-interaction` events are:
  - throttled,
  - sanitized/structured (avoid letting apps push arbitrary prompt text),
  - optionally require a user-visible permission for “app can message agent”.

### 2.3 Domain allowlist vs redirects & SSRF (critical)
Current state:
- MCP HTTP tools check allowlist only for the initial URL host and then allow redirects by default (`packages/server/src/mcp/http/request.ts`, uses `curl -L`).
- Iframe `/api/fetch` proxy enforces allowlist and blocks private hostnames (good), but currently does not re-check allowlist across redirects (Node fetch follows redirects by default unless `redirect: 'manual'`).
Why it matters:
- Redirect chains can “jump” from an allowed domain to a disallowed domain or private IP, enabling SSRF-like access.
Recommendations:
- Enforce allowlist **per redirect hop**:
  - either disable redirects by default and require explicit follow,
  - or follow manually, validating each `Location`.
- Apply **private network protections** consistently:
  - block `localhost`, RFC1918, link-local, IPv6 local, etc.
  - consider resolving DNS and blocking private IP results (stronger SSRF defense).
- Unify policy:
  - one “HTTP policy module” shared by MCP http tools and `/api/fetch`.

### 2.4 Sandbox execution trust model (for remote exposure)
Current state:
- `run_js` uses Node `vm` with restricted globals (`packages/server/src/lib/sandbox/*`).
Why it matters:
- Node `vm` is useful, but it is not a strong security boundary for hostile untrusted code in a multi-tenant hosted environment.
Recommendations:
- For remote/hosted mode:
  - move execution to an isolated worker (separate process/container/VM),
  - strict CPU/memory/time quotas,
  - file/network access mediated by explicit APIs.
- “Remote safe mode” (`YAAR_REMOTE=1`):
  - disable `run_js` and app-dev tools by default,
  - disable marketplace install by default,
  - require explicit user/owner approval per session to enable.

### 2.5 Marketplace supply chain hardening
Current state:
- `market_get` downloads a tarball and extracts it into `apps/` (`packages/server/src/mcp/apps/market.ts`).
Why it matters:
- Any public marketplace becomes a supply-chain attack surface (path traversal in archives, symlinks, malicious HTML, malicious postMessage behavior).
Recommendations:
- Safe extraction:
  - extract into a temp dir, validate file list (no `..`, no absolute paths, no symlinks), then move into place.
- App signing:
  - publish `manifest.json` + signature; verify signature on install/update.
- App permission model:
  - apps declare capabilities (App Protocol, storage access, fetch proxy usage, domain needs),
  - installing/updating an app triggers a permission dialog (“this app can message agent”, “this app can call /api/fetch”, etc.).

### 2.6 Secrets hygiene + log redaction
Current state:
- Apps can store secrets via `window.yaar.storage` (e.g., `apps/github-manager/src/main.ts` stores token in storage).
Why it matters:
- Logs, session transcripts, and UI captures can accidentally store secrets.
Recommendations:
- Introduce `config/credentials/*` as a first-class “vault” API for apps (not general storage).
- Add redaction rules in logging + transcript export.
- Add “secret fields” support in component DSL (`input variant=password` exists; ensure form values aren’t logged verbatim).

### 2.7 Iframe isolation, sandboxing, and CSP (critical for marketplace/hosting)
Current state:
- `IframeRenderer` disables the `sandbox` attribute for same-origin URLs (treats local apps as “trusted”): `packages/frontend/src/components/windows/renderers/IframeRenderer.tsx`.
- App/sandbox HTML responses set a very minimal CSP: `Content-Security-Policy: connect-src 'self'` for `.html` (`packages/server/src/http/routes/files.ts`).
Why it matters:
- A same-origin iframe without sandbox is effectively an **XSS-equivalent trust level**: the app can reach `window.parent`, read/modify DOM, intercept user input, and potentially exfiltrate data through same-origin APIs.
- If you ever install third-party/marketplace apps, “same-origin == trusted” becomes unsafe.
Recommendations:
- Introduce **app trust levels**:
  - `trusted` (local/dev apps you control): can run same-origin, optionally without sandbox.
  - `untrusted` (marketplace/third-party): must be sandboxed and ideally served from a separate origin.
- Strong option (best): serve apps from a **separate origin/subdomain** (per-tenant is even better):
  - isolates cookies/storage,
  - makes `postMessage` origin checks meaningful,
  - lets you enforce stricter CSP without breaking the desktop.
- If you keep same-origin hosting, sandbox untrusted apps without `allow-same-origin` and adjust server CORS to support `Origin: null` safely.
- Harden CSP for app HTML:
  - consider `default-src 'none'`, allow only what apps need (`script-src`, `style-src`, `img-src`, `connect-src`), and avoid remote script loads.
  - if you want to keep “single HTML with inline JS”, consider generating a CSP hash (sha256) at compile time and including it in headers/metadata.

### 2.8 Rate limiting, quotas, and cost controls
Why it matters:
- A public endpoint + tool execution + LLM calls can be abused for:
  - denial-of-service (CPU/memory),
  - runaway spend (provider tokens),
  - brute-force on integrations,
  - spam (notifications/windows).
Recommendations:
- Add rate limiting at multiple layers:
  - per-connection WS message rate
  - per-session tool calls/min
  - per-tenant bytes written to storage/day
  - per-tenant “LLM tokens budget” (soft + hard caps)
- Add “circuit breakers”:
  - disable a connector temporarily after repeated failures
  - pause workflows if error rate spikes
- Make budgets visible in a Task Manager / Admin window.

---

## 3) Product “Killer Features” (Highest Leverage for AI-to-Do-Everything)

### 3.1 Integrations as a first-class subsystem (“Connectors”)
Why:
- “AI does everything” becomes real when the system can act in external systems reliably and safely.
What to build:
- A connector framework that standardizes:
  - auth (OAuth/PAT/service keys),
  - scopes,
  - rate limits,
  - retries,
  - audit logs.
Targets (high ROI):
- Email + Calendar (Gmail/Google Calendar or MS Graph)
- Slack/Discord
- Notion/Confluence
- Jira/Linear/GitHub
- Drive/Dropbox
- CRM (HubSpot/Salesforce) if that’s your audience

Design note:
- Prefer “agent calls MCP tools” for API access (server-side) rather than iframes calling third-party APIs directly (CORS + secret management).

### 3.2 Workflow engine (“Hooks 2.0”)
Current:
- Hooks fire on `launch` or `tool_use` (`docs/hooks.md`, `packages/server/src/mcp/system/hooks.ts`).
Next:
- Add triggers:
  - `cron` / intervals (e.g., “every weekday 9am”),
  - `webhook` (e.g., GitHub events),
  - `app_event` (from App Protocol),
  - `storage_change` (file arrival),
  - `window_event` (close/focus/minimize).
- Add execution:
  - run workflows on background monitors with budgets,
  - store run history, errors, retries, and “last successful output”.

This becomes your “automation OS”.

### 3.3 Headless browser worker (real RPA)
Why:
- Many “do everything” tasks aren’t API-friendly (internal portals, forms, scraping, purchases with human approvals).
What:
- A Playwright-like worker exposed through MCP:
  - open page, click, type, wait, screenshot, extract DOM, download files.
  - domain allowlist + permission prompts.
  - human-in-the-loop approvals for dangerous actions.

### 3.4 Knowledge base + grounded memory (beyond `memory.md`)
Current:
- `memorize` appends sentences to `config/memory.md` and injects into prompts (`packages/server/src/agents/session.ts`).
Next:
- Build a real KB:
  - index session logs + storage docs + connector content,
  - retrieval with citations (“why the agent believes X”),
  - configurable retention and privacy.
- Add a “Sources” window that shows:
  - retrieved snippets,
  - timestamps,
  - origin (email/doc/link).

### 3.5 Capability graph / task manager
Why:
- Users need to trust and steer long-running autonomous behavior.
What:
- A built-in “Task Manager” app/window showing:
  - active agents, queued tasks, tool calls,
  - per-monitor budgets,
  - cancel/retry,
  - “what changed on the desktop”.

---

## 4) Platform Enhancements (Nice-to-Haves that Compound)

### 4.1 Expand OS Actions DSL carefully
Candidates (high value, bounded risk):
- Clipboard: `clipboard.read` / `clipboard.write` (permission-gated)
- File open/save dialogs: `file.pick` (scoped to storage)
- “Open external link” action with confirmation
- Window templates/presets for common UIs (table + filter + search)

Keep the DSL small; avoid turning it into a full GUI toolkit.

### 4.2 Component DSL “power primitives”
Current component DSL is intentionally minimal (`packages/shared/src/components.ts`).
High-ROI additions:
- `checkbox`, `radio`
- `date` input
- `table` (editable) + `dataGrid` semantics
- `tabs`
- `chart` (or a wrapper to Chart.js)
- `file` picker to storage
- `code` editor/viewer (for app-dev / configs)

Also consider:
- component-level **partial updates** (patch/ops) similar to `window.updateContent` for markdown/text.

### 4.3 Reliability: retries, idempotency, and “exactly once” UX
For “AI does everything”, reliability is product.
Recommendations:
- Tool calls:
  - standard retry policy (backoff, jitter),
  - idempotency keys for side-effecting requests (issue creation, payments, etc.),
  - structured errors surfaced in a consistent “Run Details” UI.
- State sync:
  - ensure window/app command replay is deterministic and bounded (already present for App Protocol command replay in `packages/server/src/session/live-session.ts`).

### 4.4 Observability + audit
Add:
- per-session audit log (who did what, when),
- tool call logs with redaction,
- event sequencing metrics (dropped events, resync frequency),
- optional OpenTelemetry traces for tool execution and provider turns.

---

## 5) Essential Apps for an “AI OS”

If you want a coherent platform (not just demos), build these “system apps”:

1. **Integrations / Accounts**
   - manage tokens, OAuth grants, scopes
   - per-connector enable/disable
   - domain allowlist UI
2. **Workflows**
   - cron + webhook automations
   - run history, retries, notifications
3. **Tasks / Projects**
   - personal to-dos + multi-step plans + delegation to agents
4. **Notes / Knowledge Base**
   - indexed notes, attachments, citations, search
5. **Task Manager**
   - running agents, budgets, tool calls, errors
6. **Settings / Security Center**
   - permissions.json viewer, revoke permissions, safe-mode toggles, session sharing controls

---

## 6) Expand Existing Apps (Concrete Ideas)

### 6.1 `github-manager`
Current:
- Token/PAT + OAuth device flow, list repos, list issues/PRs, create issue, App Protocol state/commands (`apps/github-manager/src/main.ts`).
Next features:
- PR review queue (requested reviews, assigned issues)
- “Triage” mode:
  - label + assign + close + comment templates
  - create tasks in your Tasks app
- Repo insights:
  - release notes generator
  - changelog draft
- Safety:
  - store token in `config/credentials/github-manager.json` (vault), not general storage

### 6.2 `recent-papers`
Current:
- Pulls HF/arXiv, filters, recommends top-2 by sending `app_interaction` (`apps/recent-papers/src/main.ts`).
Next:
- reading list saved to storage + tags
- weekly digest workflow (cron)
- export to BibTeX/Markdown
- “Ask agent about this paper” action that opens a dedicated window agent

### 6.3 `pdf-viewer`
Current:
- open PDF from file or storage path; export HTML→print; save export HTML to storage (`apps/pdf-viewer/src/main.ts`).
Next:
- highlight + annotation + extract quotes to Notes/KB
- “summarize selected pages” workflow (agent uses `/api/pdf/...` + storage)
- citation links back to page numbers

### 6.4 `excel-lite` / `word-lite` / `slides-lite`
Next:
- storage-backed import/export (CSV/XLSX; PDF/PPTX exports)
- App Protocol commands for “set cells”, “export document”, “apply template”
- “AI transform” button that asks agent to clean/reshape data

---

## 7) Roadmap (Phased)

### Phase 0: Platform readiness (security + correctness)
- Auth on `/ws` + `/api/*`
- Tenant isolation for storage + sessions
- App Protocol message validation + tokens
- Redirect-safe allowlist enforcement + SSRF hardening
- Remote safe mode defaults
- Marketplace safe extraction + signing plan

### Phase 1: Capability foundation
- Integrations subsystem (credentials vault + connectors)
- Workflows engine (cron/webhook/app_event) + run history
- Task Manager UI + audit log UI

### Phase 2: “Actually do things” execution
- Headless browser worker with approvals
- KB indexing + retrieval with citations
- Expanded component primitives (table, checkbox, tabs, file picker)

### Phase 3: Ecosystem + growth
- Public marketplace with signing + permissions
- Session sharing with roles + invite links/QR
- Mobile-optimized UI (docs already outline this path in `docs/beta_grounding_next.md`)

---

## 8) Engineering Checklists (Actionable)

### 8.1 Security checklist for “remote mode”
- [ ] Require auth for WebSocket + API
- [ ] Tenant isolation for all persisted data
- [ ] Rate-limit:
  - WS messages/sec
  - tool calls/min
  - storage writes/min
- [ ] SSRF mitigations:
  - allowlist per redirect hop
  - block private networks by hostname + DNS result
  - cap response size and timeouts (already partially present)
- [ ] App Protocol hardening:
  - bind response to iframe `e.source`
  - token handshake
  - throttle app-initiated interactions
- [ ] Redact secrets from logs/transcripts/snapshots
- [ ] Marketplace:
  - safe extraction
  - signature verification
  - permissions display on install/update
- [ ] Sandbox:
  - isolate execution (process/container) or disable in remote safe mode

### 8.2 Tests to add (high value)
- App Protocol:
  - rejects spoofed responses from wrong `e.source`
  - handles timeouts deterministically
- HTTP policy:
  - redirect chains validated per hop
  - private IP blocked
- Marketplace:
  - rejects archives with `..` paths or symlinks
- Permissions:
  - “remember always/deny always” honored across restarts

---

## 9) Bottom Line

YAAR already has the right “AI OS” spine: a small action language, durable sessions, parallel agent model, and an app platform with a real protocol boundary. To become an “AI-to-do-everything web platform,” the biggest unlocks are:
1) a hard security/tenancy boundary for remote access, and
2) connectors + workflows + headless execution as first-class capabilities.
