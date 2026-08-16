# Apps

Convention-based: each folder here is one app. `app.json` for metadata/permissions/protocol
manifest, `protocol.json` (generated) for agent-iframe communication — AI context is built from
the two at read time, with `agent/prompt.md` as an opt-in full override. See
[`docs/guides/app-development.md`](../docs/guides/app-development.md) for the full URI-verb
reference and [`docs/reference/app_protocol_reference.md`](../docs/reference/app_protocol_reference.md)
for protocol details. For build/compile/verify workflows, use the `app-dev` skill.

## App Agent Architecture

An **app agent** is created on first interaction with one of an app's windows — one per
`monitorId::appId`, reused across all that app's windows on that monitor, **not** shared across
monitors — and retired, with its memory, when the app's **last** window on that monitor closes.

Four scoped tools: `describe` (the app's manual), `query` (read iframe state), `command` (execute
iframe action), `relay` (hand off to monitor agent) — plus `direct_message` when `app.json`
declares `"messaging": "all"`. `describe`/`query`/`command` take an optional `appId` for
cross-app control, gated by the caller's `app.json` `controls` list (**bundled apps only**).

`storage:*` built-ins are **declared, not automatic**: an agent holds them only if its `app.json`
names an entry under `yaar://storage/`, its own tree included. Every other app persists through a
command its `protocol.json` declares — the iframe holds the SDK, the agent calls the command by
name.

Full tool surface, lifecycle, and containment rules: the `server-verbs` skill
(`.claude/skills/server-verbs/SKILL.md`); [`packages/server/CLAUDE.md`](../packages/server/CLAUDE.md) for the map.

### Agent docs — three files, three readers

| File | Read by |
|---|---|
| `agent/prompt.md` | **Replaces** the app agent's base prompt entirely (no append tier). Either way the `protocol.json` manifest is appended as rendered call signatures. |
| `agent/hint.md` | The **monitor agent's** system prompt — orchestration hints, auto-synced with install/uninstall |
| `agent/SKILL.md` | No prompt. It is the hand-written manual `describe('yaar://apps/{id}')` returns — workflows, ordering, when *not* to use the app. `scripts/check/apps.ts` warns when it restates the protocol, which is served separately at `yaar://apps/{id}/protocol`. |

Paths are configurable via `app.json`'s `agent: { prompt, hint, skill }` (`AGENT_DOCS` in
`features/apps/discovery.ts`). Root `AGENTS.md` is deliberately **not** read as a prompt — it
keeps its ecosystem meaning (instructions to a coding agent editing that directory). The full
rules — override handling, legacy `HINT.md`, what clone and deploy carry — live in
`discovery.ts`'s doc comments.

Key server files: `agents/app-task-processor.ts` (routing), `agents/agent-pool.ts` (lifecycle),
`agents/profiles/app-agent.ts` (prompt builder), `mcp/app-agent/` (the four tools).

## Sub-agents (app-spawned AI instances)

An app declaring `"subagents": { "max": N }` in `app.json` can spawn up to N sub-agents from its
iframe via `yaar://apps/self/agents`: AI instances with an app-supplied system prompt, each its
own provider session and memory. They hold no YAAR verbs, no permissions, and no principal, and
may only be given tool names that route back to the app's own iframe.

`subagents` and `streams` are **granted by the user at install time**, not by the manifest alone
(unlike `controls`, which stays bundled-only) — the declaration is a *request*, recorded in
`config/app-grants.json` and applied as a **ceiling**.

Design record and the four laws every new node must satisfy: [`docs/architecture/agent_tree.md`](../docs/architecture/agent_tree.md).

## Links out of an app

An app frame is same-origin and unsandboxed, so a plain `<a href>` navigates the **app's own
document** — replacing every injected script with it, so the app protocol stops answering with no
exception and no console line. Three things keep that from happening, and none of them needs app
code:

- The injected **link guard** (`iframe-scripts/app-protocol.ts`) cancels the activation of any
  anchor in a registered app and hands the URL to the desktop.
- **`window.open(url)`** is overridden (`iframe-scripts/windows-sdk.ts`) to do the same, and
  returns a window-shaped stub so a caller's `if (!w)` popup-blocked fallback does not fire. A
  call with no URL, or a non-http(s) scheme, still reaches the browser.
- Either way the destination opens as a **YAAR window**, not a browser tab — and which kind of
  window is decided by asking the site first (`GET /api/embeddable`, read by
  `store/iframe-bridge/open-url.ts`). A framable site becomes an iframe window; one that refuses
  (`frame-ancestors` / `X-Frame-Options`) goes to the **Browser app** instead, which drives a real
  page server-side and so frames nothing. Framing is the target's call and no attribute of ours
  overrides it, which is why the answer is a different surface rather than a workaround.

