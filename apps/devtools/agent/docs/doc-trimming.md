---
name: doc-trimming
description: Read before trimming an app's docs, SKILL.md, prompt.md, hint.md, protocol descriptions or comments, or after a command is removed or renamed.
audience: agent
---

## Doc Trimming

A trimming pass edits prose, never behaviour. Every change leaves the app doing exactly what it did before: same commands, same params, same defaults, same control flow. `protocol.json` descriptions are prose; command names, param schemas and state keys are not. If a doc can only be made true by changing code, report the mismatch; do not change the code.

Use it after a command or feature is removed or renamed, when a doc has grown a second copy of itself, or when prose argues with an imaginary reader. The writing rules themselves are `authoring-style`; which file serves which reader is `markdown-files`.

### Never discard work that is not yours

`gitRestore`, `deleteProject` and re-cloning over an open project are forbidden during a trimming pass. The project may hold uncommitted edits that are not yours and not in your context; restoring or re-cloning removes them silently. This binds hardest when a compile fails or a diff looks wrong and a clean slate looks like the way back. It is not. Stop and report: you did not break what you did not touch, and a failure you cannot explain is information for the caller. The only history commands you run are `gitHistory` and `gitDiff`.

### The four jobs

**1. Slogans → the plain fact.** A sentence that frames rather than informs is replaced by what the reader needs to do. Delete it outright only when it carried no information; otherwise the fact it wrapped must survive.

- *"One question, one narrow command:"* above a table that already maps questions to commands → delete it.
- *"`project` is not the status check. It dumps the whole record to read one field."* → document the state key that *is* right and stop there.
- Headers that editorialise (`## Asking the app a question`) → say the thing (`## Reading state`).

**2. Strawman / defensive prose → nothing.** Text that argues with a reader who is not in the room:

- Pre-empting a confusion nobody has: *"Note this is NOT `refresh`, which means…"* → state what the command does.
- Origin stories: *"the protocol could do this long before the UI could"*, *"this used to live in main.ts"*.
- Justification tails on a comment or description that already stated the fact: *"— the missing piece when skimming"*, *"which is when you actually go looking for it"*.
- Tombstones. A removal note is only for a command that other apps' hints, prompts or SKILL.md files still name; a short-lived internal command does not get one.

**3. Duplication → one canonical home + pointers.** Pick the file that owns each fact and make the others a one-line pointer, or nothing. Default ownership in an app:

- `agent/hint.md`: when the monitor should route work here, 1–3 sentences.
- `agent/SKILL.md`: an outside caller's workflows and ordering constraints. Never a restatement of `protocol.json`.
- `agent/prompt.md`: what the app's own agent needs on every turn; bright-line rules only when a topic covers the rest.
- `agent/docs/*.md`: reference pulled on demand, one topic per file.
- `protocol.json` description: one line, the effect plus the precondition that makes it fail.
- `AGENTS.md`: module map and invariants for whoever edits the source.
- A code comment: what *that* code cannot say, not the whole subsystem.

**4. Explainer documents → the mechanism, and nothing else.** When the target introduces a design (an architecture section of `AGENTS.md`, a design topic in `agent/docs/`) rather than recording work, the version history is already the log. Cut dates, version numbers, bug narratives, dead-end lists, comparisons with the design it replaced, "it is not an X" disclaimers, the rationale for a constant's value, open questions and not-yet-decided hedging, and tables that define the thing by listing what it is not. Keep the mechanism and the numbers that *specify* it (a size cap, a timeout, a chunk length). Write each block as goal → problem → solution in the fewest plain sentences: what it must achieve, what breaks the obvious way, what it does instead. Never narrate a screenshot or diagram the reader is looking at: no reading order, no enumerating what the picture shows, no "see the next section". In these documents, no em dashes; use a colon, comma, semicolon, parentheses or a full stop.

### What you must not cut

**A rule that encodes a real failure stays.** The test is whether a caller who ignores it loses work or a turn, not whether it is phrased as a warning. State each once, in its canonical home. Examples of this kind:

- subscribe to a completion channel *before* starting an async batch, or you only ever see "started"
- a model-loading command must run first, with a long timeout, or every later call fails
- subscribe to dialog/navigation events before a click that may submit a form
- binary writes need `encoding: "base64"`, or the base64 text lands on disk
- an `export` that only downloads to the user's computer returns no uri; results meant for another app go to `shared/{appId}/`

**When unsure whether a warning is load-bearing, keep it** and list it in the report. A kept sentence costs a line; a deleted invariant costs a failed run.

**Deliberate duplication is allowed when the readers differ**: `hint.md` (paid by the monitor every turn) and `SKILL.md` (read on demand), or `prompt.md` (this app's agent) and `SKILL.md` (outside callers), may each need the same gotcha. Say so in the report instead of collapsing it.

**Rules in `AGENTS.md`, `prompt.md`, `hint.md` and `SKILL.md` belong to the app's author.** You may compress wording and remove a copy that exists elsewhere, but before dropping the *last* statement of a rule, stop and report it as a proposal.

### Before you finish

- Never document a command, param or state key you did not confirm in `protocol.json` or `src/`. Do not invent one that "should" exist.
- When a comment's claim changes, grep `AGENTS.md` and `agent/docs/` for the same fact (the symbol, the constant, the behaviour) and correct those too. `AGENTS.md` is read first by the next agent, so a fact fixed in code and left stale there is the worse half.
- Every sentence you write is checked against the code like the one it replaces. A replacement that is wrong in a new way is worse than the original.
- No work notes in comments or docs: no "(verified by grep)", "now", "no longer", "fixed:". State the fact, not how you checked it.
- Point at code by symbol (`planDeployVersion` in `lib/app-manifest.ts`), not by file alone: a bare file name goes stale at the next folder split. Run `checkProject` and fix every `staleFileRefs` entry your pass touched.
- `format` touched source files only, with `onlyChanged: true` so lines you did not edit keep their layout, then `compile` to confirm comment edits broke nothing.
- Do not deploy, run `previewScript` suites or drive the app; the caller decides that.
- Out of scope unless asked: `dist/`, vendored or generated files, test scripts and baselines.

### Report format

```
FILES: <paths edited>

CUT
- <slogan | strawman | duplication | stale> — <what, and what replaced it, if anything>

CANONICAL HOMES
- <fact> → <file that now owns it>; pointers left in <files>

KEPT (load-bearing, judged)
- <rule> — <why it stays, and where>

NOT FIXED
- <code-vs-doc mismatch, or a rule whose last copy you propose removing>
```

Keep the report under 400 words. Report what you changed, not why it was good.
