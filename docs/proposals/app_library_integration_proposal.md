# Proposal: App Library Integration and Boundary Consolidation

**Status:** Draft — Phase 1 (safe rich-HTML boundary) is implemented and removed from this document; phase numbering below is unchanged so existing references still resolve.
**Scope:** `apps/`, `packages/compiler`, `packages/shared`, `packages/server`, and app-development guidance
**Primary objective:** reduce repeated boundary code in bundled apps by standardizing safe HTML, HTTP, validation, persistence, and browser-session helpers without turning the app runtime into a general-purpose framework

## Summary

YAAR already gives apps a strong common foundation: Solid, app-scoped storage and DB APIs, protocol schema inference, proxied HTTP, and a curated `@bundled/*` library catalog. The remaining repetition is concentrated where apps cross a trust or runtime boundary:

- cross-origin HTTP has both a transparent `fetch()` proxy and raw `invoke('yaar://http')` clients with independently declared response envelopes;
- external JSON is frequently asserted into application types rather than validated;
- older apps still reimplement helpers already exported by `@bundled/yaar`, Lodash, UUID, and date-fns;
- two browser-backed DCInside apps carry nearly identical managed-tab and remote-image code;
- Excel maintains a substantial formula evaluator whose most capable replacement carries a licensing decision.

This proposal addresses those seams in dependency order:

2. make the existing cross-origin `fetch()` proxy permission-equivalent to the verb path, then standardize app HTTP on the normal `Response` API;
3. complete the migration to helpers that are already bundled;
4. expose Zod for external and persisted-data validation;
5. extract only the generic browser-session behavior shared by multiple apps;
6. defer formula-engine replacement pending an explicit license and bundle-size decision.

(Phase 1 — expose DOMPurify and establish one safe rich-content boundary — is done.)

## Current evidence

### HTTP has two overlapping client contracts

Compiled apps receive `IFRAME_FETCH_PROXY_SCRIPT`, which replaces cross-origin `window.fetch` and converts the proxy result back into a standard `Response`. The proxy path supplies the iframe token and uses an app-scoped cookie jar.

At the same time, `github`, `mcp-manager`, `dc-comics`, and `thesingularity-reader` call `invoke('yaar://http')` and each locally model their own subset of the proxy envelope: `mcp-manager` the full `{ ok, status, headers, body }`, `github` `{ ok, status, data, raw }`, `dc-comics` `{ ok, data }`, `thesingularity-reader` `{ ok, status, body }` — four shapes for one upstream contract. Binary responses add another local base64-decoding shape.

The paths are not yet permission-equivalent:

- `POST /api/verb` resolves an app principal and applies `requirePermission(..., 'yaar://http', 'invoke')`;
- `POST /api/fetch` validates an iframe token when present and enforces the domain gate, but does not currently apply the app's declared `yaar://http` permission;
- the proxy path has the cookie-jar identity that the verb handler currently lacks.

The client API should not be standardized until that authorization difference is closed.

### Existing helpers are only partially adopted

Concrete remaining cases include:

- local sleep/settle promises instead of `wait()`;
- repeated thrown-value formatting instead of `errMsg()`;
- direct `localStorage` persistence in `thesingularity-reader` despite `createPersistedSignal()` and app storage being available;
- five protocol handlers with separately written parameter annotations rather than `defineCommand()` inference;
- local UUID, relative-time, and debounce implementations where equivalent bundled helpers already exist.

### Runtime data is often asserted rather than validated

Zod is already present in the workspace catalog and used by shared/server packages, but it is not available through `@bundled/*`. Examples of unchecked app boundaries include:

- Hugging Face responses cast to `DailyPaperItem[]`;
- RSS2JSON items handled as `any`;
- GitHub's generic HTTP client returning `data as T`;
- persisted JSON returned as the requested generic type even when an older app version may have written a different shape.

### Browser-backed app code is duplicated

`dc-comics/src/helpers.ts` and `thesingularity-reader/src/helpers.ts` share almost all of their lazy-image resolution, placeholder detection, URL normalization, progressive loading, and time formatting. Their `browser.ts` modules also share open-or-navigate and close-tab lifecycle logic.

