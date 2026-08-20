# Proposal: `agent/docs/` — a topic tier for app knowledge

**Status:** implemented 2026-08-20 (runtime tier + devtools migration; the `covers` lookup
in devtools and the singularity-reader dev split remain open — see Status at the end)
**Date:** 2026-08-20
**Motivating examples:** `apps/devtools` (268-line `agent/prompt.md`, every turn) and
`user-apps/thesingularity-reader` (721-line `AGENTS.md`, swallowed whole by whoever edits it)

## Problem

App knowledge currently comes in exactly two sizes: **always-loaded** (`agent/prompt.md`
rebuilt into every app-agent turn; `agent/hint.md` into every monitor turn) and
**monolithic-on-demand** (`agent/SKILL.md` via describe; root `AGENTS.md` read whole from a
clone). There is no per-topic granularity, so growth lands in the wrong tier:

- `apps/devtools/agent/prompt.md` is 268 lines / ~34 KB. Roughly 60% is reference material —
  Bundled Libraries, Static Assets, Solid Gotchas, URI Reference, Markdown Files, Version
  History — paid on **every turn**, cached or not, whether or not the turn touches any of it.
- `user-apps/thesingularity-reader/AGENTS.md` is 721 lines. It is a good manual — module map,
  auth invariants, "read this first before touching the body renderer" — but the only way to
  read the one section that matters is to read all of it, and nothing tells an agent editing
  `src/dc/comment.ts` that a section about that file even exists.

The platform already solved this exact shape once, for the protocol.
`features/apps/describe.ts` documents why the manifest was split out of describe into its own
resource: one answer was serving two questions whose sizes differ by an order of magnitude,
and past the CLI's inline-result threshold the answer is *gone*, not merely expensive. The
fix was not a byte budget — it was doors: `describe` carries a **table of contents** plus the
URI that serves each entry, and `yaar://apps/{id}/protocol` serves it with the verbs meaning
what they mean everywhere else.

This proposal extends that move from generated protocol to hand-written prose.

## Principles

1. **The static tier carries scent, not content.** Names, one-line triggers, and bright-line
   rules stay always-loaded. Everything longer than a clause moves behind a door. A pull-based
   doc is only reachable if the agent knows it exists — the index *is* the contract.
2. **Bright lines stay inline.** A rule the agent must not violate (with its one-clause why)
   never moves behind a door: rationalization doesn't trigger lookups, and the system-prompt
   prefix is cached anyway. Only reference prose moves.
3. **Indexes are generated or linted, never trusted.** A trigger line that no longer matches
   its doc is worse than no doc. The index is assembled from frontmatter at build time, and a
   check rule (same shape as `skill-restates-protocol`) keeps prose from restating topics.

## Design

### The files

```
apps/{id}/
├── agent/
│   ├── prompt.md          # unchanged role, shrinks: identity + bright lines + workflow
│   ├── hint.md            # unchanged
│   ├── SKILL.md           # unchanged: the describe overview — workflows, when NOT to use
│   └── docs/              # NEW: one file per topic
│       ├── bundled-libraries.md
│       ├── comment-submission.md
│       └── ...
```

Each topic file carries frontmatter:

```markdown
---
name: comment-submission
description: HTTP-first comment posting with headless-browser fallback — read before touching dc/commentHttp.ts or dc/comment.ts
audience: dev            # dev | agent | both (default: both)
covers:                  # optional; enables freshness lint + file→doc lookup
  - src/dc/commentHttp.ts
  - src/dc/comment.ts
---

## Comment submission — HTTP first, browser second
...
```

- `name` — kebab-case slug, doubles as the URI segment and filename.
- `description` — one line, ≤150 chars, and it must carry the **trigger**, not a summary:
  "read before touching X", "needed when Y fails". This line is the entire static-tier
  footprint of the topic; write it as scent.
- `audience` — `agent` topics serve the app's own runtime agent; `dev` topics serve whoever
  edits the source (the devtools agent, an external coding agent); `both` serves both. Doors
  filter on it (below). One tree, one lint, one convention; clone and deploy carry it whole.
- `covers` — source paths (globs allowed) this topic is authoritative for. Optional, but it
  is what makes "read this first" machine-actionable instead of a plea.

### The doors

Four doors, one per existing reader, all serving the same files:

