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

## agent/prompt.md

The app agent's base prompt — it **replaces** the generic one rather than extending it, so it has
to document the tools itself. `protocol.json` and the platform's generic tool-payload rules are
appended automatically; never copy a command signature into it.

Its call examples must match the **flat** tool schema — `{ command, params?, appId?, timeoutMs? }`,
with `appId` and `timeoutMs` as top-level siblings, never nested. The document described a
positional-plus-options-object form for a long time and *every* example in it was consequently
wrong. If you touch the Tools section, verify against the live tool schema, not against the prose
that is already there.