Call it directly with `windows.openUrl(url, { title })` from `@bundled/yaar` — fire-and-forget,
since the desktop owns window creation. Don't hand-roll a click handler around `window.open` or a
clipboard fallback; that was the pre-`openUrl` workaround and it now just duplicates the shim.
`window.__yaarAllowPopups = true` opts out of the override, as `__yaarAllowFrameNavigation` opts
out of the link guard.

## Design Tokens

Single source of truth: `packages/shared/src/design/tokens.ts` generates both the app-iframe CSS
and the OS shell's `tokens.css` — never write token values by hand anywhere else. Run
`bun scripts/codegen/design-tokens.ts` to regenerate after token changes. Rules (chrome
vs content, exception registry): [`docs/architecture/design_system.md`](../docs/architecture/design_system.md).

All compiled apps get YAAR CSS custom properties and utility classes injected automatically:

- **Colors**: `--yaar-bg`, `--yaar-bg-surface`, `--yaar-text`, `--yaar-text-muted`, `--yaar-accent`, `--yaar-border`, `--yaar-success`, `--yaar-error`
- **Washes** (tinted backgrounds): `--yaar-wash-{accent,success,error,warning}` and a `-strong` (16%) variant of each, plus `--yaar-wash-accent-border` (35%). `color-mix()` over the color var, so they follow `.y-light` and any accent override — never hand-write `rgba(88,166,255,.1)` for a tint. A tinted *border* pairs a wash background with the **opaque** color token (`border-color: var(--yaar-success)`), as `.y-badge-*` does.
- **Spacing**: `--yaar-sp-1` through `--yaar-sp-6` (4px increments), `--yaar-sp-8`/`-10`/`-12` (32/40/48px)
- **Layout**: `y-app` (root container), `y-flex`, `y-flex-col`, `y-toolbar`, `y-sidebar`, `y-tabs`, `y-modal`, `y-empty` (centered placeholder with `y-empty-icon`)
- **Components**: `y-btn`, `y-btn-primary`, `y-btn-ghost`, `y-btn-danger`, `y-btn-warning`, `y-input`, `y-select`, `y-card`, `y-badge`, `y-spinner`, `y-toast`, `y-list-item` (interactive row with hover/`.active` states)
- **Status**: `y-wash-*` (tinted fill), `y-dot` + `y-dot-ok`/`-warn`/`-err`/`-accent`/`-pulse`, `y-progress` + `y-progress-fill` (add `y-progress-indeterminate` to the track for a sliding bar)
- **Typography**: `y-label` (uppercase muted section header), `y-truncate` (single-line), `y-clamp-2`, `y-clamp-3` (multi-line truncation)

Always use `var(--yaar-*)` for colors — never hardcode. Use `y-*` utility classes for common patterns.

## Solid.js Gotchas

Apps use Solid.js with `html` tagged templates (not JSX). Known issues:

- **Nothing may precede the first tag**: `solid-js/html` discards top-level text that appears before the template's first tag, and a template whose only top-level node is the expression makes it emit `.firstChild` with no parent. So `` html`${x}` ``, `` html`hi ${x}` ``, and `` html`hi` `` throw a stackless `SyntaxError`/`TypeError` from `new Function`, while `` html`lead <b>x</b>` `` silently drops `lead `. Wrap content in an element (`` html`<span>hi ${x}</span>` ``), or return the accessor (`() => x`) instead of wrapping it. The compiler fails the build on all four — see `guards/solid-html-guard.ts`.
- **`flex: 1` breaks reactivity**: Use `position: absolute; inset: 0` instead
- **Closing tags**: `</${Component}>` is auto-fixed by compiler plugin to `</>`
- **Event handler props**: Can re-fire during render if passed as reactive props — bind handlers outside reactive scope

## Compiler & Bundled Libraries

Apps compile via Bun into a single self-contained HTML file. Entry point is always `src/main.ts`.
The compiler injects design tokens, SDK scripts (capture, storage, verb, app-protocol, etc.), and
the bundled code. `@bundled/*` imports need no `npm install` — including the YAAR SDK
(`@bundled/yaar`) — and a few gated SDKs (`@bundled/yaar-dev`, `@bundled/yaar-web`,
`@bundled/yaar-ml`) require an entry under `app.json`'s `"bundles"`, or the compiler rejects the
import.

The authoritative library list is `BUNDLED_LIBRARIES` in
`packages/compiler/src/bundled/registry.ts`, also served at `GET /api/dev/bundled-libraries`.
Don't enumerate it here — `scripts/check/doc-freshness.ts` lints doc copies of that list for
drift, so point at the registry instead of restating it.

Notable libraries: `mermaid` — `renderMermaid()` returns token-themed, already-sanitized SVG; at
3.3 MB it is by far the largest, so import it only where diagrams are drawn. `dompurify` —
mandatory for any externally-sourced HTML. `mediabunny` — read/write/convert mp4/webm/mp3/wav,
frame-accurate and not real-time-bound like `MediaRecorder`. Compiler internals (shims, guards,
protocol extraction): [`packages/compiler/CLAUDE.md`](../packages/compiler/CLAUDE.md).