1. **`yaar://apps/{id}/docs/`** (new resource, sibling of `/protocol`):
   `list` returns the index — `name` + `description` per topic, filtered to
   `audience: agent|both` for runtime principals. `read` on
   `yaar://apps/{id}/docs/{name}` returns one topic body. Same handler shape as
   `protocol-resource.ts`.

2. **`describe('yaar://apps/{id}')`** gains a `docs` section: the same index rows, right
   next to the protocol table of contents it already carries. Cost is one line per topic —
   describe's size stays governed by what authors write in descriptions, exactly as the
   protocol split intended.

3. **The app agent's `describe` tool** gains a `topic` parameter:
   `describe({ topic: "bundled-libraries" })` returns that topic;
   `describe({})` continues to mean what it means today, plus the index. This door exists
   for the same reason `ProtocolDetail: 'index'` exists — an app agent holds four scoped
   tools and no verbs, so a URI it cannot follow is the dead end this split removes.

4. **The filesystem**, for dev-audience readers: a cloned project carries `agent/docs/`
   like any other tree. `AGENTS.md` shrinks to the module map, the invariants list, and the
   generated index (`make` target or deploy step regenerates it; the check script diffs it).
   The devtools agent's workflow becomes: read `AGENTS.md` (short), then read the one topic
   the index — or a `covers` match on the file it's about to edit — points at.

### The prompt contract

`agent/prompt.md` keeps its role (full override, generated sections appended) but gains a
generated appendix and a rule:

- **Appendix:** at prompt-build time (`profiles/app-agent.ts`), the runtime docs index is
  appended under `## App Docs — read with describe({ topic })`, one line per topic, built
  from frontmatter. Generated like Available Commands, so it cannot drift.
- **Rule:** if a topic file exists, `prompt.md` must not restate its content. Enforced as a
  new `scripts/check/apps.ts` rule (`prompt-restates-topic`), same detection shape as
  `skill-restates-protocol`: a prompt heading matching a topic's name or covers-scope is the
  restatement smell.

Bright lines are exempt by construction: they are clauses, not sections, and they stay in
`prompt.md` per Principle 2.

### The `covers` lint and lookup

Two consumers, both cheap:

- **Freshness (check script):** if any `covers` path has a newer mtime/commit than the topic
  file, warn `doc-may-be-stale` — the same philosophy as `scripts/check/doc-freshness.ts`,
  scoped per app. Warn, not fail: authors confirm by touching the doc (or editing it).
- **Lookup (devtools):** when the devtools agent (or its worker) opens a file for editing in
  a cloned project, an index scan by `covers` surfaces "topics covering this file: …" in the
  tool result. This converts singularity-style "read this before touching the body renderer"
  from a hope into a mechanism — the doc arrives at the moment of the edit, which is the only
  moment it works.

## Worked splits

### `apps/devtools` (runtime-heavy)

| Stays in `prompt.md` (~100 lines) | Moves to `agent/docs/` (`audience: agent`) |
|---|---|
| Identity, Tools, payload rules | `bundled-libraries` — the registry walkthrough |
| Core Workflow, Projects and Clones | `static-assets` — images, fonts, audio, user-made assets |
| Files, Deploy bright lines | `solid-gotchas` |
| Untrusted HTML (bright line + why) | `markdown-files` |
| The Worker delegation contract | `uri-reference` — the long table |
| | `version-history` |
| | `preview-debugging` — the long tail beyond the core loop |
| | `lab-control` — compute-over-data pattern |

Estimated always-loaded reduction: ~60% of the prompt, on the app with `agentType: opus`
(the most expensive context in the fleet).

### `user-apps/thesingularity-reader` (dev-heavy)

`AGENTS.md` (721 lines) becomes ~50 lines — module map, the auth-invariants list (those are
bright lines for an editor), and the generated index — plus ~10 topics, `audience: dev`:

`link-guard` (covers `src/linkGuard.ts`), `auth-layout` (covers `src/dc/`),
`tab-auth` (covers `dc/tab.ts`), `comment-submission` (covers `dc/commentHttp.ts`,
`dc/comment.ts`), `comment-optimistic-ui` (covers `actions/write.ts`,
`ui/CommentSection.ts`), `post-writing` (covers `src/dc/write/`), `feed-mode`
(covers `src/feedMode.ts`), `list-parsing` (covers `src/dc/parse/list.ts`),
`post-capture` (covers `src/postView.ts`, `src/postCapture.ts`), `storage`.

