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

## Layout

The detail panel never scrolls as a whole. Header + metadata strip are fixed;
`.transcript-section` takes the rest and `.transcript-body` scrolls internally.
`.transcript-body > * { flex-shrink: 0 }` is load-bearing: without it, a long
transcript collapses every turn to a sliver, because `.msg-card`'s
`overflow: hidden` resolves the automatic minimum size to 0.