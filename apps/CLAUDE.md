# Apps

Convention-based: each folder here is one app. `app.json` for metadata/permissions/protocol
manifest, `protocol.json` (generated) for agent-iframe communication — AI context is built from
the two at read time, with `agent/prompt.md` as opt-in app-specific prompt after the shared intro. See
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

`storage:*` built-ins are held by **every** app agent, no declaration needed: they reach the app's
own tree (`app/{path}`, which needs no permission) and the commons
(`shared/{path}` = `yaar://storage/shared/`, granted for being an app). The two relative prefixes
are how a path says which tree it is in — a bare relative path still means the own tree, and the
door prints the `app/` form on every listing entry and receipt. Anything further under `yaar://storage/`
still costs an entry in `app.json`. A `protocol.json` command that persists on the agent's behalf
is still the better door when the app has one — it keeps the app's own invariants, and the UI reads
the state it writes. An app can make that door *the* door: a command named `storage:read` /
`storage:write` / `storage:delete` / `storage:list`, or one aliased to that name, **overrides**
the built-in for every ungated path — the own tree (`app/{path}`, or bare) and the commons
(`shared/{path}` / `yaar://storage/shared/…`) — so the agent keeps the spelling it was taught and the app's handler
answers (`mcp/app-agent/storage-override.ts`). The rest of the shared tree never overrides; its
permission gate stays between the agent and the bytes.

Full tool surface, lifecycle, and containment rules: the `server-verbs` skill
(`.claude/skills/server-verbs/SKILL.md`); [`packages/server/CLAUDE.md`](../packages/server/CLAUDE.md) for the map.

### One window, several copies

A window runs once **per connected desktop**: a phone plus the companion tab is two iframes, each
with its own memory. A `command` reaches exactly **one** of them (the server pins a responder,
because running it in both would do its side effects twice), so state a command sets in a plain
signal changes that copy's screen and no other, and the user watches the agent work while
nothing happens on theirs. State the view renders *because of a command* goes in
`createSharedSignal(key, initial, { onRemote })` from `@bundled/yaar`: the server holds it per
window, every copy follows, and `onRemote` redoes whatever side effects the writing copy performed
(reload a buffer, refresh a listing). Data that already lives server-side and is re-read on a
`subscribe` ping (`appDb.createReactiveCollection`, a storage file you watch) is fine as is.

### Agent docs — four surfaces, four readers

| File | Read by |
|---|---|
| `agent/prompt.md` | Appended after the shared intro (`profiles/app-agent/prompts/intro.md`), which is always first and already states what YAAR is and the agent's role — so write about the app and how to drive it, never "You are …". Either way the `protocol.json` manifest is appended as rendered call signatures. |
| `agent/hint.md` | The **monitor agent's** system prompt — orchestration hints, auto-synced with install/uninstall |
| `agent/SKILL.md` | No prompt. It is the hand-written manual served at `read('yaar://apps/{id}/skill')` — `describe` lists only its `##` headings — workflows, ordering, when *not* to use the app. `scripts/check/apps.ts` warns when it restates the protocol, which is served separately at `yaar://apps/{id}/protocol`. |
| `agent/docs/*.md` | Nobody, until pulled. One topic per file, frontmatter-indexed (`name`, a trigger-shaped `description`, `audience: agent\|dev\|both`); only the **index** is generated into the app agent's prompt and `describe` payloads. Served at `yaar://apps/{id}/docs/{name}`, via `describe({ topic })` on the app agent's tool, and as plain files in a clone. `features/apps/docs.ts` owns the tier; `scripts/check/apps.ts` validates frontmatter and warns when `prompt.md` restates a topic. |

Paths are configurable via `app.json`'s `agent: { prompt, hint, skill }` (`AGENT_DOCS` in
`features/apps/discovery.ts`); `agent/docs/` is a fixed location. Root `AGENTS.md` is **not**
read as a prompt: it is instructions to a coding agent editing that directory. The full rules — override handling, legacy `HINT.md`,
what clone and deploy carry — live in `discovery.ts`'s and `docs.ts`'s doc comments.

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
exception and no console line. **`iframe-scripts/windows-sdk.ts` owns all of this**, and none of
it needs app code:

- The **link guard** cancels the activation of every anchor in an app and hands the URL to the
  desktop — `target="_blank"`, a middle click and a ctrl/cmd-click included. It stands aside only
  for activations that do *not* replace the document (a `download`, a right click, an alt-click,
  a target the app itself frames) and for the two cooperation points below.
- **`window.open(url)`** is overridden to do the same, and returns a window-shaped stub so a
  caller's `if (!w)` popup-blocked fallback does not fire. A call with no URL, or a non-http(s)
  scheme, still reaches the browser.
