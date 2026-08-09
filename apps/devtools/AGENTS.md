# AGENTS.md — Dev Tools

The IDE that builds and deploys every other YAAR app, including itself. Read this before editing.
`agent/prompt.md` is a different document for a different reader — see the last section.

## The self-hosting hazard

Devtools compiles, deploys and rolls back apps, and it is an app. **A broken deploy of devtools
breaks the tool you would use to fix devtools.** Consequences:

- Never deploy this app with `skipTypecheck`.
- Recovery is `gitRestore` against appId `devtools`. That still works from a monitor agent or a
  second devtools window if this one is wedged — but it is the only way back, so confirm a
  compile is green before deploying rather than after.
- The agent editing this app runs on the prompt stored in `agent/prompt.md`. Editing that file
  changes the editor's own behavior at the *next* deploy, not immediately. An agent that has just
  rewritten its own prompt is still running the old one for the rest of the session.

## Layers

`ui → services → lib → core`. Imports point one direction only, and each directory's `index.ts`
re-exports **only what that directory owns**. The restraint is the design, not tidiness:

- `core/` — signals and types. The bottom of the graph: imports nothing app-local except its own
  type definitions, which is what keeps the layer rule enforceable by grep.
- `lib/` — pure logic, free of signals and I/O, so it can be exercised without booting the app.
- `services/` — everything that performs I/O or mutates signals.
- `ui/` — Solid components, composed by `app-shell.ts`. Imported by nothing.

A former `src/project.ts` barrel re-exported *across* layer boundaries. That made
`import { compileStatus } from './project'` both possible and misleading, and it closed a real
import cycle (`project.ts → services/index.ts → services/preview.ts → project.ts`) that kept
`services/preview.ts` and `services/manifest.ts` out of their own barrel for two refactor phases.
It was deleted. Do not reintroduce a cross-layer barrel — if a module seems to need one, it is
sitting in the wrong layer.

## The protocol is split on purpose

`src/main.ts` holds the single `defineApp`, spreading seven descriptor maps from `src/protocol/`
(projects, files, build, git, preview, introspect, media) plus `devtoolsState` from
`protocol/index.ts`. The extractor resolves imported consts and spreads, so every command still
reaches `dist/protocol.json` intact.

The constraint that buys it, and the one that will bite: **every descriptor must stay statically
readable** — a `const` object literal, no factory call result, no template-literal description, no
map built in a loop. A violation is a build error with `file:line:col`, never a silently shrunken
manifest. Verify a reshuffle with the `manifest` command (needs a compile *and* an open preview);
a pure move must not change the diff.

**Command and state `description` strings are the agent-facing documentation.** They are appended
verbatim to the prompt of every agent driving this app, which is why they are written as prose and
not as terse labels. Corollary: do not restate them in `agent/prompt.md`. A fact asserted in both
places is a fact that will eventually disagree with itself, and the descriptor is the copy that
cannot go stale.

## compileStatus is three-valued, and that is load-bearing

`compileStatus` is deliberately not the bundler's verdict. Bun strips types and builds straight
through type errors, so `bundleStatus` alone only ever means "it bundled".

`typecheckState` therefore carries a third value, `unknown`, which is the default after **every**
write. It is not a shade of `clean` or `errors`: a `clean` from before the last edit describes code
that no longer exists, and reporting it as still clean is the precise bug this shape exists to
prevent — a project with six live type errors was once waved through as `success`. If you touch
`core/store.ts` or the `compileStatus` getter in `protocol/index.ts`, preserve the third value and
keep it surfacing as `"unchecked"`.

## Failing states report *which* failure

`consoleLogs` and `permissions` return a structured reason on failure instead of an empty result,
because "no preview open", "preview unreachable" and "the app logged nothing" used to collapse into
the same empty array and left the reader no option but to guess. `permissions` likewise reports a
manifest read error rather than an empty list, since "allowed nothing" is a different and much more
alarming answer than "could not tell".

An empty list is an answer. Make sure it is the true one. Keep this pattern in any new state getter
that can fail.

## Every mutation is recorded, and that is a UI contract

Writes used to announce themselves as one line of status text ("Saved src/foo.ts"), which
told the user that something changed but never what. The Changes tab in the bottom panel now
shows the diff — in the sidebar, beside the file tree — so:

