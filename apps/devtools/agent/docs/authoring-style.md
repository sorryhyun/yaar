---
name: authoring-style
description: Read before writing docs, protocol descriptions, comments, or CSS into any app — what you write becomes the next agent's context.
audience: agent
---

## Authoring Style

Cloned source, `AGENTS.md`, `protocol.json` descriptions, CSS and structure are all read or
copied by later agents. The bright-line rules are in your prompt; this is the detail.

### Doc conventions

Which file serves which reader is the `markdown-files` topic; this section is how to write
into them.

- **A topic's `description` is a trigger, not a summary.** "Read before touching the body
  renderer" fires at the right moment; "notes about the body renderer" never fires at all.
  The description line is the topic's entire always-loaded footprint (≤150 chars).
- **Default to updating, not adding.** A change rarely deserves a new doc — extend the
  topic that already covers the area, and touch its file so staleness tooling sees it.
  A new topic is for a new area with its own trigger, not for "misc notes, part 2".
- **Frontmatter is load-bearing.** `name` must match the filename stem (kebab-case);
  `audience: agent` serves the app's own runtime agent, `dev` whoever edits the source,
  `both` (the default) serves both. List the source paths a topic is authoritative for
  under `covers:` — that is what makes "read this first" machine-checkable.
- **AGENTS.md stays short**: the module map, the invariants an editor must not break, and
  pointers into `agent/docs/`. Anything longer than a clause moves behind the door.
- A cleanup pass over prose that already exists is the `doc-trimming` topic.

### Protocol description style

One line: what the command does, then the precondition that makes it fail.

- Good: `submitComment — posts via HTTP; falls back to browser when the gallery requires a
  captcha token. Fails on unauthenticated sessions.`
- Bad: `submitComment — this command allows the agent to submit a comment to the currently
  viewed post using the comment submission system.`

The bad one restates the name. Give the effect the caller cannot guess and the failure it
would otherwise discover by paying a turn. State-key descriptions are the same contract for
reads: say what the value is *when things are unusual* (empty, absent, stale). Every word is
paid for on every turn of every agent that drives the app.

### Comment discipline

Comments state what the code cannot. A *file header* that records a design decision (why
this shape, what breaks if it changes) is welcome. Not welcome:

- Narration: `// call the handler`, `// now update the state`.
- Task residue: `// fixed the bug where…`, `// as requested`.
- Correctness advocacy: a comment arguing that your change is right, addressed to a reviewer.

If a comment states a constraint, an invariant, or a workaround with its reason, keep it.
Otherwise delete it and let the code speak.

### CSS and structure

Shared `y-*` chrome and `--yaar-*` design tokens first; local CSS only for what makes this
app *this app*. Redefining a `y-*` class or assigning a `--yaar-*` token in app CSS shadows
the platform's copy for every element in the app, and the next clone copies the shadow. Token values come from the design-token brief in your
prompt's App Authoring Contract; use `var(--yaar-…)` over literals so themes keep working.
A local style is justified for app-specific identity (a game's board, a reader's typography),
not for re-derived plumbing (buttons, toolbars, toasts — the chrome already has those).

### State and command naming

The two protocol namespaces must be tellable apart from the name alone: **nouns read, verbs
run**. `consoleLogs` is a state key; `clearConsole` is a command. An agent that calls
`command("consoleLogs")` gets "Unknown command" and reads it as a broken app.

### Before deploying

Review whatever the next agent will copy from this app (a CSS pattern, a protocol shape, a
doc structure).