- Either way the destination opens as a **YAAR window**, not a browser tab — and which kind of
  window is decided by asking the site first (`GET /api/embeddable`, read by
  `store/iframe-bridge/open-url.ts`). A framable site becomes an iframe window; one that refuses
  (`frame-ancestors` / `X-Frame-Options`) goes to the **Browser app** instead, which drives a real
  page server-side and so frames nothing.

**Do not write a link handler** (a capture-phase anchor listener, a resolver, an `openExternal`
wrapper around `window.open`, a clipboard fallback); all of it is the default. The app-facing
surface is two things the default cannot know:

- **Which site a relative href belongs to.** An app rendering someone else's HTML has `/board/123`
  in it, and resolving that against the app's own document lands on a shell 404. Declare it in
  `app.json`: `"links": { "base": "https://m.dcinside.com" }`. The compiler bakes it in as `window.__yaar_links__`.
- **Whether a URL is really yours.** `links.onOpen((url, anchor) => …)` from `@bundled/yaar`, once
  at module scope: return a **string** to open something else (unwrap a redirect interstitial,
  canonicalize a mirror), **`false`** to claim the link and route it in-app with no window at all,
  or nothing for the default. It also runs for `window.open`, but not for your own `links.open`
  calls — those already name their destination.

To open a URL yourself, call `links.open(url, { title })` (or the identical `windows.openUrl`) —
fire-and-forget, since the desktop owns window creation. `links.resolve(href)` gives the guard's
own answer for a control that opens a URL without being an anchor.
`window.__yaarAllowPopups = true` opts out of the `window.open` override, as
`__yaarAllowFrameNavigation` opts out of the link guard.

### Links *into* an app

An app can also be where links to a site *land* — a github.com link in a memo window reaching
the GitHub app instead of the Browser app. Your side of that is one command:

```ts
openUrl: {
  description: 'Show a github.com URL in this app',
  params: z.object({ url: z.string() }),
  run: async (p) => ({ handled: await routeGitHubUrl(p.url) }),
}
```

