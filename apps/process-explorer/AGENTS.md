# Process Explorer — notes for whoever edits this next

A read-mostly panel over three server lists: the agent roster, the window list,
and the installed-app roster. The "apps" view is not a fourth fetch — it is a
join of the first two (see `appProcesses` in `src/store.ts`).

## Layout

```
src/
├─ main.ts          thin: defineApp only
├─ protocol.ts      the agent-facing state keys + commands
├─ data.ts          barrel — the data layer's public face
├─ store.ts         signals, derived views, mutators   (no I/O)
├─ fetchers.ts      the three list reads               (validates, fills store)
├─ streams.ts       per-agent live activity            (folds frames into store)
├─ actions.ts       the four control actions          (write, then re-read)
├─ watch.ts         mount-time subscriptions + clock
├─ schema.ts        Zod boundary schemas
├─ types.ts         shared types
├─ format.ts        pure display formatters
├─ theme.ts         runtime-value → colour tables
├─ constants.ts     URIs, tier names, thresholds
└─ components/      one file per tab + the shared list shell
```

Components import from `data.ts`, never from `store.ts`/`fetchers.ts` directly.
The barrel deliberately omits the setters: nothing outside the data layer writes
the store.

## Things that will bite you

**`html` unwraps function props into reactive getters.** Passing a render
callback as a prop (`row=${(x) => ...}`) makes it fire during render with no
arguments. `ProcessList` therefore takes its row renderer as *children*, exactly
as `For` does — and the children function must sit tight against the tags
(`>${(x) => ...}</>`), because surrounding whitespace turns `children` into an
array of text nodes plus the function, which `For` cannot use. This compiles
clean and renders a blank panel, so it will not announce itself.

**HTML entities interpolated through `${}` do not decode** — they are set as
`textContent`. The empty-state glyphs are passed to `ProcessList` as literal
characters (`~`, `□`, `▣`) for this reason. The lock icon in `WindowRow` is
still an entity because it lives in *static* template text, where entities work.

**The protocol is the contract.** The four state keys (`stats`, `agents`,
`windows`, `apps`) and five commands in `protocol.ts` are what other agents call.
`WindowInfo.uri/position/lockedBy` and `AgentEntry.monitorId` look dead — no
component reads them — but they ship inside the `windows` and `agents` state
payloads, so deleting them is a protocol change, not a cleanup.

**Params are JSON Schema literals, not Zod.** A Zod schema is a call result, so
the compiler would have to import this app to extract the manifest. Keep them
literal.

**`yaar://session/*` is session-agent-only, so the agents tab cannot be tested
in a devtools preview** — it fails with a permission error and renders its empty
state. Windows and apps do work there. Test agent behaviour against the deployed
app.

## Token accounting

Displayed input is `inputTokens + cacheWriteTokens`, cache **reads excluded** —
`inputRead()` in `format.ts` is the only place that sum is taken. The long
comment there explains why; do not add these fields by hand elsewhere.
