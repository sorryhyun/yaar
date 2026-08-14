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

## Invariants worth knowing

**The transcript render must not be able to throw.** This is the big one — it
cost a whole release. `loadMessages` does `setState('messages', …)`, and Solid
runs effects *synchronously* inside `setState`. So an exception thrown while
rendering a single turn does not just lose that turn: it unwinds back out
through `setState` into `loadMessages`'s own try/catch, which logs
"Failed to load messages" and swallows it. The visible result is bizarre and
misleading — `state.messages` is already assigned, so the count badge renders
"6874 turns", while the list memo aborted mid-update and leaves the previous
raw-markdown fallback on screen. Header and body disagree in the same frame,
and the console blames the *load* for a *render* bug.

Three defences, all load-bearing, none redundant:

1. `api.normalizeMessages()` coerces every entry at the boundary — `content`
   and `interaction` come back as strings or undefined, always. Entries are
   heterogeneous and some runtimes send block form
   (`[{ type: 'text', text }]`) or a bare object where the type says string.
2. `summarize.ts`'s `str()` guards every helper that calls a string method.
   The types claim `string`; the data does not always agree. Do not "clean
   this up" because the signature looks over-defensive.
3. `SafeMessageCard` in `transcript.ts` wraps each row, so one bad entry costs
   one row instead of the whole pane.

**The turn count and the turn list must read the same accessor.** Both go
through `turns()` in `transcript.ts`. When they read separate expressions they
can disagree, and a disagreement is invisible until someone screenshots it.

**Protocol state getters must return `toPlain(…)`, never store data directly.**
Everything in `store.ts` is behind a Solid store proxy, and the structured
clone algorithm does not run proxy traps — it reads internal slots — so a
Proxy is not cloneable at all. Returning `state.sessions` from a state getter
fails the postMessage hop out of the iframe with `DataCloneError`, however
plain the underlying data is. `transcript` (a plain string) read fine
throughout, which is what made this look like a data problem rather than a
wrapper problem.

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
are informative at the *head*, so `splitTarget` deliberately declines them —
that is what the `pathLike` test is for, not an optimisation.

**`maxTail` is a budget, not a minimum.** A pinned tail cannot shrink, so a
tail wider than the pane overflows instead of eliding. Raising it much past 20
chars reintroduces the bug it exists to fix.

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
`content` is `[{ type: 'text', text: '…' }]` or a bare object. That single
entry is the entire regression above, and a fixture of well-formed data cannot
see it. The assertion is that all turns still render and the count badge
matches the number of rows.

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