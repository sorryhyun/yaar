# Proposal: App Library Integration and Boundary Consolidation

**Status:** Draft — **Phases 1, 2, and 3 are implemented and removed from this document.** Phase numbering below is unchanged so existing references still resolve. Phases 4–5 and the formula-engine decision are open.
**Scope:** `apps/`, `packages/compiler`, `packages/shared`, `packages/server`, and app-development guidance
**Primary objective:** reduce repeated boundary code in bundled apps by standardizing safe HTML, HTTP, validation, persistence, and browser-session helpers without turning the app runtime into a general-purpose framework

## Summary

YAAR already gives apps a strong common foundation: Solid, app-scoped storage and DB APIs, protocol schema inference, proxied HTTP, and a curated `@bundled/*` library catalog. The remaining repetition is concentrated where apps cross a trust or runtime boundary:

- external JSON is frequently asserted into application types rather than validated;
- two browser-backed DCInside apps carry nearly identical managed-tab and remote-image code;
- Excel maintains a substantial formula evaluator whose most capable replacement carries a licensing decision.

The remaining phases address those seams in dependency order:

4. expose Zod for external and persisted-data validation;
5. extract only the generic browser-session behavior shared by multiple apps;
6. defer formula-engine replacement pending an explicit license and bundle-size decision.

### Completed phases

- **Phase 1 — safe rich-content boundary.** DOMPurify exposed as `@bundled/dompurify`; every untrusted-HTML sink routed through it.
- **Phase 2 — one HTTP contract.** `POST /api/fetch` sits behind the app-principal gate; `httpFetch` is exported from `@bundled/yaar` and is the single documented cross-origin contract. The four app-local response-envelope copies are gone. `yaar://http` accepts `delete` to clear the calling principal's cookie jar.
- **Phase 3 — existing-helper migration.** `wait`/`errMsg`/`defineCommand`/`appStorage`/lodash `debounce`/`@bundled/uuid`/`@bundled/date-fns` adopted where semantics matched. Direct `localStorage` in apps is zero. `scripts/check-apps.ts` (`bun run check:apps`) enforces the guardrails.

## Carried-forward constraints

Findings from the completed phases that later phases depend on. These are not history; violating them reintroduces a fixed bug.

- **DOMPurify does not close the `style`-attribute gap.** It does not CSS-parse attribute values, so `style` passes through verbatim. Phase 4's schema work must not assume a sanitizer has vetted anything beyond markup structure.
- **Template-rendered apps are not the injection risk surface; string-assembled markup is.** Apps rendering through Solid's tagged templates build DOM nodes rather than parsing markup.
- **A sweep of `apps/` does not enumerate the callers of an iframe-injected script.** `IframeRenderer.tsx` injects the fetch proxy into plain AI-generated iframe windows too, which mint a token with no `appId`. Any gate keyed on app identity must decide what plain windows do.
- **Single-pass call-site inventories are leads, not conclusions.** Phase 2's audit reported `mcp-manager` as having no live call site; it had one. Phase 3's audit counted five hand-typed handlers; there were seven.
- **A schema can typecheck perfectly and still be invisible to agents.** The static protocol extractor parses `params` as a *literal block* and cannot resolve an identifier reference, so hoisting a schema to a shared const silently drops `params` from the manifest. Verify protocol changes against `extractProtocolWithDiagnostics`, not just `tsc`.
- **A hand-typed handler parameter usually indicates a lossy schema**, not a lazy author — and the schema is what agents read. Fix the schema; the annotation then disappears on its own. `YaarInferSchema` supports `enum` → union and `additionalProperties` → `Record`; `anyOf`/`oneOf`/`$ref` fall back to `unknown`, which is the sanctioned annotate-and-suppress case.
- **Naive source-stripping breaks every static rule on Solid apps.** Blanking whole template literals hides real violations, because Solid apps put nearly all logic inside `html` tagged templates. Blank only template *text* segments and scan `${...}` interpolations as live code. Regex literals (`.replace(/"/g, …)`) must not be read as opening quotes.
- **`AgentContext` is rebuilt field by field in `runWithAgentContext`.** A new field must be added in *both* places or it is silently dropped.
- **Both app-development guides are parity-enforced.** Any phase that adds a `@bundled/*` entry must update `docs/guides/app-development.md` and `docs/ko/app-development.md`.
- **Deterministic content hashes must not become random identifiers.** `rss-reader` derives article ids from a djb2 hash of link/title; randomizing them would mark every article unread on each refresh.

## Current evidence

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

1. External and persisted data is validated at the boundary without requiring schemas for internal application state.
2. Generic browser-session behavior is shared without moving site-specific scraping into the platform SDK.
3. New bundled libraries remain opt-in and tree-shakeable; an app that does not use a feature should not pay for it.
4. Existing app protocol manifests, storage formats, and visible behavior remain compatible unless a migration explicitly versions them.