- **Every path that mutates a file goes through `services/files.ts` and calls `recordChange`.**
  `writeFile` does it for writes, edits and copies (edit and copy both route through it);
  `deleteFile` does it for removals. A new mutation path that saves via `appStorage` directly is
  invisible in the panel — which is exactly the bug this feature closes.
- The exception is deliberate: `createProject` scaffolds through `appStorage.save`, because a
  new project's dozen skeleton files are noise, not changes the user made. (`createProject` has no
  toolbar button any more — the two ways a project appears are Load and Clone — but the protocol
  command still scaffolds, so the exemption still matters.)
- `recordChange` holds **both** versions of the file, not a rendered patch. The panel re-renders
  on a view-mode switch, and re-reading the file later would show its current state rather than
  the state at that moment. Two copies per entry is also why the history is capped at 40.
- A write whose content is identical to what was there is dropped rather than recorded as an
  empty diff. Deletes are exempt — removing an empty file is still a removal.

`lib/diff.ts` is the pure half (stats, patch, truncation) and has no signals, per the layer rule.
The UI cannot call into services for tab state either: the Changes tab raises itself by watching
`fileChanges()` in a `createEffect` inside `Sidebar`, not by a call from the recorder. That effect
skips the raise while the editor textarea has focus — autosave records a change every time typing
pauses, and the sidebar is now the same column as the file tree, so raising it mid-edit would pull
the tree out from under someone reading their own code.

## Where the panes live

The workspace is three regions, and which component owns which is not obvious from the file names:

- **Sidebar** (`ui/sidebar.ts`) — two tabs, Files (`ui/file-tree.ts`) and Changes
  (`ui/change-list.ts`). Both answer "which files are in play", which is why they share a column.
- **Main pane** — the editor (`ui/editor.ts`) or the diff (`ChangeView` in `ui/changes-panel.ts`),
  never both. A diff is read the way a file is read, so it takes the pane sized for that.
- **Bottom panel** (`ui/diagnostics.ts`) — Problems and Console, and nothing else. It is capped at
  200px again now that no tab in it needs to show a diff.

The three signals they agree on (`sidebarTab`, `mainView`, and the diff's own view mode) live in
`ui/panel-state.ts`, which imports nothing app-local. Putting them in any one component would close
an import cycle with the other two — `sidebar → changes-panel → sidebar` is the one that bites.

**The chrome is one row, not two.** The open-project list used to be a second toolbar row
(`ui/project-tabs.ts`); it is now the dropdown behind the project name in `ui/project-toolbar.ts`,
and the file is gone. The row cost ~26px permanently to show something only consulted when
switching, and the name in the corner was already reporting the same fact.

Its outside-click dismissal listens on the document in the **capture** phase, and that is
load-bearing rather than stylistic. Solid delegates `click` at the document, so a bubble-phase
listener is a sibling of Solid's own dispatch, not a parent of it: `stopPropagation` inside the
menu cannot shield it (the trigger closed and reopened in one click), and by the time it ran,
Solid had already re-rendered synchronously and detached the clicked node, so `root.contains`
called every row action "outside" and dismissed the menu mid-use. Capture runs before all of that,
while the target is still in the tree. Any other popover added to this app wants the same shape.

**Anything that opens a file must call `showFiles()` first.** The main pane may be showing a diff,
so `openFile` alone opens a file nobody can see. There are exactly two such call sites (the tree,
and a click on a problem); `openFile` cannot do it itself, because a service must not reach into UI
state.

**diff2html needs three overrides to survive inside a panel** (`styles.css`, near the bottom), and
each one is load-bearing: its `padding: 0 8em` on a code line reserves room for a gutter that is
absolutely positioned over the *left* half — remove that and the line numbers land on the code —
while the right half is pure overhang that painted a slab of row colour past the end of every
line. It also pads empty lines with a literal U+200B, which the IDE's UI font has no glyph for,
so every blank line rendered a missing-glyph box until `:after` was given a plain space.

## agent/prompt.md

The app agent's base prompt — it **replaces** the generic one rather than extending it, so it has
to document the tools itself. `protocol.json` and the platform's generic tool-payload rules are
appended automatically; never copy a command signature into it.

Its call examples must match the **flat** tool schema — `{ command, params?, appId?, timeoutMs? }`,
with `appId` and `timeoutMs` as top-level siblings, never nested. The document described a
positional-plus-options-object form for a long time and *every* example in it was consequently
wrong. If you touch the Tools section, verify against the live tool schema, not against the prose
that is already there.
