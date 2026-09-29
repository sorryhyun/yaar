# Apps: From Source to a Running Window

A YAAR app is a folder of TypeScript that the platform builds, ships, installs and sandboxes for
you. This page explains the path from that folder to a window on the desktop: what the compiler
does and why the output is one HTML file, how `@bundled/*` libraries work as a platform, when an
app rebuilds, what deploy and install actually guard, and what the iframe the app finally runs in
will and will not let it do.

It is the *why* document. For the SDK an app author calls, see the
[YAAR SDK guide](../guides/yaar_sdk.md). For every `app.json` key, see the
[App Manifest Reference](../reference/app_manifest_reference.md). For the agent ↔ iframe wire
format, see the [App Protocol Reference](../reference/app_protocol_reference.md). For the app
agent that operates a running app, see
[Session, Monitor, Window](./monitor_and_windows_guide.md#app-agent--the-specialist-operator).
Every `yaar://apps/…` verb is in the [URI Reference](../reference/uri_reference.md).

All paths are relative to the repo root.

---

## What an app is

An app is a directory. Its **name is its id**, and nothing about the directory is
registered anywhere else. The server finds apps by listing directories, and an app is whatever
it finds there.

```
{appId}/
├── app.json            # the manifest: identity, window shape, what the app may reach
├── src/main.ts         # the entry point (always this path) + whatever else src/ holds
├── agent/              # optional prose for the agents: prompt.md, hint.md, SKILL.md, docs/
├── AGENTS.md           # optional notes for whoever *edits* the app (never read at runtime)
└── dist/               # generated, never hand-edited
    ├── index.html          # the whole app, one file
    ├── protocol.json       # what an agent can read and do in it, extracted from src/
    └── .build-manifest.json # the hashes that say whether dist/ is still current
```

The split that matters is between what a person or agent writes (`app.json`, `src/`, the docs)
and what the platform derives (`dist/`). `dist/` is never the source of truth. It is rebuilt
whenever it might disagree with its inputs, it is left out of every snapshot and every published
package, and deploy wipes it and writes it fresh.

## The pipeline

`compileTypeScript` in `packages/compiler/src/compile.ts` turns `src/` into `dist/`. The stages
run in this order. The order matters: cheap checks come first, and genuine build errors are
reported before anything that depends on a successful build.

```
 app.json ── name, bundles, three, links, appId ─────────────────────────┐
 src/**                                                                  │
   │                                                                     │
   ▼                                                                     │
 ┌─ token guard ─────────────── var(--yaar-*) that can never resolve ────┤ fail
 │                                                                       │
 ├─ Bun.build ───────────────────────────────────────────────────────────┤
 │    @bundled/* ──► registry ──► shim │ node_modules │ prebundled (exe) │
 │                   gate: yaar-* needs `bundles`, three/webgpu needs    │ fail
 │                   `three`                                             │
 │    .css ──► <style> at runtime      image/font/wasm ──► data: URI     │
 │    any other asset ──► refused (no sibling file can exist)            │ fail
 │    solid-js/html + mount guards                                       │ fail
 │                                                                       │
 ├─ protocol extraction ── defineApp({...}) read from the AST, or run    │
 │                         in a Worker to fold Zod schemas               │ fail
 │                                                                       │
 └─ HTML wrapper ── tokens CSS + link config + SDK scripts               │
                    + extracted manifest + the app module                │
   │                                                                     │
   ▼                                                                     │
 dist/index.html   dist/protocol.json   dist/.build-manifest.json ◄──────┘
```

Three ideas run through it.

**Guards exist for defects that compile clean.** A `var(--yaar-space-2)` that names no token, a
`render()` into `#root` when the wrapper emits a different mount id, and a `solid-js/html`
template that silently drops text all pass Bun and pass tsc, and then produce a blank or unstyled
window. Each guard checks one fact about the runtime that the compiler owns, and derives what it
expects from the compiler's own output, so the guard cannot drift from what it guards. The
rules and the incidents behind them are in `packages/compiler/CLAUDE.md`.

**Protocol extraction refuses rather than omits.** The manifest an agent reads is built from
source at compile time. The manifest the running app serves is built by the SDK at runtime from
the same `defineApp` call. If extraction quietly skipped an entry it could not read, a command
would work in the app and be invisible to every agent, and every build signal would stay green.
This has happened: one incident shrank 29 commands to 3. So anything the extractor cannot
resolve fails the build, with a location. The same extractor runs again at deploy, so no
caller can install an app whose protocol was only partly read.

**Typechecking is not part of the build.** Bun strips types and bundles around type errors, so
"compiled" has never meant "type-checks". The check lives at the door that matters instead:
deploy runs it before anything reaches an app directory (see
[Deploy is the last door](#deploy-is-the-last-door)).

## Why one self-contained HTML file

The output is a single HTML file with everything inline: the app's JavaScript, its CSS, its
imported images and fonts as `data:` URIs, the design-token stylesheet, and the iframe SDK. That
shape follows from where the file is served:

- **There is nowhere to put a second file.** An app window loads `dist/index.html` from the app's
  directory. The build does not publish sibling chunks, so an import that would need one (a
  `.glb`, say) is refused at build time. Otherwise it would build green and then fail at runtime
  with a 403 fetching a file that was never shipped.
- **No remote code.** The CSP's `script-src` names only YAAR's own origins (see
  [The runtime sandbox](#the-runtime-sandbox)). A library pulled from a CDN at runtime would not
  load, so every library has to be inside the file.
- **One unit to hash, ship and replace.** Staleness is judged against one output. Deploy swaps
  one file, and a window that reloads gets the whole new app or none of it.

"Self-contained" describes the *bytes*, not the *runtime*. An app still depends on the server for
everything outside the page: storage, its database, the verb doors, the fetch proxy. If you open
`dist/index.html` on its own, the page renders, but it has no iframe token and every SDK call is
refused. The `GET /api/dev/preview/{appId}` route exists because of this. It serves the file as a
top-level page with the app's real token injected, which is what a test or a CDP driver needs.

### Two layers of SDK

An app gets the YAAR SDK in two forms, and they do different jobs:

- **Baked-in scripts.** The wrapper inlines a set of iframe scripts from `@yaar/shared` ahead of
  the app: the IME guard, capture helper, storage and verb SDKs, fetch proxy, app-protocol
  bridge, context menu, notifications, device, text selection, windows, and console capture.
  They install `window.yaar` and the plumbing the shell talks to. They are baked into the file
  rather than injected by the shell because the shell can only inject into a same-origin frame,
  and an origin-isolated app is not one. `packages/compiler/src/sdk-scripts.ts` is the single
  list that both the build and the staleness hash read.
- **`@bundled/yaar`.** An ordinary bundled library (`packages/compiler/src/shims/yaar/`) that app
  code imports: a thin, typed wrapper over the global, with the helpers (`defineApp`,
  `appStorage`, `appDb`, `sanitizeHtml`, …) the fleet kept writing by hand.

## Bundled libraries as a platform

Apps do not `npm install`. A sandbox has no `node_modules` of its own, and the author is usually
an agent choosing from a menu. So the platform keeps the menu: `BUNDLED_LIBRARIES` in
`packages/compiler/src/bundled/registry.ts`, imported as `@bundled/{name}`. The list itself, with
what each library is for, is in the [SDK guide](../guides/yaar_sdk.md). This section covers the
mechanism.

**One registry, many readers.** The same map drives the bundler plugin that resolves imports,
the typechecker's view of the world, the prebundle step that builds the standalone exe, the
`GET /api/dev/bundled-libraries` listing, `describeBundledLibrary`, which is how an agent reads a
library's API, and the doc-freshness lint that keeps written copies of the list honest. A library
exists for apps exactly when it is in the registry, and every consumer finds out at the same
moment.

**Every entry costs bytes whether or not an app uses it.** Tree-shaking makes an unused library
free *per app*. It is never free in the exe, which embeds a prebundled copy of every registry
entry. That is why an entry needs a concrete first consumer. Adding one is one line plus a type block.

**Resolution depends on where the compiler runs.** In a repo checkout, an `@bundled/*` import
resolves to a local shim when there is one, and otherwise to the package's *browser* entry in
`node_modules`. Bun's default resolver would pick the server build of packages like solid-js. In
the standalone exe there is no `node_modules`, so the same import resolves to an artifact that
`packages/compiler/src/bundled/prebundle.ts` built at release time and the binary embedded.
The release script and the completeness test call the same prebundle function, so the test checks
exactly the artifact that ships.

**Shims exist for two reasons.** Some shims fix a defect. A pure re-export barrel (`uuid`,
`zod/mini`, `lodash-es`, …) collapses when Bun prebundles it directly: the build succeeds and the
exe breaks later. Routing the package through a shim avoids that. Other shims hold the helper
that belongs with a library, such as `renderMarkdown` beside `marked` and `renderMermaid` beside
`mermaid`, so an app that never draws a diagram never pulls in the 3 MB library through the SDK.

**Some runtimes must exist exactly once.** Two copies of solid-js are two reactive runtimes, and a
signal from one is invisible to an effect in the other. Two copies of three.js are two `Object3D`
classes, and `instanceof` quietly answers false across them. Neither failure has a build signal.
So bare imports of these packages are redirected to the one shared bundle, and the prebundled
artifacts keep them external. three.js has two builds (WebGL and WebGPU) over one core, so an app
picks exactly one with `app.json`'s `three` key, and never both.

**Agents learn a library from its types.** `packages/compiler/src/bundled-types/index.d.ts`
declares every `@bundled/*` module. `describeBundledLibrary` slices it into an index and
per-symbol answers, so what an agent is told exists is what the typechecker accepts.

### Gated SDKs

Most bundled libraries only compute. The ones whose names start with `yaar-` can reach something
real. `yaar-dev` compiles and deploys apps and rewrites app directories. `yaar-web` drives a
headless browser. `yaar-ml` loads model weights and runs inference. `yaar-media` streams remote
media and runs yt-dlp. Any app can import a pure library, but a gated SDK must be named in the
app's `app.json` `bundles` list.

The gate is enforced at three separate points, because each point sees something the others
cannot:

| Where | What it catches |
|---|---|
| The bundler plugin | An `import` of an undeclared gated SDK fails the build |
| The typecheck | The undeclared SDK's type declarations are sliced out of the program, so the editor agrees with the build |
| The server door | The iframe token carries the app's `bundles`, and every route a gated SDK calls (`/api/dev/*`, `/api/browser`, `/api/bridge`, `/api/ml-*`, `/api/media-proxy`) checks it again |

The third check is the one that holds. The compiler only ever sees the app's source, and a
hand-written `fetch('/api/dev/deploy')` never goes near it. The runtime check has to read what
the manifest declares, not what the source imported.

A `bundles` entry is also a request the user approves. The install dialog lists each one as a
capability. This is why `three: "webgpu"` is a separate key and not a `bundles` entry: choosing a
renderer grants nothing, and it should not look like a grant in that dialog.

`yaar-dev` has one extra rule: an app may always write *itself*, but only a bundled app may deploy
to, restore or checkpoint *another* app. Without it, any marketplace app that declared
`yaar-dev` could overwrite a system app.

## When an app rebuilds

A compile writes `dist/.build-manifest.json`, which records hashes of the sources and
`app.json`, a hash of everything the compiler bakes in (the SDK scripts and the tokens
stylesheet), the compiler version, and, for a `yaar-ml` app, the onnxruntime version its runtime
URLs were stamped with. An app is **stale** when any of these no longer matches. Stale apps are
recompiled by:

- **Server startup.** A pass over every app with a `src/main.ts`, a few at a time, running after
  the server has started serving. `bun run build:apps` reuses the same pass, so a CI build and a
  dev boot compile identically. Naming ids on the command line forces a rebuild of those apps,
  because the source hash cannot see every input: an edit to `agent/prompt.md` or a library bump
  is invisible to it.
- **Deploy, install and restore.** Deploy ships the project's fresh build together with its build
  manifest, and compiles only if the project has none. Install and restore compile after writing
  the new source.

The SDK hash exists so a change to the SDK reaches every app, not only the ones someone edits
(a stale device SDK once left Memo and Anima unable to save in the Android app). Any change to the
baked-in scripts or tokens makes every app stale once, and the next start rebuilds them all. A
change to anything else the compiler injects (the `@bundled/yaar` shim, the HTML wrapper) still
needs a `COMPILER_VERSION` bump. `packages/compiler/CLAUDE.md` keeps that rule.

The release archive ships every bundled app's `dist/` *with* its build manifest. On a fresh
install the apps are therefore already current and nothing compiles at first launch.

## The authoring loop

Apps are normally written by an agent working through the devtools app. A devtools **project**
is not an app. It is data in devtools' own app storage (`storage/apps/devtools/projects/{id}/`),
laid out like an app directory. It becomes an app only when it is deployed.

```
  existing app                devtools project                    app directory
  ────────────                ────────────────                    ─────────────
                clone                            deploy
  apps/memo/ ─────────────►  storage/apps/devtools/ ───────────►  apps/memo/   (in place)
  (src, app.json,            projects/{id}/                       or a new dir under the
   agent docs, AGENTS.md)       │   ▲                             deploy root
                                │   │ edit                              │
                        compile │   │                                   │ snapshot before
                                ▼   │                                   │ and after
                             dist/ ─┴─► preview window                  ▼
                                        (principal: preview--{id})   storage/app-git/memo.git
```

**Clone** copies what an editor needs into a project: `src/`, `app.json`, the agent docs at the
paths the manifest names, the `agent/docs/` topics, and `AGENTS.md`. Binary files are carried as
base64. A lossy text read once turned a sprite into 390 KB of replacement characters, and nothing
failed until runtime.

**Preview** runs the compiled project in a window under its own principal,
`preview--{projectId}`. The preview does not run as the app it will become. If it did, unshipped
code would get the live app's storage and could claim the live app's active-window slot, which
would send commands meant for the running app into the preview. A preview's storage belongs to
the project and is thrown away with it. The `preview--` prefix is reserved, so no deployed app
can ever share it.

### Deploy is the last door

Deploy is the one step every caller has to go through: the devtools UI, the `yaar-dev` SDK, and
an agent calling the verb directly. So the checks that must not be skippable live there, in
`packages/server/src/features/dev/deploy.ts`:

1. **Typecheck.** Bundling never checked types, so this is the first point where a type error
   stops an app. It can be skipped only if the caller explicitly says so.
2. **Protocol extraction.** When the project has no `dist/protocol.json`, deploy extracts one
   with the compiler's own extractor. An unresolvable protocol fails the deploy. The gate below
   only runs when there is an installed app to compare against, so without this a *first*
   deploy could install an app whose commands no agent can see.
3. **Protocol shrink gate.** If the new protocol drops commands the installed app has, deploy
   refuses unless the caller says the drop is intended. An agent that could use a command
   yesterday should not silently lose it.
4. **Identity agreement.** If the project's `app.json` names a different `appId` from the one
   being deployed, deploy refuses. The app would otherwise install and then fail its own next
   compile over a mismatch it did not cause.
5. **Snapshot, write, snapshot.** Deploy is destructive: `dist/` is replaced and source files that
   no longer exist are deleted. So the current app is committed to its history first, the new
   files are written, `app.json` is merged and stamped, and the result is committed again.
6. **Tell everything that caches the app.** `notifyAppChanged` (`features/apps/changed.ts`) drops
   the cached manifest and app listing, drops every session's cached app-agent profile so the
   next turn is built from the new protocol (the conversation is kept), closes windows still
   running the old bundle, syncs the desktop shortcut, and refreshes the desktop. Install,
   uninstall and restore run the same sequence. The window that issued the deploy is not
   closed, so an app can deploy itself, and the result reports that window as stale.

### Per-app version history

Each app has its own shadow git repository. The **work tree is the app directory** and the git
metadata lives in `storage/app-git/{appId}.git`. The app boundary is therefore enforced by git
itself, not by path filters someone has to keep correct. The user's own repo never sees a nested
`.git`, and agent commits never enter the user's history. Generated output and secrets (`dist/`,
build manifests, `credentials.json`) are excluded.

A restore snapshots the current state first and then records the rollback as a *new* commit, so
history only grows and a restore can itself be undone. It then recompiles, because the rolled-back
source is not live until `dist/` matches it.

## Where apps live

Apps live in two roots that share one id namespace:

- **`apps/`**: bundled apps, tracked in git and shipped with every release. This covers the
  `kind: "system"` core and the optional first-party apps.
- **The user-apps root**: marketplace installs, git-ignored so installs never dirty the tracked
  tree. It is `user-apps/` by default, can be moved with `YAAR_USER_APPS`, and is filled in
  automatically under a `YAAR_WORKSPACE`.

If an id exists in both roots, the **bundled copy wins**, so an installed app cannot shadow a
shipped one. Everything that needs an app's directory calls `resolveAppDir()` in
`features/apps/roots.ts` rather than building a path itself.

An existing app is updated in place, wherever it lives. A *new* deploy goes to `apps/`, because
devtools-built apps are first-party. The exception is a workspace, where new deploys go to the
workspace's user-apps root, because an experiment must not dirty the tracked tree. The standalone
exe embeds the frontend and libraries but not the apps. It reads them from an `apps/` directory
next to the binary, which the installer extracts from the release archive.

Every root uses one id policy: `appIdRefusal` in `roots.ts`, called wherever an id is *claimed*
(deploy, install, publish). An id is kebab-case, so it is safe as a path segment. `self` is
reserved because it is the pronoun that expands to the calling app, so an app named `self` could
never be addressed by anyone else. The `preview--` prefix is reserved for previews.

## Publishing and installing

Deploy puts an app on *your* desktop. Publishing puts it in the shared marketplace, and
installing is deploy's mirror image on someone else's machine. The Market Apps app is the front
door for both directions. The verbs are in the
[URI Reference](../reference/uri_reference.md#apps--yaarappsappid).

**What gets published is source.** The package is a tarball of the app directory without
`dist/`. The same bytes will be compiled by whatever compiler and SDK the installing machine
runs, so a shipped `dist/` would be stale on arrival. Credentials live in the config directory,
never in the app directory, so they cannot leak into a package.

**Publisher identity is a Google ID token.** No API key, no shared secret, no device registry.
Google's desktop-client token exchange requires a client secret, and an open-source app installed
on user machines has nowhere safe to keep one. So YAAR does the half of the exchange it can, the
marketplace adds the secret, and only tokens come back. Only the refresh token is stored locally.

**Two-phase publish freezes the bytes the user reviewed.** `publish_prepare` packages the app and
holds it. `publish_confirm` uploads *those* bytes. If `src/` or `app.json` changed in between,
confirm refuses and lists the drift. Drift is detected by hashing file contents, not by
re-packaging, because a gzip stream stamps a time and is never byte-identical. Before packaging,
YAAR also checks that the version is newer than the published one. That check fails open: the
marketplace enforces the same rule, so an unreachable catalog should not block a publish.

**Install asks before it grants.** The package is extracted to a staging directory and its
manifest is compared with what the app already holds, if anything. The user is asked about any
*added* capability: permissions, gated SDKs, streams, a sub-agent ceiling. An update that asks
for nothing new installs silently. An update that newly wants `yaar-web` is asked about, and
routine updates do not train the user to click through. The answer is recorded in
`config/app-grants.json`, and for streams and sub-agents it is a **ceiling**: the effective
manifest is the *intersection* of what `app.json` asks for and what was granted. Otherwise an app
holding `yaar-dev` could rewrite its own manifest and raise itself. After that the app is moved
into place, compiled locally, and announced. A `kind: "system"` app cannot be replaced or
uninstalled this way.

## The runtime sandbox

A window of a compiled app is an iframe on `yaar://apps/{appId}`. That URI resolves to the app's
`dist/index.html`, served with a Content-Security-Policy (`packages/server/src/http/csp.ts`) and
with a per-window token in its URL.

**The CSP limits which hosts the app can reach, not what code it runs.** An app is generated code
nobody reviewed, and running arbitrary JavaScript is the product. What the policy stops is
talking to hosts the user never approved. `connect-src`, `script-src` and `worker-src` name only
YAAR's own origins (plus `blob:`/`data:` where a single-file app needs them). `object-src`,
`base-uri` and `form-action` are `'none'`. Every external request therefore goes through the
fetch proxy, where the domain allowlist applies. That is why the SDK's `httpFetch` exists and
why an app declares `yaar://http`. `'unsafe-inline'` and `'unsafe-eval'` are allowed. They only
change *how* an app runs its own code, and the wrapper itself is inline scripts. One channel no
CSP can close: a frame navigating *itself* to a URL that carries data out.

**Installed apps run on a second origin.** Under app-origin isolation, a window of a
marketplace-installed app is served from an *app origin* that is distinct from the desktop's.
Bundled apps and AI-authored HTML are host-authored and stay same-origin. The origin boundary
gives two guarantees:

- The browser stops the app reaching into the shell: its DOM, its memory, its storage.
- The server refuses any request that arrives on the app origin without a token. An app that
  drops its token is refused; it is not treated as the desktop.

Which two origins are in force depends on the transport. Locally it is a loopback alias on the
same socket. Over Tailscale Serve it is two published ports pointed at two local sockets, so the
server knows which one a request arrived on without trusting any header. In some configurations
there is no boundary at all. **Never compare hostnames to decide this.** Ask
`packages/server/src/http/origin-boundary.ts`, which is the only module that knows. The frame's
sandbox attribute (`ISOLATED_APP_SANDBOX` in the frontend's `IframeRenderer.tsx`) keeps
everything an ordinary cross-origin frame has except navigating the top window. The top window
*is* the desktop, and an app that could replace it could phish the user.

**The token carries identity, not authority.** The token says which window, session, monitor and
app this is, plus what the app's own manifest declares: its permissions (with an installed app's
reach into other apps' private storage capped to the shared tree), its `bundles`, its streams. The
app's own namespace (`yaar://apps/self/{storage,db,agents}/`) and the shared commons are granted
to every app, so nobody has to declare them. Anything a caller hands a window at runtime lives on
the window, not the token. Tokens are re-minted on every reconnect, and authority baked into a
token would disappear on the first refresh.

### What the sandbox rules out, and why

- **Node and server-side anything.** The app is a browser page: no `fs`, no `process`, no
  listening ports, no background daemons. Work that has to outlive the window belongs to the
  server or to an agent.
- **OAuth code-for-token exchanges.** They need a client secret, and a page has nowhere to keep
  one. Services like that are reached through the fetch proxy with stored credentials, or wrapped
  as an API-based app that an agent drives.
- **Direct cross-origin requests.** The CSP refuses them. Go through the proxy.
- **`localStorage` and `sessionStorage`.** The browser would mostly allow them. They are ruled out
  because they put data in the wrong place:
  - It stays in one browser profile. It never reaches the server, where the agent could read it,
    and it is invisible to the same window open on a phone or the companion tab.
  - A bundled app shares the desktop's origin, so its `localStorage` is one bucket shared with
    the shell and with every other bundled app.
  - It is not in the app's version history or its storage tree.

  `appStorage` and `appDb` put the same data on the server, per app. `bun run check:apps`
  enforces this as an error-level rule. The same reasoning applies to IndexedDB, but the lint
  does not check for it.
- **External dependencies.** No CDN script, no sibling asset, no localhost service. The app is
  the file, and everything else comes through the SDK.

## TypeScript: two views of an app

`apps/tsconfig.json` is the repo-wide view that editors open. It puts every app's `src/` into a
**single program**. In that program, a `src/main.ts` with no top-level `import` or `export` is
a script, and its top-level names collide with every other app's. Any file that imports from
`@bundled/*` is already a module, and every app that calls `defineApp` does. Only a file that
imports nothing needs `export {};`.

The typecheck that gates deploy builds a **separate program per app** from
`packages/compiler/src/sandbox-tsconfig.ts`. That program has only this app's sources, with
unused locals and parameters reported, and with the `@bundled/*` declarations sliced to what this
app's `bundles` and `three` allow. Find-references uses the same definition, so the two tools
never describe two different programs. The standalone exe has no `tsc` to spawn, so there
typecheck answers success rather than blocking a deploy it cannot judge. The `typescript` module
itself *is* embedded in the exe, so protocol extraction still reads the AST. `bun run build:apps
<id> --typecheck` runs the same check from the command line.

## App types

Most apps are **compiled**: everything above applies, and a window of the app is its
`dist/index.html` in an iframe.

An app does not need a `src/` at all. An **API-based** or **prompt-only** app is an `app.json`
plus agent docs, typically an `agent/prompt.md` that describes a service's endpoints, auth and
workflows. It has no iframe. What it contributes is text the agents read: a hint in the monitor
agent's roster, a manual behind `describe`, and a prompt for the app agent. When the user asks
for something, the agent calls the service and renders the result in an ordinary window. An app
directory can also ship `*.yaarcomponent.json` layouts, which an agent opens as component-DSL
windows by path. Deploy carries these, so a project with no source but with layouts is still
deployable.

## Key files

| Concern | File |
|---|---|
| The compile, in order | `packages/compiler/src/compile.ts` |
| One `Bun.build` for an app; refusing sibling assets | `packages/compiler/src/build/build-app.ts` |
| `@bundled/*` registry, gated set, shared runtimes | `packages/compiler/src/bundled/registry.ts` |
| Import resolution and the build-time gate | `packages/compiler/src/bundled/plugins.ts` |
| Exe prebundling | `packages/compiler/src/bundled/prebundle.ts`, `scripts/build/prebundle-libs.js` |
| One three.js per app | `packages/compiler/src/bundled/three-renderer.ts` |
| Library descriptions for agents | `packages/compiler/src/bundled/describe-library.ts`, `packages/compiler/src/bundled-types/index.d.ts` |
| Runtime-contract guards | `packages/compiler/src/guards/` |
| Protocol extraction | `packages/compiler/src/protocol/extract-protocol-dir.ts` |
| Baked-in SDK scripts and their hash | `packages/compiler/src/sdk-scripts.ts` |
| Staleness | `packages/compiler/src/build/build-manifest.ts`, `packages/server/src/features/apps/auto-compile.ts`, `scripts/build/apps.ts` |
| Per-app typecheck program | `packages/compiler/src/sandbox-tsconfig.ts`, `packages/compiler/src/typecheck.ts` |
| Clone, deploy, version history | `packages/server/src/features/dev/clone.ts`, `deploy.ts`, `git.ts` |
| Dev HTTP doors, standalone preview, cross-app write rule | `packages/server/src/http/routes/dev.ts` |
| Where apps live, id policy | `packages/server/src/features/apps/roots.ts` |
| Reading `app.json`; entitlement by source | `packages/server/src/features/apps/manifest.ts`, `discovery.ts` |
| The follow-up after any app change | `packages/server/src/features/apps/changed.ts` |
| Install, capability diff, grants | `packages/server/src/features/apps/install.ts`, `capabilities.ts`, `packages/server/src/storage/app-grants.ts` |
| Publish, staging, version policy | `packages/server/src/features/apps/publish.ts`, `publish-staging.ts`, `version.ts`, `packages/server/src/features/market/` |
| CSP | `packages/server/src/http/csp.ts` |
| Origin boundary | `packages/server/src/http/origin-boundary.ts`, `packages/server/src/features/window/origin-marks.ts` |
| Iframe tokens, runtime bundle gate | `packages/server/src/http/iframe-tokens.ts`, `packages/server/src/http/access.ts` |
| App guardrail lint | `scripts/check/apps.ts` |