The domain selectors and authenticated workflows differ enough that the whole apps should not share a scraper library. The reusable seam is smaller: managed browser tabs and safe remote-content processing.

### Formula evaluation is a special case

`excel-lite/src/formula-utils.ts` implements parsing, references, ranges, functions, cycle checks, formula shifting, and dynamic numeric evaluation. HyperFormula covers that domain, but it is dual GPLv3/proprietary rather than Apache-2.0, so this is not a routine dependency substitution.

## Goals

1. App HTTP calls use one standard `Response` contract with identical permissions, domain prompts, cookies, redirects, timeouts, and binary behavior.
2. Existing SDK helpers replace local equivalents where semantics match.
3. External and persisted data is validated at the boundary without requiring schemas for internal application state.
4. Generic browser-session behavior is shared without moving site-specific scraping into the platform SDK.
5. New bundled libraries remain opt-in and tree-shakeable; an app that does not use a feature should not pay for it.
6. Existing app protocol manifests, storage formats, and visible behavior remain compatible unless a migration explicitly versions them.

## Non-goals

- Building a component framework shared by all apps.
- Converting every date display to date-fns when `Intl` is already sufficient.
- Replacing domain-defining implementations merely because a larger library exists. Image Edit does not need a Konva rewrite, and the games do not need physics-engine migrations.
- Validating every internal value with Zod.
- Moving DCInside selectors, authentication flows, or gallery parsing into a generic YAAR SDK.
- Adopting a GPLv3 or proprietary formula engine implicitly.
- Optimizing for source line count without measuring bundle size and runtime behavior.

## Phase 2: converge HTTP semantics and publish one client

### 2.1 Put `/api/fetch` behind the app-principal gate

Before recommending the patched fetch path, change `POST /api/fetch` to:

- require a valid iframe token for iframe-originated requests;
- resolve the request with `resolvePrincipal()`;
- call `requirePermission(principal, 'yaar://http', 'invoke')`;
- derive session and cookie-jar identity only from the validated principal;
- reject a stale or missing app token rather than treating the request as an unrestricted host request.

Requiring the token is compatible with the current callers: nothing in the frontend or host calls `POST /api/fetch` directly — only the injected fetch-proxy script does — so the route can become app-only without breaking any desktop flow. Host-side HTTP remains available through the existing agent/verb path. The public iframe route should be an app door, like `POST /api/verb`.