Nothing here is runtime prompt material today and nothing becomes it — the win is that the
devtools agent editing one subsystem reads ~70 lines instead of 721, and the `covers` lookup
tells it *which* 70.

## What does not change

- `hint.md` — the monitor tier is already one paragraph; it is the scent tier working.
- `SKILL.md` — remains the describe overview (workflows, ordering, when *not* to use the
  app). Topics are reference; SKILL.md is orientation. The existing restatement lint keeps
  them honest against the protocol; the new one keeps `prompt.md` honest against topics.
- The generated sections (Available State/Commands, authoring contract, storage) — already
  schema-derived and drift-free; this proposal copies their discipline, not their content.
- Apps without `agent/docs/` — behavior is identical to today. The tier is opt-in per app.

## Server changes (small, additive)

1. `features/apps/discovery.ts` — `loadAppDocs(appId)`: enumerate `agent/docs/*.md`, parse
   frontmatter, validate slugs; cache like `loadAppSkill`.
2. `handlers/apps/docs-resource.ts` — the `/docs/` door, cloned from `protocol-resource.ts`.
3. `features/apps/describe.ts` — append the docs index rows (audience-filtered).
4. `mcp/app-agent/index.ts` — `topic` param on the `describe` tool.
5. `agents/profiles/app-agent.ts` — generated `## App Docs` appendix.
6. `scripts/check/apps.ts` — frontmatter validation, `prompt-restates-topic`,
   `doc-may-be-stale`, index-freshness for `AGENTS.md`.

## Non-goals

- **No dynamic rationale for rules.** Bright lines keep their one-clause why inline; a
  `see_reason` indirection fails exactly when it's needed (violation without hesitation) and
  saves nothing under prompt caching.
- **No auto-injection of topic bodies.** The agent pulls; the platform only ever pushes the
  index. Pushing bodies on heuristics rebuilds the always-loaded tier with extra steps.
- **No platform-doc migration.** `docs/`, package CLAUDE.md files, and skills already have
  their own tiers; this proposal is scoped to per-app knowledge.

## Status (2026-08-20)

The sibling audit's prune pass (step 1 of `devtools_channel_audit.md`, verdicts A–B, D–H,
K–T) has **landed**: `apps/devtools/agent/prompt.md` went 35.0 KB → 30.3 KB by deleting
restatements of the MCP schemas, the protocol descriptions, the compiler's design-token
brief, and the platform's appended sections; the gated-SDK method rosters
(`@bundled/yaar-dev`/`yaar-web`) were also cut in favour of `describeBundledLibrary`. Two
facts migrated *into* descriptors rather than being deleted: the no-project `"Done."` trap
(→ the `project` state key) and writeFile's array-of-objects refusal (→ its command
description).

**The tier itself has landed** (same date, one pass so sections moved once):

- Server: `features/apps/docs.ts` (+ the pure `doc-frontmatter.ts` leaf shared with the
  lint), the `yaar://apps/{id}/docs` resource (`handlers/apps/docs-resource.ts`), the
  `docs` section in `describeApp`, the `topic` param on the app agent's `describe` tool,
  the generated `## App Docs` prompt appendix, and clone/deploy carrying `agent/docs/`.
  Finding C rides in: own-app `describe({})` now returns the docs index, and the prompt's
  steering sentence is gone. Pinned by `tests/app-docs-doors.test.ts`.
- Lints (`scripts/check/apps.ts`): `app-doc-frontmatter` (ERROR), `prompt-restates-topic`
  and `doc-may-be-stale` (ADVISORY).
- Devtools migration: `prompt.md` restructured 30.3 KB → 11.4 KB; eleven `audience: agent`
  topics (~22 KB) under `apps/devtools/agent/docs/`. Slightly wider than the worked split
  above: `verb-api`, `external-json`, and `app-structure` moved too, and the preview
  section split into an inline core loop plus a `preview-debugging` topic.

**Still open:** the `covers`-based lookup in devtools (surfacing "topics covering this
file" when a clone's file is opened for editing), and the `thesingularity-reader`
dev-audience split — both value-adds on top of the landed tier, not dependencies of it.
