# Audit: the devtools agent's instruction channels — map, duplications, prune plan

**Status:** proposal (audit with actions)
**Date:** 2026-08-20
**Sibling proposals:** [`app_agent_docs_proposal.md`](./app_agent_docs_proposal.md),
[`devtools_authoring_guide_proposal.md`](./devtools_authoring_guide_proposal.md),
[`devtools_delegation_proposal.md`](./devtools_delegation_proposal.md).

## Problem

Instruction text reaches the devtools agent through **24 distinct channels** across six
authorship regimes (hand-written prompt, shared platform sections, schema-generated
manifest, MCP tool schemas, clone-carried files, app-authored worker prompts). Nobody
decided this — it accreted. Two consequences:

- **Weight:** the always-loaded tier alone is ~64–68 KB per turn — 35 KB `agent/prompt.md`,
  ~20–24 KB generated Available State/Commands, ~5 KB Authoring Contract, ~3 KB storage
  sections, ~1 KB payload rule, plus tool schemas.
- **Drift:** the same fact is stated in multiple channels in different voices, and a change
  to one copy does not propagate. The repo's own rule — "a fact asserted in both places is
  a fact that will eventually disagree with itself" — is itself stated **four times** across
  two files, which is the problem demonstrating itself.

## The map

Condensed by tier; full trace in the table below. (Sizes measured for devtools.)

**Always loaded, every turn (~64–68 KB):**

| Channel | Source | Size | Author |
|---|---|---|---|
| Base prompt (full override) | `apps/devtools/agent/prompt.md` | 35.0 KB | hand |
| Available State + Commands | generated from `src/protocol/*.ts` descriptions (12 keys, 30 commands) | ~20–24 KB | hand prose, generated assembly |
| App Authoring Contract | `app-agent.ts:buildAuthoringContract` + `describeDesignTokensBrief()` | ~5 KB | hand + compiler |
| Storage sections (app + shared) | `app-agent.ts:106-176` | ~2.8 KB | hand, shared |
| Payload-literal rule | `shared-sections.ts` | 1.0 KB | hand, shared |
| Controllable Apps | `app-agent.ts:307-318` | ~0.3 KB | template + generated |
| MCP tool schemas (`query`/`command`/`describe`/`relay`/`direct_message`) | `mcp/app-agent/index.ts`, `mcp/messaging/index.ts` | ~1.2 KB | hand |

