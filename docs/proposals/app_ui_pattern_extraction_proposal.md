# Proposal: Extracting Repeated App UI Patterns into the SDK

**Status:** Draft (Tier 1 landed; Tiers 2–3 proposed here)
**Scope:** `packages/shared/src/design` (Tier 1, done), `packages/compiler/src/shims/yaar` (Tier 2), app docs (Tier 3)
**Consumers:** `user-apps/word-lite`, `user-apps/slides-lite`, `apps/storage` — and future document/browser-style apps

## Summary

Three apps independently re-implemented the same "document app" surface: a top identity
bar, an inline-editable title, a formatting toolbar, an autosave/dirty/save-status store,
and a hover-expand + pin sidebar. The duplication spans CSS, behavior, and markup. We
extract each **into the home that matches its loading cost**, so the shared surface grows
only where it must:

| Tier | What's duplicated | Home | Cost to `@bundled/yaar` JS |
|---|---|---|---|
| **1 (done)** | Chrome CSS (`.topbar`/`.tb-btn`/`.brand`/`.doc-title`/`.statusbar`) | Design-token layer → injected `y-*` classes | **0 bytes** — injected CSS every app already gets |
| **2** | Behavior state machines (collapsible panel, autosave store) | `@bundled/yaar` **headless primitives** | small, **tree-shaken** — apps that don't import pay nothing |
| **3** | Rendered markup (topbar template, thumbnail list) | **Stays in the app** | 0 — the SDK never ships `solid-js/html` templates |

## Governing principles (why this won't bloat the SDK)

The worry that motivated this proposal — "I don't want the SDK to be too gigantic" — is a
worry about **JS bytes and API surface**, not about CSS. Three rules keep both bounded:

1. **CSS is the free layer; push visual patterns there first.** The compiler injects
   `YAAR_DESIGN_TOKENS_CSS` into every app regardless. Adding `y-*` classes there costs
   ~1 line each and removes ~200 lines from every consuming app. It never touches the
   importable SDK. Most visual duplication is CSS-only and belongs here.
2. **Headless only — behavior, never markup.** A Tier-2 primitive returns *state and
   handlers*; the app owns the DOM. This is the shape the SDK already uses
   (`createPersistedSignal`, `withLoading`, `onShortcut`). It keeps each primitive small,
   framework-light, and composable — and it means we never drag Solid rendering, icon
   sets, or layout opinions into the SDK's type surface. Rendered components (Tier 3)
   stay in apps.
3. **Rule of three.** Promote a pattern only once it's duplicated in ≥3 places (or 2 apps
   + a bundled app). Everything below clears it. This is the gate that stops the SDK from
   accreting one-off helpers.

Because Bun tree-shakes the bundle, adding a Tier-2 export does **not** grow the output of
an app that doesn't import it. The real budget being spent is *maintenance surface and
cognitive load* — which rules 2 and 3 cap directly.

---

## Tier 1 — Chrome CSS (landed)

Added a `y-*` "document-app chrome" family to `buildAppTokensCss()`
(`packages/shared/src/design/app-css.ts`, +38 lines): `y-appbar`, `y-appbar-actions`,
`y-brand`/`-badge`/`-name`, `y-doc-field`/`y-doc-icon`/`y-doc-input`, `y-editbar`,
`y-tgroup`, `y-tsep`, `y-tbtn`(`-text`/`-primary`/`-active`), `y-tlabel`, `y-tselect`,
`y-chip`(`-warning`/`-muted`).

The raw GitHub blues the apps had hardcoded (`#58a6ff`, `#1f6feb`, `rgba(88,166,255,…)`)
are **re-derived from accent tokens** here, converting palette drift into generated CSS
that recolors with the theme — per the design constitution's "one rule". Brand badges keep
an `accent-emphasis` default and let the app override the fill for brand identity (the
registered escape hatch for brand accents).

`describeDesignTokens()` auto-extracts class names from the CSS, so the new chrome is
**advertised to app agents for free** — no hand-maintained list.

**Migration status:** `word-lite` done (`styles.css` 364 → 143 lines; compiles clean).
Remaining consumer: `slides-lite` (near-identical chrome, plus a few local variants —
`y-tbtn` bordered/danger, numeric ratio inputs, `.chip.dirty` → `y-chip-warning`).
`storage` shares the toolbar/list vocabulary but its chrome is a nav overlay, less of a
Tier-1 consumer.

---

## Tier 2 — Headless behavior primitives

Two state machines are near-verbatim clones today. Both become small primitives in the
existing internal modules of the SDK (`reactive.ts`), keeping the public surface one
module while the ownership stays clean. No new `@bundled/yaar/*` subpath.

### 2a. `createCollapsiblePanel` — the hover-expand + pin sidebar

