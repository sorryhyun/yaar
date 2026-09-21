# Session Logs — notes for the next editor

Browses `yaar://history/`. Read-only over session data; the one write is
`saveReport` → `appStorage` under `reports/`.

## Source map

- `src/main.ts` — `defineApp`, the Root shell (header / sidebar / detail panel).
- `src/api.ts` — the four `yaar://history/` reads. Nothing else touches the verbs.
- `src/store.ts` — session **data** (Solid store).
- `src/ui.ts` — chrome **state**: sidebar/metadata prefs and the narrow breakpoint.
  Kept apart from `store.ts` so the persisted view prefs have one home.
- `src/transcript.ts` — turn rendering: dense log rows + prose cards.
- `src/summarize.ts` — pure string logic for the one-line rows. Unit-testable,
  no DOM, no imports from the app.
- `src/select.ts` — the **agent's** view of a session: filter, page, compact,
  index. Also pure and DOM-free. Nothing in the UI reads it.

## The agent reads a different session than the UI does

The UI needs the whole array in memory: the transcript pane scrolls every row.
An agent does not, and a state getter takes no arguments, so a `query('messages')`
that returned the array would make an agent read a 6874-turn session whole.

So the split is by *question*, not by data. `query('messages')` answers "what is
in here" with `indexSession()` — histograms and counts, zero turns.
`command('readTurns', …)` answers "give me these" with `selectTurns` +
`compactTurn`, because a **command takes parameters and a state getter cannot**.
Keep the reads as commands.

Two consequences:

- **Every turn carries its `index` in the unfiltered array.** A filtered hit is
  useless if you cannot go back and read what surrounded it, and the position in
  the *filtered* set does not address anything.
- **`compactTurn` must return plain data.** `state.messages` is behind a Solid
  store proxy, so a sub-object handed back by reference (e.g. `msg.action`)
  fails the postMessage hop with `DataCloneError` — the same trap the state
  getters have. Strings and freshly-built objects are safe; a nested proxy is not.

Blob bytes stay on disk until `readBlob` asks (`api.readBlob` →
`yaar://history/{id}/blobs/{sha256}`), and it returns a character window. A
session's blobs run to megabytes; that call is the one place where an unbounded
read would undo everything above.

## Invariants

**The transcript render must not be able to throw.** `loadMessages` does
`setState('messages', …)`, and Solid runs effects *synchronously* inside
`setState`. So an exception thrown while rendering a single turn does not just
lose that turn: it unwinds back out through `setState` into `loadMessages`'s own
try/catch, which logs "Failed to load messages" and swallows it. The visible
result: `state.messages` is already assigned, so the count badge renders "6874
turns", while the list memo aborted mid-update and leaves the previous
raw-markdown fallback on screen. Header and body disagree in the same frame, and
the console blames the *load* for a *render* bug.

Three defences, all needed:

1. `api.normalizeMessages()` coerces every entry at the boundary — `content`
   and `interaction` come back as strings or undefined, always. Entries are
   heterogeneous and some runtimes send block form
   (`[{ type: 'text', text }]`) or a bare object where the type says string.
2. `summarize.ts`'s `str()` guards every helper that calls a string method.
   The types claim `string`; the data does not always agree. Keep the guards
   even though the signature makes them look redundant.
3. `SafeMessageCard` in `transcript.ts` wraps each row, so one bad entry costs
   one row instead of the whole pane.

**The turn count and the turn list must read the same accessor.** Both go
through `turns()` in `transcript.ts`; separate expressions can disagree.

**Protocol state getters must return `toPlain(…)`, never store data directly.**
Everything in `store.ts` is behind a Solid store proxy, and the structured
clone algorithm does not run proxy traps — it reads internal slots — so a
Proxy is not cloneable at all. Returning `state.sessions` from a state getter
fails the postMessage hop out of the iframe with `DataCloneError`, however
plain the underlying data is.

**A log row is one line, always.** Everything that is not prose (tool calls,
results, reasoning, actions, UI interactions) is a `<details>` whose `<summary>`
*is* the row — there is no nested disclosure box. `.log-summary` sets
`white-space: nowrap; overflow: hidden` as the hard backstop. If you add a
column, give it `flex-shrink: 0` and a `max-width`, or it will fight the target
for space.

**Target truncation keeps the tail, and CSS cannot do it.** `text-overflow:
ellipsis` always eats the end, which on a URI is the only part worth reading.
So `splitTarget()` cuts a path-like target at a separator and the row renders
two spans: `.log-target-head` shrinks and takes the ellipsis,
`.log-target-tail` is pinned. This adapts to the real pane width, which a fixed
character budget cannot. Prose targets (a thought preview, an error message)
are informative at the *head*, so `splitTarget` declines them; that is what the
`pathLike` test is for.

**`maxTail` is a budget, not a minimum.** A pinned tail cannot shrink, so a
tail wider than the pane overflows instead of eliding. Keep it near 20 chars.

**`toolSummary` parses the verb tools exactly** (`mcp__verbs__{verb}` +
`input.uri`) and degrades everything else to short-name + most identifying
param via `IDENTIFYING_KEYS`. Add new keys to that list rather than
special-casing a tool.

**The agent chip hides below 800px** (media query, not JS) — it repeats on
nearly every row and the URI needs the pixels. It stays in the row's `title`.

## Testing

The preview principal **cannot read `yaar://history/`** — Dev Tools holds no
such permission and a preview never exceeds its host's. So the preview always
shows "Not permitted". To check layout, add a temporary `loadFixture` command
that `setState`s synthetic sessions/messages, verify, then delete it before
deploying. Cover: a verb tool, a non-verb tool, a tool with no recognised
param, a very long URI, an error result, an action and an interaction — those
are the branches in `summarize.ts`.

**Always include a malformed entry in that fixture** — a `tool_result` whose
`content` is `[{ type: 'text', text: '…' }]` or a bare object; a fixture of
well-formed data cannot catch the render-throw above. The assertion is that all
turns still render and the count badge matches the number of rows.

For `normalizeMessages`, a temporary `testNormalize` command that runs the
function over an array of payload shapes and returns the counts is the fastest
unit test available here. Shapes worth covering: the `{ messages: […] }`
envelope, a bare array, either of those as a JSON string, a string still
carrying a `[Resource from verbs at …]` prefix, `null`, a non-JSON string, a
number, an envelope whose `messages` is not an array, and an array of
non-objects. Every one must return an array and none may throw.

## Layout

The detail panel never scrolls as a whole. Header + metadata strip are fixed;
`.transcript-section` takes the rest and `.transcript-body` scrolls internally.
`.transcript-body > * { flex-shrink: 0 }` is load-bearing: without it, a long
transcript collapses every turn to a sliver, because `.msg-card`'s
`overflow: hidden` resolves the automatic minimum size to 0.