**On demand:** `describe({appId})` (~8 KB per app, incl. target's SKILL.md);
`describe` on one command (full schema); `inspectUri` → `yaar://skills/{topic}` (4 platform
reference docs); post-clone filesystem — the *target* app's `AGENTS.md` /
`agent/*.md` land in the project tree (721 lines for thesingularity-reader); devtools' own
`AGENTS.md` (12.9 KB) when editing itself.

**Spawn-time (worker's view, not the main agent's):** `WORKER_PROMPT` (~2 KB, verbatim, no
platform append) + worker tool schemas (~1.5 KB) — authored inside devtools' own iframe
code (`services/worker.ts`).

**Adjacent:** `agent/hint.md` (0.9 KB, monitor agent) — the channel that routes work *to*
devtools.

## The audit rule

**One owner per fact, per reader.** Two principles the codebase already half-practices,
made explicit:

1. The canonical copy of a fact is the one **closest to the code** — a generated section or
   a tool's own schema beats hand-written prose. The prose copy becomes a pointer or a
   devtools-specific *delta*, never a restatement.
2. Dedup is **per reader**: the worker and the main agent may each need the same fact once
   (different contexts), but two copies reaching the *same reader in the same turn* is
   always a bug.

## Findings and verdicts

| # | Duplication (channels) | Verdict |
|---|---|---|
| A | `direct_message` contract stated 3× — MCP schema, generic fallback prompt, devtools `prompt.md:13` — same three facts (targets, async, `end_turn`), three wordings | **MCP schema is canonical.** `prompt.md` keeps only the devtools delta ("messaging: all → app:/window: targets allowed"), drops the rest |
| B | `query`/`command`/`describe` semantics — MCP schemas vs `prompt.md:9-11` | Same: schemas canonical; `prompt.md` Tools section shrinks to the flat-payload rule and devtools-specific notes (`appId` reads a controllable app) |
| C | `describe({})` on own app returns a strict subset of the always-injected Available Commands; `prompt.md:11` steers around it in prose | **Platform fix, rides the docs-tier proposal:** own-app `describe({})` should return the *docs index* (topics + protocol doors) instead of a manifest subset — turning the dead-end into the door, and the steering sentence gets deleted |
| D | Design-token silent-failure warning — compiler-generated (`design-tokens.ts:166`) vs hand-written `prompt.md:149`, near-verbatim | **Generated copy wins.** Delete the `prompt.md` sentence |
| E | Lab's `http.raw/text/json` shape copied verbatim from Lab's SKILL.md into `prompt.md:257` | Delete the signature from `prompt.md`; keep one scent line ("Lab's `http` differs from fetch — `describe({appId:'lab'})` before first use"). Long-term home: the `lab-control` topic in the docs tier |
| F | "describe first, then command with appId" — generated Controllable Apps section vs hand-written `prompt.md:241-249` | Generated section canonical; `prompt.md` keeps only the judgment content (when to use direct control vs `direct_message`) |
| G | "Don't restate the generated sections" — stated 4× (`AGENTS.md` ×2, `prompt.md` ×2) | State once in `AGENTS.md`; `prompt.md` keeps one pointer line beside the appended-sections note. The rule graduates from prose to lint (`prompt-restates-topic` / `prompt-restates-tool-description`, see Enforcement) |
| H | Worker is read-only — `workerTask` description, `prompt.md:55`, and `WORKER_PROMPT` | Per-reader rule: `WORKER_PROMPT`'s copy stays (different reader). For the main agent, the **command description is canonical** (it's read at decision time); `prompt.md`'s Worker section drops the restatement and keeps the workflow judgment (start-before-own-work, verify reports) |
| I | "A **different tree**…" sentence duplicated verbatim across the two storage sections — intentional symmetry per the code comment | Accept, but single-source: hoist the sentence to one const interpolated into both, so symmetry can't drift |
| J | Every cloned app carries its own restatement of the platform doc conventions, so a session accumulates N copies | Addressed by the docs-tier proposal (`AGENTS.md` → index); no separate action here |

## Expected effect

- `agent/prompt.md`: findings A/B/D/E/F/G/H remove restatements (~4–6 KB); the docs-tier
  proposal's reference-section migration removes ~60% more. Combined target: **35 KB →
  ~10–12 KB** of bright lines, workflow, and deltas.
- Always-loaded total: ~64–68 KB → **~40–45 KB**, most of the remainder being the generated
  manifest — which the docs tier and description-style rules (`authoring guide`, Layer 2)
  then govern.
- Channel count doesn't shrink much (most channels are structural), but **authority
  becomes decidable**: for any fact, the owner is the channel closest to code, and every
  other appearance is a pointer.

## Enforcement

One-time prune plus two lints so it stays pruned (both in `scripts/check/apps.ts`, same
shape as `skill-restates-protocol`):

- `prompt-restates-tool-description` — a `prompt.md` line documenting an MCP tool's generic
  contract (heading or backtick-signature match against the registered descriptions).
- `prompt-restates-topic` — already specified in the docs-tier proposal.

Plus the per-reader rule recorded in the authoring guide (Layer 2) so future prose is
written as delta-plus-pointer by default.

## Order of operations

1. This audit's prune pass on `prompt.md`/`AGENTS.md` (verdicts A–I) — independent, do first.
2. Docs-tier migration (`app_agent_docs_proposal.md`) — moves the reference sections.
3. Lints land with whichever of 1–2 merges second.
4. Finding C's platform fix rides the docs-tier server work.