## Non-goals

- Building a component framework shared by all apps.
- Converting every date display to date-fns when `Intl` is already sufficient.
- Replacing domain-defining implementations merely because a larger library exists. Image Edit does not need a Konva rewrite, and the games do not need physics-engine migrations.
- Validating every internal value with Zod.
- Moving DCInside selectors, authentication flows, or gallery parsing into a generic YAAR SDK.
- Adopting a GPLv3 or proprietary formula engine implicitly.
- Optimizing for source line count without measuring bundle size and runtime behavior.

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

## Open follow-ups from completed phases

- **`no-native-dialogs` is still advisory**, with two violations: `devtools/src/main.ts:64` and `video-editor-lite/src/editor/edit-mode.ts:288`. The latter is not a simple text prompt — it renders a numbered list of up to 12 paths, parses the reply as either an index or a raw path, and distinguishes cancel (`null`) from empty string. A `showPrompt()` migration must preserve that distinction; the list-in-a-textbox pattern exists only to work around `window.prompt`'s single-line limit, so a real picker is the better fix. Promote the rule to ERROR once both are gone.
- **`marked-to-innerhtml` stays advisory at zero violations**, deliberately: regex cannot prove dataflow, so a hard failure would assert a guarantee the check does not provide. Zero violations is not the only precondition for promotion — provability is the other.
- **`rss-reader/src/fetcher.ts:24`** is `item.link || item.title || Math.random().toString()`, feeding a content hash. A feed item with neither link nor title gets a fresh id every fetch and can never stay marked read. Pre-existing; not fixed.
- **The verb path still passes no `cookieJarKey`**, so `invoke('yaar://http')` and the proxy path differ in cookie identity. Deliberate, but worth revisiting if a third caller appears.
- **`redirect: 'error'`** remains unrepresentable through the proxy and falls back to `'follow'`.

## Change inventory

### Compiler and dependencies

- `package.json` — catalog/compiler dependencies for the selected Zod entry.
- `packages/compiler/src/plugins.ts` — bundled-library mappings.
- `packages/compiler/src/bundled-types/index.d.ts` — Zod module types.
- `scripts/prebundle-libs.js` and compiler tests — executable and browser resolution coverage.

### Apps

- `recent-papers`, `rss-reader`, selected GitHub/auth and persisted-config paths — boundary schemas.
- `dc-comics`, `thesingularity-reader` — managed-tab extraction.

### Documentation and checks

- `docs/guides/app-development.md` and `docs/ko/app-development.md` — bundled libraries (parity-enforced).
- `apps/devtools/AGENTS.md` — authoring guidance for Zod.
- `scripts/check-doc-freshness.ts` — preserve bundled-library list parity.
- `scripts/check-apps.ts` — promote guardrail rules as their violation counts reach zero.

## Rollout order

1. Add Zod catalog support and pilot it in Recent Papers.
2. Reassess the browser-app duplication after HTML and HTTP convergence; extract only what still repeats.
3. Open a separate formula-engine decision only if Excel's evaluator becomes a product constraint.

## Required validation

Each phase keeps the normal repository baseline green:

- `bun run typecheck`;
- `bun run test`;
- `bun run build:apps`;
- `bun run check:docs`;
- `bun run check:apps`;
- executable library prebundling for changes to `BUNDLED_LIBRARIES`;
- targeted app preview/runtime checks for every migrated app;
- before/after `dist/index.html` sizes for every new bundled dependency.

Security-sensitive HTML and HTTP changes additionally require adversarial fixtures, not only happy-path snapshots.

## Success criteria

- external JSON entering reactive state has a schema at the unstable boundary;
- static and runtime protocol manifests continue to agree;
- non-consuming app output does not materially grow from optional catalog additions;
- generic browser-session behavior is shared without moving DCInside parsing into the SDK.

Already met by the completed phases, and to be kept met: compiled apps have one documented cross-origin HTTP contract with permission parity; raw YAAR HTTP response interfaces appear in app code only for genuine upstream protocols; direct `localStorage` use in apps is zero; hand-written sleep/error/UUID/relative-time/debounce helpers remain only where their semantics differ from the bundled helper.

## References

- Zod and Zod Mini: <https://zod.dev/packages/zod>, <https://zod.dev/packages/mini>
- HyperFormula licensing: <https://hyperformula.handsontable.com/docs/guide/licensing.html>

## Validation note

This proposal is based on static inspection of the current checkout and existing compiled app artifacts. No runtime benchmark, adversarial HTML test suite, dependency-size experiment, or app rerun was performed as part of the audit that produced it. Those checks are explicit acceptance work above rather than implied evidence.

A code-level fact-check pass (2026-07-19) verified the original claims against the checkout, confirming the SDK helper inventory and the DCInside helper duplication. The corrections that implementation produced are folded into "Carried-forward constraints" above.
