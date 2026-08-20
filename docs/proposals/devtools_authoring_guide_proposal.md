# Proposal: an authoring guide for devtools — because devtools writes the canon

**Status:** proposal
**Date:** 2026-08-20
**Sibling proposals:** [`app_agent_docs_proposal.md`](./app_agent_docs_proposal.md) (the
docs tier this guide would live in), the instruction-channel audit and delegation proposals.

## Problem

Devtools is not just an agent that writes code — it is the pen that writes the ecosystem.
Everything it produces becomes **future context for other agents**:

- Deployed app source is cloned and read by later devtools sessions and by `clone-app`.
- The `AGENTS.md` files it writes are the manual the *next* editor swallows whole.
- Its `protocol.json` command descriptions become prompt material for every agent that
  drives the app.
- Its CSS and structure choices become the pattern the next generated app imitates.

This creates a compounding loop with no counterweight: an agent-authored codebase converges
on whatever its most-copied examples look like, and drift is not corrected by taste the way
a human team's drift is. The repo has already paid for this twice — local CSS re-added where
shared `y-*` chrome existed (the app-UI-pattern work), and SDK helper duplication (the
SDK/CSS consolidation effort). Both were cases of generation-by-imitation copying the wrong
exemplar, then becoming the exemplar.

The platform currently tells devtools *how the machinery works* (the generated App Authoring
Contract: entrypoint, mount point, links, design tokens) but almost nothing about *how to
write* — no comment discipline, no doc-writing rules, no scope discipline, no style for the
prose that becomes other agents' prompts.

## Principle: examples beat prose, so invest in both — asymmetrically

A style guide for a human assumes taste fills the gaps. For an agent, **the code it reads
outweighs the prose it was told**: a rule that says "reuse shared chrome" loses to a cloned
exemplar that hand-rolls its own CSS. So the guide has three layers, and the third is the
one that actually holds:

1. **Bright lines, inline** — a short hand-written section in `agent/prompt.md`. Rules only,
   each with its one-clause why, severity-budgeted.
2. **The style topic, behind the door** — `agent/docs/authoring-style.md`
   (`audience: agent`), pulled when writing docs or starting an app.
3. **Enforced lints + curated exemplars** — extend `scripts/check/apps.ts` for the lintable
   subset, and run one cleanup pass over `apps/` so the bundled apps *are* the guide.

## Layer 1 — the bright lines (draft)

To be added to `apps/devtools/agent/prompt.md` (this is content, not summary — edit freely):

```markdown
## Writing Code and Docs

What you write becomes the example the next agent copies — in cloned source, in AGENTS.md,
in protocol descriptions. Write for that reader.

- **Reuse before writing.** Check `@bundled/*`, the SDK helpers, and shared `y-*` chrome
  before authoring an equivalent — a local copy becomes the exemplar the next app imitates,
  and the drift compounds.
- **Comments state what the code cannot.** A comment earns its place only for a hidden
  constraint, invariant, or workaround. Never narrate what the next line does, never
  reference the current task or fix — that context rots the moment the change lands.
- **Scope is the deliverable.** Don't add features, abstractions, or error handling beyond
  the ask — three similar lines beat a premature helper. And don't quietly narrow it
  either: finish the whole ask before reporting done.
- **A protocol description is prompt material.** One line: what the command does, then the
  precondition that makes it fail. It is read by an agent deciding whether to call it, not
  by a person browsing an API.
- **Docs go in their tier.** Bright lines and invariants → AGENTS.md (short). Reference
  prose → one `agent/docs/{topic}.md` with a trigger-scented description and `covers:`.
  Never both — a restatement is the copy that goes stale.
```

Five rules, each with its mechanism, ~20 lines. Anything longer belongs in Layer 2.

## Layer 2 — `agent/docs/authoring-style.md` (outline)

The full guide, served through the describe door (see the docs-tier proposal). Outline:

- **Doc conventions**: topic frontmatter (`name`/`description`/`audience`/`covers`),
  writing descriptions as triggers ("read before touching X") not summaries, the AGENTS.md
  index shape, when a change deserves a doc at all (default: it doesn't — update the
  covering topic instead of adding one).
- **Protocol description style**: the one-line contract (summary → failure precondition),
  worked good/bad pair:
  - Good: `submitComment — posts via HTTP; falls back to browser when the gallery requires
    a captcha token. Fails on unauthenticated sessions.`
  - Bad: `submitComment — this command allows the agent to submit a comment to the
    currently viewed post using the comment submission system.`
- **Comment discipline, expanded**: the why-only rule with examples from the repo's own
  style (source-file header comments that argue design decisions are the house idiom —
  keep those; line-by-line narration is not).
- **CSS and structure**: `y-*` chrome first, design tokens over literals, when a local
  style is justified (app-specific identity, not re-derived plumbing).
- **State/command naming**: the query-vs-command namespace rule and naming that makes the
  split obvious (`consoleLogs` is a state key; `clearConsole` is a command — nouns read,
  verbs run).
- **Writing for the exemplar effect**: before deploying, ask what the next agent will copy
  from this app; the answer is the review checklist.

## Layer 3 — lints and exemplars

**Lints** (extend `scripts/check/apps.ts`, warn-tier like the existing guardrails):

| Rule | Detects |
|---|---|
| `local-chrome-shadow` | app CSS redefining a `y-*` class or a design-token value |
| `protocol-description-shape` | command description missing, multi-paragraph, or opening with "this command" |
| `narration-comment` | comment lines matching narration shapes (`// call X`, `// now we ...`) — heuristic, warn only |
| existing `skill-restates-protocol`, proposed `prompt-restates-topic`, `doc-may-be-stale` | restatement and staleness (docs-tier proposal) |

**Exemplars**: one audit pass over `apps/` against Layers 1–2, fixing the bundled apps
first. This is the highest-leverage step in the proposal: bundled apps are what `clone-app`
serves and what generated apps imitate, so a guide that contradicts them is dead prose.
The pass is bounded (a dozen apps) and mostly mechanical once the lints exist — run the
lints, fix the warns, hand-review the prose surfaces (AGENTS.md, SKILL.md, protocol
descriptions) against the Layer 2 outline.

## What this is not

- **Not a human style doc.** Prettier/ESLint already govern formatting; CLAUDE.md governs
  repo-level style. This guide is scoped to what devtools *authors into apps* — the
  surfaces that become other agents' context.
- **Not new machinery.** Layer 2 rides the docs tier; Layer 3 rides the existing check
  script. Only Layer 1 touches a prompt, and it shrinks-not-grows if the docs-tier
  proposal's reference sections move out of `prompt.md` first.
