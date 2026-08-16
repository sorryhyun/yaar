# market-apps

Browse, install, uninstall and publish marketplace apps. A bundled **system** app:
it is the only app allowed to call YAAR's Google auth routes, which is why sign-in
and publishing work here and nowhere else.

## Layout

Five layers, each a directory with an `index.ts` barrel. Dependencies point one way
only — `components → actions → api → parsers`, with `store` read by everything above
it and `constants`/`types`/`schema` read by everything.

| Directory | Holds | Never does |
|---|---|---|
| `parsers/` | Pure readers for untrusted input: ids, versions, the two app lists, GitHub status | Touch signals or the network |
| `api/` | Every outbound call. `http.ts` = marketplace + GitHub + YAAR auth routes; `host.ts` = `yaar://apps/{id}` verbs | Touch signals |
| `store/` | All state. `signals.ts` (the signals), `queries.ts` (questions about one app), `installed.ts` (install reconciliation), `selectors.ts` (the derived lists) | Perform I/O |
| `actions/` | Everything the user can *do*, by domain: `catalog`, `publish`, `auth`, `github-status` | Render |
| `components/` | One module per band of the UI, each paired with the stylesheet of the same name in `styles/` | Hold state (except a private UI signal) |

`main.ts` is the protocol surface only: `defineApp` with 8 state keys and 7 commands,
all delegating into `store` and `actions`.

## Invariants worth knowing

- **Ids are compared through `normalizeId`, never `===`.** They arrive from three
  sources (catalog, host list, owned-app list) that disagree about case and padding.
- **`installedVersionOrder` is the single version comparison.** The card's "Install
  update" branch and its publish button both read it. They used to compare
  independently and disagreed about the same app — that is the bug the `'unknown'`
  third answer exists to prevent. Do not fold `'unknown'` into `'newer'`/`'older'`.
- **Every user action goes through `runAction`** (loading flag + status line). The two
  exceptions are documented in place: `confirmPublish` drives the dialog's own busy
  flag, and `refreshGithubStatus` is ambient and must stay silent.
- **A failed installed-list read is not "nothing is installed".** `refreshData`
  deliberately does not reconcile on that path — reconciling an empty list would
  clear every installed card on a transient hiccup.
- **The install grace window** (`INSTALL_RECONCILIATION_GRACE_MS`) exists because the
  host's app list lags a successful install. `store/installed.ts` is the whole of it.
- **`SearchMode` values appear as literals in three places** — the tuple in
  `store/signals.ts` (source of truth for the type), the JSON Schema enum in
  `main.ts` (the protocol extractor reads it statically, cannot follow an import),
  and the `<option>` elements in `components/search-bar.ts` (Solid applies the
  select's `value` as it builds the element, so mapped options would start blank).
  Adding a mode means editing all three.

## Solid gotchas that bit here

- Dialogs and the banner use **stable outer node + reactive inner content**
  (`<div>${() => …}</div>`), so they appear and disappear without the parent
  re-rendering.
- `solid-js/html` **drops literal whitespace between two adjacent `${}`
  expressions** — build such strings in one interpolation (see `githubBanner`).

## Testing

The preview runs under its own principal, so `/api/auth/google/*` is closed to it:
the account panel always shows "sign-in is disabled" and the publish button never
renders. Catalog browsing, search, filters and the settings popover all work there;
**sign-in and the publish dialog can only be exercised in the installed app.**