# Moving the shell into userland — Tier 1

YAAR ships thirteen bundled apps and still renders a great deal of its own product surface in
React, inside `packages/frontend/src/components/overlays/`, or decides it in `packages/server/src/features/`.
Some of that is load-bearing. Some of it is a view over data the verb layer already carries, and
is in the shell only because it was written before the app existed.

This document proposes the first tranche — the migrations that need **no new rendering primitive**.
A [second tranche](#what-tier-1-deliberately-leaves-alone) is blocked on a window variant that can
cover the desktop, and is out of scope here.

## The test

> A thing belongs in the shell or the server if it is **the mechanism that makes trust or
> rendering possible**. It belongs in an app if it is **a view over data the verb layer already
> exposes**, or **domain copy about one product surface**.

Applied honestly, the test splits most candidates *down the middle* rather than moving them
whole. That split has a repeating shape, and naming it is most of the value of this document:

> **The app owns the view and the choosing. The host keeps the privileged act, reached through a
> narrow verb that asks for itself.**

This is already how `market-apps` works — it renders its own replace-install warning
(`confirmReplaceInstall`, via `showConfirm` from `@bundled/yaar`) while `installApp` keeps the
consent dialog that writes `config/app-grants.json`. Tier 1 applies that same shape three more
times.

A consequence worth stating up front, because it is the actual argument for doing this: **every
migration adds a verb, and a verb is addressable by the agent too.** Restoring a session is
impossible for the agent today because the only door is a host-only REST route. Moving the view
into an app is what forces the door to become a verb.

## Scope

| # | Migration | Server change | Net deletion |
|---|---|---|---|
| 1 | Skill topics → the app that owns them | topic merge in `features/skills/` | 2 `.md` files |
| 2 | Session browse/restore → `session-logs` | `invoke yaar://history/{id} {action:'restore'}` | ~400 lines + 8 locales |
| 3 | Remote QR → `configurations` | `read yaar://system/remote` | ~230 lines + 2 npm deps |

Two candidates from the initial survey are **not** here, and the reasons are worth recording:

- **`RecentActionsPanel`** — its data (`activityLog`) is client-only state in `debugSlice.ts`,
  a 200-entry ring buffer the store fills as it applies actions. Nothing server-side carries it,
  so an app cannot subscribe to it. Needs an `actions` stream source first → Tier 2.
- **`features/market/google-auth.ts`** — the PKCE flow depends on Google redirecting to
  `/api/auth/google/callback` **on this server's own listener**, and on a refresh token persisted
  to `config/credentials/google.json` with restricted permissions. Splitting the flow across the
  iframe boundary would leave the callback and the credential server-side anyway, and buy a
  seam where there is now a straight line. It stays.

---

## 1. Skill topics belong to the app they document

### Today

`packages/server/src/features/skills/` holds four markdown files compiled into the binary via Bun
text imports, served as `read('yaar://skills/{topic}')`:

| Topic | Documents | Owner |
|---|---|---|
| `components` | the Component DSL | the shell — genuinely core |
| `remote` | remote mode | the shell — genuinely core |
| `marketplace` | the marketplace HTTP API, templated with `{{MARKET_URL}}` | `market-apps` |
| `config` | settings, hooks, domains, shortcuts | `configurations` |

The last two describe the API surface of one bundled app each. They ship, and are advertised in
the `yaar://skills` listing, whether or not that app is installed. `marketplace.md` teaches the
agent to call `invoke('yaar://http', { url: '{{MARKET_URL}}/api/apps' })` — a route that exists
because `market-apps` exists.

### Proposal

Let an app contribute skill topics from its own directory, and have `yaar://skills` merge them.

```
apps/market-apps/
  app.json
  agent/
    hint.md            # already: monitor-agent orchestration hints
  SKILLS/
    marketplace.md     # new: lazily-read reference doc
```

- `yaar://skills` lists built-in topics plus, for each installed app with a `SKILLS/` directory,
  `yaar://skills/{appId}/{topic}`.
- **Namespaced, not flat.** A market app that shipped `SKILLS/components.md` must not shadow the
  Component DSL reference. The appId segment makes collision impossible rather than
  first-writer-wins.
- The `TOPIC_NAMES` / `TOPICS` drift assertion in `topics.ts` stays, scoped to built-ins. App
  topics are discovered, so they cannot drift.

### Why `SKILLS/` and not `agent/hint.md`

`agent/hint.md` is injected into the **monitor agent's system prompt** — always-on token cost, paid on
every turn whether or not the marketplace is in play. Skill topics are read **on demand**. The
marketplace reference is a page of API tables; that is a read, not a preamble. The two mechanisms
should stay distinct, and an app should be able to use both.

### Cost

Small and self-contained: a directory scan in `features/skills/topics.ts`, a listing merge in
`handlers/skills.ts`, two files moved. No verb signature changes. `{{MARKET_URL}}` substitution
already runs in `getTopicContent()` and keeps working.

---

## 2. Session browsing moves to `session-logs`. Restore becomes a verb.

### Today, and the surprise

`SessionsModal.tsx` (223 lines) + `SessionsModal.module.css` (179 lines) + a `sessions.*` i18n
block in **eight** locale files implement a session browser: list, transcript preview, restore,
export-to-JSON.

**None of it runs.** The component is exported from `components/overlays/index.ts` and imported
by nothing. `DesktopSurface` mounts `ToastContainer`, `NotificationCenter`, `ConfirmDialog`,
`UserPrompt`, `CursorSpinner`, and `CliPanel` — not this. `sessionsModalOpen` and
`toggleSessionsModal` live in `uiSlice.ts`, and the only caller of the toggle is the modal's own
close button.

So this is not a migration. It is a deletion plus a feature that should be built one directory
over, and the fact that the duplication went unnoticed for as long as it did is itself the
argument: nobody was maintaining it, because nobody could reach it.

### What `session-logs` already has

The app declares `{ "uri": "yaar://history/", "verbs": ["list", "read"] }` and consumes
`handlers/history.ts`, which already serves four of the five things the dead modal did:

| Dead modal | REST route | Existing verb |
|---|---|---|
| list sessions | `GET /api/sessions` | `list('yaar://history/')` |
| preview transcript | `GET /api/sessions/:id/transcript` | `read('yaar://history/{id}/transcript')` |
| export JSON | `GET …/transcript` + `…/messages` | `read('yaar://history/{id}/messages')` — blob assembly is client-side |
| restore | `POST /api/sessions/:id/restore` | **none** |

### Restore is the interesting half

The restore route is `requireHost`, and its comment says why:

> Restoring rebuilds the desktop *and mints fresh iframe tokens* for every window it brings back
> — it is the desktop reconstituting itself, not a resource an app can hold a permission for.

That reasoning holds. An app that could trigger restore could cause fresh iframe tokens to be
minted for *other* apps' windows. This is exactly the split the thesis predicts: the browsing is
a view, the restore is a privileged act.

**Proposal:** add `invoke('yaar://history/{id}', { action: 'restore' })` that does **not** return
actions to the caller. Instead it:

1. Shows a host-rendered confirm ("Restore session {id}? This will replace the current desktop."),
   via `actionEmitter.showConfirmDialog` — the same door `installApp` uses.
2. On approval, performs the existing restore and **broadcasts** the window actions as desktop
   actions, the way `install.ts:broadcastDesktopAction` already does for shortcuts.

The caller learns only whether it was approved. The tokens are minted by the host, for the host,
and never cross into the iframe.

`session-logs` then declares `verbs: ["list", "read", "invoke"]` on `yaar://history/`. That is a
capability change, so it surfaces in the install dialog for a user install — correct behaviour,
and a nice check that `capabilities.ts` describes it legibly. (`yaar://history/` currently maps to
"Read past session logs"; with `invoke` the row should say so.)

### Deletion list

`SessionsModal.tsx`, `SessionsModal.module.css`, `sessionsModalOpen` + `toggleSessionsModal` from
`uiSlice.ts` / `store/types.ts` / `types/state.ts`, the `sessions.*` i18n block from all eight
locales, and the `SessionsModal` export from `overlays/index.ts`.

Whether `/api/sessions/*` survives is a separate call — `packages/tests` may lean on it. The
routes are already permission-checked through the same `requirePermission` chokepoint as the
verb, so leaving them is not a hole; it is just a second spelling.

---

## 3. The remote QR moves to `configurations`, and the token gets an honest name

### Today

`QrCodeModal.tsx` (101 lines) + `QrCodeModal.module.css` (125) render a QR for the remote connect
URL. It is mounted from `CommandPalette.tsx:293`. It pulls `qrcode` (^1.5.4) and `@types/qrcode`
into `packages/frontend`'s dependencies — the shell's only reason to hold that library.

`configurations` already owns remote mode: the app persists `remote: true` to
`config/settings.json` and holds `yaar://config/`.

### The blocker that actually matters

`/api/remote-info` is in `HOST_ONLY` because its response contains **the remote token** — the
credential that grants full access to YAAR from anywhere on the network. Moving the QR app-side
means an app can read that token.

A tempting mitigation is to have the server render the QR to a data URL, so the app receives an
opaque image rather than the token string. **This is theatre and should not be built.** The app
renders the image; the token is in the pixels; decoding a QR you were handed is not a barrier. If
the app can display it, the app has it.

So the honest version:

- Add `read('yaar://system/remote')` returning what `/api/remote-info` returns.
- Add a `PERMISSION_DESCRIPTIONS` row in `features/apps/capabilities.ts`:
  `{ match: 'yaar://system/remote', icon: '📡', title: 'Read the remote access token', detail: 'Full network access to this YAAR', warn: true }`
- `configurations` declares it. Because it is `kind: "system"` and bundled, it is granted by
  shipping in the release; a user-installed app asking for this gets a flagged row, which is the
  correct outcome.
- Add `qrcode` to `BUNDLED_LIBRARIES` (`packages/compiler/src/bundled/registry.ts`). It is ~30 KB
  — three orders of magnitude under `mermaid`'s 3.3 MB, and generally useful.
- Drop `qrcode` and `@types/qrcode` from `packages/frontend/package.json`.

`/api/remote-info` stays host-only for the shell's own use. The verb is the app door, and it is a
door with a label on it — which is strictly better than today, where the token is reachable only
by code nobody audits as a grant.

---

## Sequencing

Independent of one another; this order is cheapest-first and lets each land on `dev` alone.

1. **Skills topics.** No security surface, no UI. Proves the "app owns its own docs" pattern.
2. **Session-logs.** Deletion first (safe — the code is unreachable), then the restore verb, then
   the app UI. Three commits, each shippable.
3. **Remote QR.** Do last: it is the only one that adds a permission, and it should land when
   there is attention to spare for reviewing the capability row.

## What this buys

- ~630 lines of frontend deleted, one npm dependency dropped, one dead component removed.
- Three capabilities become agent-addressable that are not today. `restore` is the notable one:
  "bring back yesterday's desktop" is a thing a user would plainly ask the AI for, and it is
  currently impossible at any price.
- Two skill topics stop shipping for apps that may not be installed.
- The split rule gets three worked examples, which is what makes it usable on the next question.

## What Tier 1 deliberately leaves alone

- **The install consent dialog.** `installApp` → `showPermissionDialog` → `saveAppGrant` is the
  chokepoint that makes an app's manifest a *request* rather than a self-grant, and installs are
  triggerable by the agent from anywhere, not only from `market-apps`. What can move is the copy
  (`PERMISSION_DESCRIPTIONS` and friends → `@yaar/shared`) and a *pre*-install review screen in
  the market, so the host dialog confirms something the user has already seen. The dialog stays.
- **`RecentActionsPanel`, `DebugPanel`, `CliPanel`, `DrawingOverlay`, `DesktopIcons`.** Four of
  the five want a window variant that can cover the desktop; `DebugPanel` additionally wants an
  `events` stream. One primitive unlocks most of them — that is the Tier 2 proposal.
- **`ContentRenderer` / `ComponentRenderer`.** Rendering agent-generated window content is the
  core contract, not a view over it.
- **`ConfirmDialog` / `UserPrompt`.** They answer server-held promises with deadlines. They are
  mechanism.
