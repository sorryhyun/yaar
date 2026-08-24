# AGENTS.md — Dev Tools

The IDE that builds and deploys every other YAAR app, including itself. Read this before editing.

## Run the tests

`selfTest` runs the unit suite over `src/lib`, the pure layer. No project, no preview, and fast.
Run it after touching anything under `src/lib`, `src/core` or `src/test`, and before every deploy.
A failure names its suite, check and assertion; `{ suite }` re-runs one.

Add a check to `src/test/lib-suites.ts` rather than a verification procedure to this file — the
suites are the regression record. Behaviour that needs a running app is `previewScript`
(`agent/docs/regression-testing.md`), also not prose.

## The self-hosting hazard

Devtools compiles, deploys and rolls back apps, and it is an app. **A broken deploy of devtools
breaks the tool you would use to fix devtools.**

- Never deploy this app with `skipTypecheck`.
- Recovery is `gitRestore` against appId `devtools`, from a monitor agent or a second devtools
  window. It is the only way back, so confirm a green compile *before* deploying.
- The agent editing this app runs the prompt in `agent/prompt.md`. Editing it takes effect at the
  *next* deploy — an agent that just rewrote its own prompt is still running the old one.

## Layers

`ui → services → lib → core`. Imports point one direction only, and each directory's `index.ts`
re-exports **only what that directory owns**.

- `core/` — signals and types, importing nothing app-local. That keeps the rule grep-able.
- `lib/` — pure logic: no signals, no I/O. Testable without booting the app; keep it that way.
- `services/` — everything that performs I/O or mutates signals.
- `ui/` — Solid components, composed by `app-shell.ts`. Imported by nothing.
- `test/` — the suites. The only directory that may import across layers.

**Never add a cross-layer barrel.** A former `src/project.ts` was one, and it closed a real import
cycle through `services/preview.ts`. If a module seems to need one, it is in the wrong layer.

## The protocol is split on purpose

`src/main.ts` holds the single `defineApp`, spreading one descriptor map per domain from
`src/protocol/`. Do not write down how many there are — read the manifest.

**Every descriptor must stay statically readable**: a `const` object literal, no factory call
result, no template-literal description, no map built in a loop. A violation is a build error with
`file:line:col`, never a silently shrunken manifest. Verify a reshuffle with the `manifest` command
(needs a compile *and* an open preview); a pure move must not change the diff.

**Command and state `description` strings are the agent-facing documentation**, appended verbatim
to the prompt of every agent driving this app. Never restate one in `agent/prompt.md`: a fact in
both places will disagree with itself, and the descriptor is the copy that cannot go stale.

## Storage re-encodes images on read

Reading a stored image gives **WebP**, not the bytes on disk. So **no client-side read can
duplicate a non-WebP image faithfully**, and `copyBytes` renames an image copy to `.webp` — a file
whose contents and extension disagree is the bug, not the fix.

The byte-exact path is server-side: `invoke(dest, { action: 'copy', from })`, which never reads the
file into the iframe. Both storage directions use it — import (`yaar://storage/…` as `from`) and
export (as `to`, via `exportToStorage`). A copy *within* the project has no storage URI on either
side, so it cannot; that is why it reads, rewrites and renames.

## compileStatus is three-valued, and that is load-bearing

`resolveCompileStatus` in `lib/compile-status.ts` is the single reducer, shared by the
`compileStatus` state key and the `compile` command's `status` so the two cannot drift.

Bun strips types and builds through type errors, so the bundler's verdict alone only means "it
bundled". `unknown` is the load-bearing typecheck value and the default after **every** write — not
a shade of `clean`, because a `clean` from before the last edit describes code that no longer
exists. Reporting it as clean once waved six live type errors through as `success`. Preserve the
third value and keep it surfacing as `"unchecked"`; the `compile-status` suite pins it.

## Failing states report *which* failure

`consoleLogs` and `permissions` return a structured reason on failure, never an empty result: "no
preview open", "preview unreachable" and "the app logged nothing" must not collapse into the same
empty array. An empty list is an answer — make sure it is the true one. Keep this in any new state
getter that can fail.

## Every mutation is recorded

**Every path that mutates a file goes through `services/files.ts` and calls `recordChange`**, so
the Changes tab can show the diff. A path that saves via `appStorage` directly is invisible there,
which is the bug the panel closes. `createProject` is the one deliberate exemption: skeleton files
are noise, not changes the user made.

## The worker proposes; only one command applies

The worker reads the project and cannot write to it. **`acceptEditRequest` in `protocol/worker.ts`
is the only thing in this app that turns a proposal into a write.** Anything added to the worker's
tool list that writes directly re-opens that hole.

- **The dry run runs at submit *and* at accept.** At submit it is the worker's correction loop, the
  result landing in its turn while it still has the file in context; at accept it is the staleness
  check, because the file may have moved.
- **Proposed edits require a unique search string** (`requireUnique` in `lib/edits.ts`). Opt-in and
  only here — do not turn it on for `editFile`.
- **Accept needs the `token` from `readEditRequest` and a caller-written `intent`**, or delegation
  degrades into a forward. A discipline gate, not a security boundary.
- A rejection reaches the worker at the head of its *next* task (`pendingFeedback`), because the
  server takes no message while no turn is running. Drop that queue and rejected proposals return
  unchanged.

## Where the panes live

- **Sidebar** (`ui/sidebar.ts`) — three tabs: Files, Changes, Worker.
- **Main pane** — the editor or a diff (`ChangeView`), never both.
- **Bottom panel** (`ui/diagnostics.ts`) — Problems and Console, and nothing else.

Their shared signals live in `ui/panel-state.ts`, which imports nothing app-local: putting them in
any one component closes the `sidebar → changes-panel → sidebar` cycle.

**Switching the main pane is the caller's job** — a service must not reach into UI state. Both
rules below are silent when broken:

- Anything that opens a file calls `showFiles()` first, or the main pane is still showing a diff
  and `openFile` opens a file nobody can see.
- `showWorker()` resets the main view to the editor, because the worker cites files and a lingering
  diff sends every citation somewhere the reader cannot see.

**Popovers dismiss on a document listener in the capture phase.** Solid delegates `click` at the
document, so a bubble-phase listener is a sibling of its dispatch, not a parent: the clicked node
is already detached when `root.contains` runs and every in-menu click reads as "outside". Any new
popover wants the same shape — `ui/project-toolbar.ts` is the worked example.

**diff2html needs four overrides to survive inside a panel**, in `styles/diff.css` with the
reasoning beside each. The trap: its absolutely positioned gutter assumes the page is its
containing block and needs one *inside* the scroller. Check `offsetParent`, not appearance — the
bug is invisible until a diff runs past the pane.

## agent/prompt.md

The app agent's base prompt — it **replaces** the generic one, so it documents the tools itself.
`protocol.json` and the platform's tool-payload rules are appended automatically; never copy a
command signature into it.

Its call examples must match the **flat** tool schema — `{ command, params?, appId?, timeoutMs? }`,
`appId` and `timeoutMs` as top-level siblings, never nested. Verify against the live tool schema,
not against the prose already there.

The prompt carries only workflow, judgment and bright lines; reference prose lives in
`agent/docs/`, one topic per file, pulled with `describe({ topic })`. If a topic exists the prompt
must not restate it (`prompt-restates-topic` in `scripts/check/apps.ts` warns); grow reference
material as a new topic, not as a prompt section.