**Manifest sweep before enforcement.** Turning on `requirePermission` breaks any app that uses the transparent proxy today without declaring `yaar://http`. At the time of writing that set is exactly one app: Market Apps fetches its marketplace catalog cross-origin (`market-apps/src/api.ts`) with no `yaar://http` in its `app.json` (Anima's dynamic-URL fetches are all same-origin and unaffected). Before enforcement:

1. sweep every app for cross-origin `fetch()` and `invoke('yaar://http')` use and reconcile `app.json` permissions — starting with `market-apps`;
2. optionally run the gate in log-only mode for one release to catch dynamic URLs the sweep missed;
3. only then reject unpermitted requests.

This does not close the broader same-origin iframe trust gap documented elsewhere. It does make the intended token-bearing app path internally consistent.

### 2.2 Expose a typed `httpFetch`

Export a small helper from `@bundled/yaar`:

```ts
export function httpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return window.fetch(input, init);
}
```

The helper is intentionally thin. Its value is a named, documented contract:

- cross-origin calls use YAAR's SSRF-protected, allowlisted proxy;
- relative and same-origin calls retain normal fetch behavior and the iframe token;
- app manifests require `yaar://http` for proxied calls;
- responses use standard `Response`, `Headers`, `json()`, `text()`, `blob()`, and `arrayBuffer()` APIs.

Keep raw `invoke('yaar://http')` for agent code and advanced verb consumers during migration. Deprecate `window.yaar.fetch` once no app relies on it; it should not remain a second undocumented client.

### 2.3 Preserve advanced behavior

The canonical path must cover or explicitly reject:

- app-scoped cookie jars;
- manual versus followed redirects;
- binary responses;
- upstream response headers;
- the existing 10 MB body cap and 30-second server timeout;
- domain-approval prompts scoped to the correct session.

If `Request.redirect = 'manual'` cannot be represented through the proxy yet, add it deliberately instead of silently changing behavior.

### 2.4 Migrate app clients

Start with one low-risk JSON consumer such as `recent-papers` or `dock`. Then migrate:

- GitHub's `RawHttp` wrapper;
- MCP Manager's `HttpResult` wrapper while preserving JSON-RPC/SSE parsing;
- DCInside HTML and image fetches;
- remaining cross-origin direct calls.

The HTTP client normalizes transport only. Service-specific pagination, rate limits, JSON-RPC parsing, and response normalization remain in their apps.

### Phase 2 acceptance tests

- an app without `yaar://http` receives 403 from the proxy route;
- every app that used the transparent proxy before enforcement (notably Market Apps) has a reconciled manifest and still functions;
- a permitted app receives a normal `Response` for text, JSON, and binary fixtures;
- cookies are isolated by session and app;
- domain denial, timeout, oversized response, redirect, and upstream error behavior are covered;
- GitHub rate-limit headers and MCP session headers remain readable;
- no app-local duplicate of the YAAR proxy response envelope remains after migration.

## Phase 3: finish the existing-helper migration

| Repeated pattern | Existing replacement | Initial targets |
|---|---|---|
| `new Promise(resolve => setTimeout(resolve, ms))` | `wait(ms)` | Anima, Browser User, Market Apps, The Singularity Reader |
| ad hoc thrown-value formatting | `errMsg(error)` | Anima, Browser User, GitHub bootstrap, Search, Process Explorer, MCP Manager, The Singularity Reader |
| manual loading `try/catch/finally` | `withLoading()` | Configurations and single-operation loading flows where return semantics match |
| manual save timer | Lodash `debounce()` with `flush()`/`cancel()` | Devtools editor |
| local UUID fallback | `@bundled/uuid` | Slides Lite, RSS feed creation |
| hand-written relative time | `date-fns/formatDistanceToNow` | Slides Lite; RSS only if its compact wording is not intentional |
| direct `localStorage` | `createPersistedSignal()` or `appStorage` | The Singularity Reader `hideSpammer` setting |
| schema plus separately typed handler | `defineCommand()` | Image Viewer, Excel Lite, Devtools, Market Apps |

Do not force a helper where behavior differs. A debounce migration must preserve explicit-save flushing and dirty-state behavior; `createPersistedSignal` is not a substitute for multi-file or transactional storage; deterministic content hashes must not become random UUIDs.

### 3.1 Add static guardrails

Add an app-focused check for high-confidence anti-patterns:

- `localStorage` and `sessionStorage` under `apps/*/src`;
- native `alert`, `confirm`, and `prompt`;
- obvious promise-based sleep wrappers;
- manually typed command handlers whose literal schema can infer the type;
- `marked.parse()` results reaching `innerHTML` without an adjacent sanitizer.

The rich-HTML rule may begin as advisory because regex cannot prove full dataflow. Storage APIs and native dialogs can become hard failures, but only after a one-time sweep confirms the existing-use count is zero — an unknown legitimate use blocking unrelated deploys is worse than a week of advisory warnings. Start every rule advisory; promote to hard once its violation count reaches zero.

### Phase 3 acceptance tests

- explicit saves flush pending debounced work;
- app teardown cancels timers and debounced calls;
- persisted settings survive restart and failed writes are surfaced;
- static and runtime protocol manifests remain equal;
- helper migrations do not alter user-facing date or identifier semantics unintentionally.

## Phase 4: expose Zod for boundary validation

### 4.1 Add an app import

Expose `@bundled/zod` from the existing workspace dependency. Consider `@bundled/zod/mini` only after measuring both per-app and executable-prebundle cost. Zod's guidance recommends standard Zod for normal use and Zod Mini for unusually strict bundle constraints: <https://zod.dev/packages/mini>.

### 4.2 Validate at trust boundaries only

Initial schemas should cover:

- Recent Papers' Hugging Face list and detail responses;
- RSS2JSON's status and item array;
- configuration or persisted files that have already changed shape across versions;
- small GitHub response fragments used for authentication and rate-limit behavior, rather than exhaustively reproducing the entire GitHub API.

Preferred pattern:

```ts
const result = ApiResponse.safeParse(await response.json());
if (!result.success) throw new Error('The service returned an unsupported response.');
return normalize(result.data);
```

Schemas should accept additive upstream fields by default and validate only what the app uses. User-visible errors stay concise; full issues belong in console diagnostics.

### 4.3 Keep protocol JSON Schema authoritative

Do not introduce Zod as a second app-protocol schema language. `defineCommand()` already derives TypeScript parameters from the literal JSON Schema that agents and the compiler consume. Zod is for runtime data that did not pass through that contract.

### Phase 4 acceptance tests

- malformed and partially compatible fixtures produce deterministic fallbacks or clear errors;
- valid responses retain additive fields needed during normalization;
- app output growth is measured for standard Zod and Zod Mini before choosing the exposed path;
- protocol command definitions remain JSON-Schema-first.

## Phase 5: extract narrow browser-app primitives

After the safe-HTML and HTTP migrations make behavior explicit, add generic helpers to `@bundled/yaar-web` only where both DCInside apps still have the same contract.

Candidate API:

```ts
const tabs = createManagedTabs();

await tabs.openOrNavigate('post', url, {
  mobile: true,
  visible: false,
  waitUntil: 'networkidle',
});

await tabs.close('post');
```

The helper owns opened-tab bookkeeping and close cleanup. It must define what happens when a tab is closed externally; a local `Set` that permanently believes the tab exists is not sufficient as a platform abstraction.

Cookie-copy helpers may follow if their API can be domain-neutral. DCInside URL lists, selectors, lazy-image patterns, authentication workflows, and post parsing remain app code.

Create a new bundled content library only if a third app needs the remaining lazy-image behavior. Two domain siblings are not enough evidence for a general framework.

### Phase 5 acceptance tests

- reopen-after-external-close works;
- multiple named tabs remain isolated;
- cleanup closes only tabs owned by the app instance;
- both DCInside apps delete their local lifecycle copies without moving domain parsing into the SDK.

## Formula engine decision

Do not add HyperFormula in this proposal.

Before replacing Excel Lite's evaluator, require a separate decision record covering:

- GPLv3 obligations versus a proprietary license for an Apache-2.0 project;
- executable and per-app bundle-size impact;
- compatibility with current formulas, error strings, formula shifting, import/export, and undo history;
- whether dependency-graph recalculation is an actual user requirement;
- migration behavior for saved workbooks.

HyperFormula is a credible technical option, not a dependency to slip into a cleanup phase. Licensing reference: <https://hyperformula.handsontable.com/docs/guide/licensing.html>.

Retain the current engine until that decision. In the meantime, add focused tests around nested calls, quoted strings, ranges, circular references, and formula shifting. These tests should include adversarial formula fixtures, not only behavior snapshots: the evaluator's final step is a `new Function(...)` call guarded by a numeric-charset regex, so the regex is the entire boundary between formula input and dynamic evaluation and deserves direct negative tests.

## Change inventory

### Compiler and dependencies

- `package.json` — catalog/compiler dependencies for the selected Zod entry.
- `packages/compiler/src/plugins.ts` — bundled-library mappings.
- `packages/compiler/src/bundled-types/index.d.ts` — Zod module and `httpFetch` types.
- `packages/compiler/src/shims/yaar.ts` — `httpFetch` export and documentation.
- `scripts/prebundle-libs.js` and compiler tests — executable and browser resolution coverage.

### Server and shared runtime

- `packages/server/src/http/routes/proxy.ts` — principal and permission enforcement.
- `packages/server/src/features/http/fetch.ts` — only if redirect or response semantics need extension.
- `packages/shared/src/iframe-scripts/fetch-proxy.ts` — canonical proxy behavior and deprecation path for duplicate clients.
- HTTP route/access tests — denied permission, token identity, cookies, binary bodies, limits, and errors.

### Apps

- `github`, `mcp-manager`, `dc-comics`, `thesingularity-reader`, plus simple canary consumers — HTTP convergence.
- `market-apps/app.json` (and any other manifest the pre-enforcement sweep surfaces) — `yaar://http` permission reconciliation.
- `recent-papers`, `rss-reader`, selected GitHub/auth and persisted-config paths — boundary schemas.
- Anima, Browser User, Market Apps, The Singularity Reader, Devtools, Slides Lite, Image Viewer, and Excel Lite — existing-helper cleanup.

### Documentation and checks

- `docs/guides/app-development.md` and `docs/ko/app-development.md` — bundled libraries and canonical HTTP.
- `apps/devtools/AGENTS.md` — authoring guidance for Zod and `httpFetch`.
- `scripts/check-doc-freshness.ts` — preserve bundled-library list parity.
- a new or existing app anti-pattern check — high-confidence guardrails.

## Rollout order

1. Sweep app manifests for undeclared transparent-proxy use (Market Apps first), then secure `/api/fetch` and add permission/cookie tests before publishing `httpFetch` as canonical.
2. Migrate one simple HTTP consumer as a canary, then the raw-envelope clients.
3. Land the existing-helper sweep in app-sized changes.
4. Add Zod catalog support and pilot it in Recent Papers.
5. Reassess the browser-app duplication after HTML and HTTP convergence; extract only what still repeats.
6. Open a separate formula-engine decision only if Excel's evaluator becomes a product constraint.

## Required validation

Each phase keeps the normal repository baseline green:

- `bun run typecheck`;
- `bun run test`;
- `bun run build:apps`;
- `bun run check:docs`;
- executable library prebundling for changes to `BUNDLED_LIBRARIES`;
- targeted app preview/runtime checks for every migrated app;
- before/after `dist/index.html` sizes for every new bundled dependency.

Security-sensitive HTML and HTTP changes additionally require adversarial fixtures, not only happy-path snapshots.

## Success criteria

- compiled apps have one documented cross-origin HTTP contract with permission parity;
- raw YAAR HTTP response interfaces disappear from app code except for genuine upstream protocols;
- direct `localStorage` use in apps is zero;
- hand-written sleep/error/UUID/relative-time/debounce helpers remain only where their semantics differ from the bundled helper;
- external JSON entering reactive state has a schema at the unstable boundary;
- static and runtime protocol manifests continue to agree;
- non-consuming app output does not materially grow from optional catalog additions.

## References

- Zod and Zod Mini: <https://zod.dev/packages/zod>, <https://zod.dev/packages/mini>
- HyperFormula licensing: <https://hyperformula.handsontable.com/docs/guide/licensing.html>

## Validation note

This proposal is based on static inspection of the current checkout and existing compiled app artifacts. No runtime benchmark, adversarial HTML test suite, dependency-size experiment, or app rerun was performed as part of the audit that produced it. Those checks are explicit acceptance work above rather than implied evidence.

A code-level fact-check pass (2026-07-19) verified the claims above against the checkout. It confirmed the `/api/verb` vs `/api/fetch` permission asymmetry, the SDK helper inventory, and the DCInside helper duplication. It also produced the corrections now folded in: the four raw-HTTP envelope shapes are distinct subsets rather than one shared shape, and Market Apps uses the transparent proxy without declaring `yaar://http` (hence the pre-enforcement manifest sweep).

Implementing Phase 1 settled three things worth carrying into the later phases:

- **The Korean guide is now parity-enforced.** `check-doc-freshness.ts` covers `docs/ko/app-development.md`, which had already drifted by six libraries. Any phase that adds a `@bundled/*` entry must update both guides.
- **A repo-wide sweep found the sink inventory was incomplete.** The proposal listed seven rich-HTML apps; `recent-papers` was an eighth. The other ~24 apps have zero injection sinks because they render through Solid's tagged templates, which build DOM nodes rather than parsing markup. Assume the same for future audits: template-rendered apps are not the risk surface, string-assembled markup is.
- **One claim above was wrong and is corrected here:** DOMPurify does *not* close the `style`-attribute gap. It does not CSS-parse attribute values, so `style` passes through verbatim. The listed `<svg>`/`<math>` mXSS, `formaction`, and `xlink:href` gaps do close. Phase 4's schema work should not assume a sanitizer has vetted anything beyond markup structure.
