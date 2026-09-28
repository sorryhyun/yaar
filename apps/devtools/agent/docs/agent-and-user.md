---
name: agent-and-user
description: Read before deciding what a user action tells the agent, what an agent action shows the user, or what a state key returns when a read fails.
audience: agent
---

## One App, Two Users

Every app is driven by a person and by an agent at once, and each sees the other only
through what the app chooses to pass along. The bundled apps settled these rules.

### Which user actions wake the agent

A user action that the app can finish itself stays **local** — no `sendInteraction`.
browser's address bar navigates the remote tab and tells no one; only a string its
parser *cannot* read as an address (`summarize this page`) reaches the agent, as
`{ event: 'user_query', query }`. When the classifier can be wrong, pick the cheap
direction: a phrase misread as an address navigates to a dead host, while an address
misread as a phrase only costs an agent turn. *Seen in:* browser `src/url.ts`
(`parseAddress`), `AGENTS.md`.

### Agent actions leave a trace the user can see

An agent run that changes nothing on screen looks, to the person watching, like nothing
happened. lab logs every protocol `runCode` into an Agent view (pulled to the front,
since it has no cell to render into), while `runCell`/`runAll` flash the cell they ran.
**The command's return value stays UI-independent**: agents parse
`{ ok, logs, result, truncated }`, and anything added for the panel goes to the log, never
into the reply. *Seen in:* lab `src/protocol/run.ts`, `state/agent-runs.ts`.

### The agent reads by question, the UI by data

The UI can hold a 6,874-turn session in memory; an agent must not read it whole, and a
state getter takes no parameters. So session-logs splits by *question*:
`query('messages')` returns an index (histograms and counts, zero rows), and
`command('readTurns', { … })` returns the rows asked for. **Every row carries its index in
the unfiltered set**, or a filtered hit cannot be followed back to its context. Blobs stay
on disk until a windowed `readBlob` asks. *Seen in:* session-logs `AGENTS.md`.

### One truncation per reader

Three readers, three budgets: lab caps generously for the **UI** (5,000 rows, 250KB),
tightly for the **agent** (an 8KB byte budget filled with a row sample, reporting `shape`
and `truncated`), and again before writing to **disk** (so a notebook file cannot grow
without bound). One shared cap is wrong for at least two of them.

### A failed read is not an empty one

- market-apps: a failed installed-list read must **not** reconcile — an empty list would
  clear every installed card on a transient hiccup.
- devtools: `consoleLogs` and `permissions` return a structured reason ("no preview
  open", "preview unreachable") rather than `[]`, which would read as "the app logged
  nothing".
- mcp-manager's port sweep swallows every error as "nothing here", so a systemic fault
  (a missing permission) looks exactly like a quiet network; its note says to look for the
  identical repeated reason in the console.

A state key that can fail returns *which* failure, never the empty value.

### A verdict from before the last write is `unknown`

devtools' `compileStatus` is three-valued. After **every** write the typecheck verdict
resets to `unknown`, surfaced as `"unchecked"` — reporting the old `clean` once waved six
live type errors through as success. Any cached verdict (validation, sync state, "saved")
invalidated by an edit goes to unknown, not to its last value.

### Consent that belongs to the user stays with the user

market-apps' agent `publish` runs the dialog's prepare → confirm but **never** sends the
terms acceptance and never confirms across drift; both come back as a status for the
person. Its agent `updateAll` skips the per-app replace prompt, because an agent calling it
was already told to update. Skipping a repeated confirmation is fine; manufacturing the
user's agreement is not.

### State payloads are the contract

A field no component reads may still ship in a state key another agent parses —
process-explorer's `WindowInfo.uri`/`lockedBy` look dead and are not. Deleting one is a
protocol change: check `manifest` drift and callers, not just local references.
