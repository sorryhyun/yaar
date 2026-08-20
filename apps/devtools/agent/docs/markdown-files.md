---
name: markdown-files
description: Read before writing AGENTS.md, agent/prompt.md, hint.md, SKILL.md, or agent/docs/ into an app — five surfaces, four readers.
audience: agent
---

## Markdown Files in an App

Four files and one directory, four readers. All optional; all carried by clone and deploy,
so what you write into the project survives the deploy and comes back on the next clone.

- **`AGENTS.md`** (root) — for whoever edits this app next, usually you. YAAR never reads
  it; it is the standard name a coding agent looks for in a directory, so **read it first
  when you open a project that has one, and keep it current as you work.** Write one for any
  app big enough that you had to work something out: the shape of `src/`, invariants not
  visible from any one file, why something is hand-rolled, what breaks if it changes. A
  small app needs none.
- **`agent/prompt.md`** — the app agent's prompt. It *replaces* the generic one entirely, so
  it must document the tools itself. The `protocol.json` manifest is appended automatically
  and the platform adds its own tool-payload rules — duplicate neither. Focus on how to
  *use* the protocol: concrete `command`/`query` examples, multi-step workflows, the domain
  concepts needed to build valid params, anti-patterns.
- **`agent/hint.md`** — injected into the *monitor* agent's prompt, not this one. Says
  *when* to route work here, not how it works. 1–3 sentences. Auto-syncs with
  install/uninstall.
- **`agent/SKILL.md`** — no prompt reads it. It is the hand-written manual
  `describe('yaar://apps/{id}')` returns, so its reader is whichever agent is deciding how
  to drive the app: workflows, ordering constraints, the concepts a caller needs to build
  valid params, when *not* to use the app. Anything longer than a hint's few sentences
  belongs here rather than in `agent/hint.md` — the monitor agent pays for a hint on every
  turn and reaches a SKILL.md only when it asks. Never restate `protocol.json` in it: the
  protocol is served beside it at `yaar://apps/{id}/protocol`, and `scripts/check/apps.ts`
  warns when SKILL.md duplicates it.
- **`agent/docs/*.md`** — one topic per file, pulled on demand: reference too long for
  `prompt.md` (which pays for every line on every turn) and too specific for `SKILL.md`.
  Each file opens with frontmatter — `name` (matching the filename), a one-line
  `description` written as the *trigger* ("read before touching X", ≤150 chars), and
  optionally `audience: agent|dev|both` (who it serves: the app's runtime agent, whoever
  edits the source, or both). The platform generates the index into the app agent's prompt
  and into `describe`; a topic whose description is a summary instead of a trigger will
  never be pulled. If a topic exists, `prompt.md` must not restate its content — keep the
  bright-line rules inline, move the reference prose.

No file *appends* to the generic app-agent prompt — `agent/prompt.md` replaces it or you get
the generic one whole. The line between these files is the **reader**, not the topic:
"`src/gizmo.ts` is hand-rolled because the bundled control drops pointer capture" is
`AGENTS.md`; "call `addPrimitive` before setting a material" is `agent/prompt.md` if this
app's own agent needs it on every turn, `agent/docs/` if it needs it rarely, and
`agent/SKILL.md` if an outside caller does.