**Duplicated in:** `storage/src/navOverlay.ts` (111 lines) ≈ `slides-lite/src/sidebar.ts`
(92 lines). Same machine: visible when pinned or hovered; a grace period before collapse
so a brief cursor exit doesn't flicker; pin state persisted to `appStorage` with a
touch-guard so a user toggle that lands before the async load still wins. The comments in
both files even cross-reference each other. `storage` adds one extra concern: a `resizing`
flag that suppresses the auto-close while the width handle is being dragged.

```ts
function createCollapsiblePanel(opts?: {
  pinKey?: string;          // appStorage key; omit to make pin session-only
  closeDelayMs?: number;    // default 280
  pinLabel?: string;        // toast label on a failed pin persist
}): {
  expanded: () => boolean;  // pinned() || hovering()
  pinned: () => boolean;
  open(): void;             // cancel close + show
  scheduleClose(): void;    // arm the delayed fold (no-op while resizing)
  close(): void;            // fold now; pinned still wins
  togglePin(): void;
  setPin(v: boolean): void;
  setResizing(active: boolean): void;  // covers storage's drag case
};
```

~55 lines, replacing ~200. Both apps keep their own markup and pointer wiring; only the
state machine is shared. `storage`'s `closeNavAfterSelect()` becomes
`if (!panel.pinned()) panel.close()` at the call site.

### 2b. `createAutosave` — dirty / debounced save / save-status

**Duplicated in:** `slides-lite/src/store.ts` ≈ `word-lite/src/documents.ts`. Both wrap a
save with: a debounce, a `dirty`/`saveFailed`/`lastSavedAt` triad, and an **`editSeq`
guard** — a monotonic counter so a save that began before the latest edit does not clear
the dirty flag (otherwise the status chip reads "Saved" over unsaved changes). This is the
subtle half `createPersistedSignal` does *not* cover: `createPersistedSignal` owns the
*storage*; `createAutosave` owns the *save lifecycle and its status*.

```ts
function createAutosave<T>(
  save: (value: T) => Promise<boolean>,   // returns ok; false ⇒ stays dirty
  opts?: { debounceMs?: number; onSaved?: () => void },
): {
  markDirty(value: T): void;    // bump editSeq, set dirty, schedule debounced save
  flush(withToast?: boolean): Promise<void>;  // save now (e.g. Ctrl+S)
  dirty: () => boolean;
  saveFailed: () => boolean;
  lastSavedAt: () => number;
  statusLabel: () => string;    // "Saving…" | "Saved 14:22" | "Not saved"
};
```

`statusLabel()` centralizes the chip text both apps format by hand, and pairs with the
Tier-1 `y-chip` classes. ~50 lines, replacing the hand-rolled save loop in each app.
`lodash.debounce` stays an app dependency or is inlined (the SDK already avoids pulling
lodash into its own surface).

**Dependency note:** both primitives import `createSignal` from `solid-js` — already how
`reactive.ts`/`createPersistedSignal` work, so no new dependency and Solid stays the one
framework the reactive module assumes.

---

## Tier 3 — Rendered markup stays in apps

The topbar template, the slide thumbnail list, and the export-chip cluster are genuinely
similar shapes but carry app-specific content (word's formatting buttons vs slides' ratio
controls vs storage's file rows). Putting `solid-js/html` templates in the SDK would:

- drag Solid rendering, an icon set, and layout decisions into the SDK's public type
  surface — the exact "gigantic" outcome we're avoiding;
- couple every app to one component's prop shape, so a change for one app risks the others;
- fight the flat, headless philosophy that keeps Tier 2 cheap.

**Instead:** with Tier 1 (`y-*` chrome classes) and Tier 2 (headless state) in place, the
remaining per-app markup is short and readable — an appbar is now
`<div class="y-appbar">…</div>` with the app's own brand and buttons. We capture the
*shape* as a copy-paste snippet in `docs/guides/app-development.md` ("document-app
skeleton"), not as code. A snippet an agent or human pastes and edits beats a component
whose props ossify.

One optional, safe extraction if a third consumer appears: a **pure formatter**
`saveStatusLabel(state)` — but `createAutosave.statusLabel()` already covers it, so no
separate export is warranted now.

---

## Rollout

1. **Tier 1 (done):** chrome family + `word-lite`. Follow-up: migrate `slides-lite`, then
   audit `storage`'s toolbar for reuse.
2. **Tier 2a:** land `createCollapsiblePanel`; migrate `storage/navOverlay.ts` and
   `slides-lite/sidebar.ts` (the most exact clone — ~200 lines → one primitive).
3. **Tier 2b:** land `createAutosave`; migrate `slides-lite/store.ts` and
   `word-lite/documents.ts`.
4. **Tier 3:** add the document-app skeleton snippet to the app-development guide.

Each step is independently shippable and independently reversible. Update
`packages/compiler/CLAUDE.md`'s shim inventory as Tier-2 exports land.