**The app does not declare which site is "its".** That is a `link_open` hook in the user's
`config/hooks.json` naming a URL pattern and your app id (see
[hooks](../docs/guides/hooks.md#link-handling)); a claim in `app.json` would take the site over
on every desktop the app is installed on. Write the command; the user decides whether it is
called, and `describe`-ing an `openUrl` command is what lets an agent offer to write the rule.

Three rules follow, all in `store/iframe-bridge/open-url.ts`:

- `openUrl` must answer `{ handled: true }`, or `{ handled: false }` for a URL under the site
  the app has no view for (`github.com/settings` is not a repository). Anything else — an error,
  no reply — reads as "not mine" and the link continues to the framing probe.
- **A closed app is opened to take the link**, and closed again if it answers `{ handled: false }`.
  So `openUrl` may be the first thing your app is ever asked — it runs against a freshly mounted
  app, after `defineApp` registration and not before it. The desktop reports the window to the
  agent only once the app has taken the link.
- A link is **never handed back to the window it came from**. That app already saw it through
  `links.onOpen` and let it go (an "open the real page ↗" anchor). Mark those anchors
  (`data-external`) and let the hook pass them through.

Links inside your own content are handled by `links.onOpen`, with no hook rule needed.

## Design Tokens

Single source of truth: `packages/shared/src/design/tokens.ts` generates both the app-iframe CSS
and the OS shell's `tokens.css` — never write token values by hand anywhere else. Run
`bun scripts/codegen/design-tokens.ts` to regenerate after token changes. Rules (chrome
vs content, exception registry): [`docs/architecture/design_system.md`](../docs/architecture/design_system.md).

All compiled apps get YAAR CSS custom properties and utility classes injected automatically:

- **Colors**: `--yaar-bg`, `--yaar-bg-surface`, `--yaar-text`, `--yaar-text-muted`, `--yaar-accent`, `--yaar-border`, `--yaar-success`, `--yaar-error`
- **Washes** (tinted backgrounds): `--yaar-wash-{accent,success,error,warning}` and a `-strong` (16%) variant of each, plus `--yaar-wash-accent-border` (35%). `color-mix()` over the color var, so they follow `.y-light` and any accent override — never hand-write `rgba(88,166,255,.1)` for a tint. A tinted *border* pairs a wash background with the **opaque** color token (`border-color: var(--yaar-success)`), as `.y-badge-*` does.
- **Spacing**: `--yaar-sp-1` through `--yaar-sp-6` (4px increments), `--yaar-sp-8`/`-10`/`-12` (32/40/48px)
- **Layout**: `y-app` (root container), `y-flex`, `y-flex-col`, `y-toolbar`, `y-statusbar` (each with a `-dense` modifier for IDE density), `y-sidebar`, `y-tabs`, `y-modal`, `y-empty` (centered placeholder with `y-empty-icon`)
- **Components**: `y-btn`, `y-btn-primary`, `y-btn-ghost`, `y-btn-danger`, `y-btn-warning`, `y-input`, `y-select`, `y-card`, `y-badge`, `y-spinner`, `y-toast`, `y-list-item` (interactive row with hover/`.active` states)
- **Status**: `y-wash-*` (tinted fill), `y-dot` + `y-dot-ok`/`-warn`/`-err`/`-accent`/`-pulse`, `y-progress` + `y-progress-fill` (add `y-progress-indeterminate` to the track for a sliding bar)
- **Typography**: `y-label` (uppercase muted section header), `y-truncate` (single-line), `y-clamp-2`, `y-clamp-3` (multi-line truncation)
- **Scrollbars**: every scrollbar in the app is already styled (the same thin pill the shell uses) — don't hand-roll `::-webkit-scrollbar` rules. `y-scroll` is just `overflow-y: auto`. Retint with `--yaar-scrollbar-thumb` / `--yaar-scrollbar-thumb-hover`; hide one with `scrollbar-width: none`. **Never set `scrollbar-color`** (or a non-`none` `scrollbar-width`): in Chromium either one, inherited, switches the whole subtree back to the native bar.

Always use `var(--yaar-*)` for colors — never hardcode. Use `y-*` utility classes for common patterns.

## Solid.js Gotchas

Apps use Solid.js with `html` tagged templates (not JSX). Known issues:

- **Nothing may precede the first tag**: `solid-js/html` discards top-level text that appears before the template's first tag, and a template whose only top-level node is the expression makes it emit `.firstChild` with no parent. So `` html`${x}` ``, `` html`hi ${x}` ``, and `` html`hi` `` throw a stackless `SyntaxError`/`TypeError` from `new Function`, while `` html`lead <b>x</b>` `` silently drops `lead `. Wrap content in an element (`` html`<span>hi ${x}</span>` ``), or return the accessor (`() => x`) instead of wrapping it. The compiler fails the build on all four — see `guards/solid-html-guard.ts`.
- **`flex: 1` breaks reactivity**: Use `position: absolute; inset: 0` instead
- **Closing tags**: `</${Component}>` is auto-fixed by compiler plugin to `</>`
- **Zero-arg function props are invoked, not passed through**: `wrapProps` turns any component prop whose interpolated value is a zero-argument function into a reactive getter, so `` html`<${C} foo=${accessor} />` `` hands the component the *current value*, not the accessor — unlike JSX — and `props.foo()` throws. Same mechanism makes a zero-arg event handler fire during render. Wrap it (`foo=${() => accessor}`) so the component receives the callable, or share a module-level signal. Functions with declared parameters (`(e) => …`) pass through untouched.

## Compiler & Bundled Libraries

Apps compile via Bun into a single self-contained HTML file. Entry point is always `src/main.ts`.
The compiler injects design tokens, SDK scripts (capture, storage, verb, app-protocol, etc.), and
the bundled code. `@bundled/*` imports need no `npm install` — including the YAAR SDK
(`@bundled/yaar`) — and a few gated SDKs (`@bundled/yaar-dev`, `@bundled/yaar-web`,
`@bundled/yaar-ml`) require an entry under `app.json`'s `"bundles"`, or the compiler rejects the
import.

The authoritative library list is `BUNDLED_LIBRARIES` in
`packages/compiler/src/bundled/registry.ts`, also served at `GET /api/dev/bundled-libraries`.
Point at it rather than enumerating it; `scripts/check/doc-freshness.ts` lints doc copies of the
list for drift.

Notable libraries: `mermaid` — `renderMermaid()` returns token-themed, already-sanitized SVG; at
3.3 MB it is by far the largest, so import it only where diagrams are drawn. `dompurify` —
mandatory for any externally-sourced HTML. `mediabunny` — read/write/convert mp4/webm/mp3/wav,
frame-accurate and not real-time-bound like `MediaRecorder`. `lucide` — icons: import by name
(`Trash2`, `FolderOpen`) and render with `icon()`; never hand-copy an SVG path, and write a
domain glyph Lucide lacks as an `IconNode` rendered by the same call. Compiler internals (shims, guards,
protocol extraction): [`packages/compiler/CLAUDE.md`](../packages/compiler/CLAUDE.md).
