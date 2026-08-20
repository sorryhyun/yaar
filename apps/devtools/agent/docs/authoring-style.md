---
name: authoring-style
description: Read before writing docs, protocol descriptions, comments, or CSS into any app — what you write becomes the next agent's context.
audience: agent
---

## Authoring Style — writing for the agent that reads you next

Everything you author becomes future context for other agents: cloned source is read by
later sessions, `AGENTS.md` is the manual the next editor swallows whole, `protocol.json`
descriptions become prompt material for every agent that drives the app, and your CSS and
structure choices become the pattern the next generated app imitates. There is no taste in
that loop to correct drift — the most-copied example wins. So the discipline below is not
politeness; it is what keeps an agent-authored ecosystem from converging on its own worst
habits. The bright-line versions of these rules are in your prompt; this is the how.

### Doc conventions

Which file serves which reader is the `markdown-files` topic; this section is how to write
into them.

- **A topic's `description` is a trigger, not a summary.** "Read before touching the body
  renderer" fires at the right moment; "notes about the body renderer" never fires at all.
  The description line is the topic's entire always-loaded footprint (≤150 chars) — it is
  the only chance the doc gets to be pulled.
- **Default to updating, not adding.** A change rarely deserves a new doc — extend the
  topic that already covers the area, and touch its file so staleness tooling sees it.
  A new topic is for a new area with its own trigger, not for "misc notes, part 2".
- **Frontmatter is load-bearing.** `name` must match the filename stem (kebab-case);
  `audience: agent` serves the app's own runtime agent, `dev` whoever edits the source,
  `both` (the default) serves both. List the source paths a topic is authoritative for
  under `covers:` — that is what makes "read this first" machine-checkable.
- **AGENTS.md stays short**: the module map, the invariants an editor must not break, and
  pointers into `agent/docs/`. Anything longer than a clause moves behind the door.

### Protocol description style

One line: what the command does, then the precondition that makes it fail.

- Good: `submitComment — posts via HTTP; falls back to browser when the gallery requires a
  captcha token. Fails on unauthenticated sessions.`
- Bad: `submitComment — this command allows the agent to submit a comment to the currently
  viewed post using the comment submission system.`

The bad one spends its whole length restating the name. The reader is an agent choosing
whether to call it — tell it the effect it cannot guess and the failure it would otherwise
discover by paying a turn. State-key descriptions are the same contract for reads: say what
the value is *when things are unusual* (empty, absent, stale), because the usual case is
already in the name. Descriptions are prompt material: every word is paid for on every turn
of every agent that drives the app.

### Comment discipline

The rule — comments state what the code cannot — expands to a house idiom: a *file header*
that argues a design decision (why this shape, what alternative was rejected, what breaks if
it changes) is welcome and is how this repo documents itself. What is not welcome:

- Narration: `// call the handler`, `// now update the state` — the next line already says so.
- Task residue: `// fixed the bug where…`, `// as requested` — meaningless after the change
  lands, misleading a year later.
- Correctness advocacy: a comment explaining why your change is right is addressed to a
  reviewer, not to the next reader; it dies with the review.

If a comment states a constraint, an invariant, or a workaround with its reason, keep it.
Otherwise delete it and let the code speak.

### CSS and structure

Shared `y-*` chrome and `--yaar-*` design tokens first; local CSS only for what makes this
app *this app*. Redefining a `y-*` class or assigning a `--yaar-*` token in app CSS shadows
the platform's copy for every element in the app — the next clone copies the shadow, and the
ecosystem forks its own chrome. Token values come from the design-token brief in your
prompt's App Authoring Contract; use `var(--yaar-…)` over literals so themes keep working.
A local style is justified for app-specific identity (a game's board, a reader's typography),
not for re-derived plumbing (buttons, toolbars, toasts — the chrome already has those).

### State and command naming

The two protocol namespaces must be tellable apart from the name alone: **nouns read, verbs
run**. `consoleLogs` is a state key; `clearConsole` is a command. An agent that calls
`command("consoleLogs")` gets "Unknown command" and reads it as a broken app — naming that
makes the split obvious is cheaper than any error message.

### The exemplar effect — the pre-deploy question

Before deploying, ask: *what will the next agent copy from this app?* Whatever the answer
is — a CSS pattern, a protocol shape, a doc structure — that is your review checklist,
because it will be copied whether it is good or not. Fixing an exemplar fixes every app
generated after it; shipping a shortcut ships it to the whole ecosystem.
