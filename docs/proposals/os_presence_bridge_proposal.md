# Proposal: OS Presence Bridge — Observing the User's Real Browser Without Touching It

YAAR's agents and apps are blind to what the user is doing in their *everyday* browser. The user
watches YouTube in their real, logged-in Chrome; YAAR — one tab over — has no idea. This proposal
adds the cheapest possible awareness: a **read-only presence feed** built entirely from signals the
OS already exposes, requiring **zero browser setup** — no extension, no relaunch, no debug flag, no
new profile.

> Companion doc: [`extension_bridge_proposal.md`](./extension_bridge_proposal.md) is the *rich* tier
> (in-page events, tab management, eventual actuation) via a companion extension. The two proposals
> share one URI surface (`yaar://browser/*`); this one is the floor, that one is the ceiling.
> Parents: [`browser_substrate_proposal.md`](./browser_substrate_proposal.md) (mechanism),
> [`session_agent_browser_design.md`](./session_agent_browser_design.md) (principals).

---

## 1. Why a third way is needed at all

The two existing channels into a browser both fail to reach the user's *existing, already-running,
default-profile* Chrome:

| Channel | Why it can't reach the everyday browser |
|---------|------------------------------------------|
| CDP (`LocalUserBrowser`, `yaar://session/browser`) | Requires `--remote-debugging-port` at launch (no post-launch enable), **and** since Chrome 136 the flag is ignored on the default user data dir. What CDP can legally attach to is a relaunched, *separate-profile* Chrome — not the browser the user lives in. |
| Companion extension | Reaches the real browser, but is a new component the user must install, and a bigger build (see companion proposal). |

And the tempting fourth door — "we know the PID, connect to it" — is architecturally shut on
purpose: enabling a debug endpoint on a running Chrome is not possible, and process-level attach
(ptrace / memory injection) is the malware playbook, actively blocked by Yama `ptrace_scope` and
Chrome's sandbox. **There is no legitimate channel *into* a running default-profile Chrome.**

The reframe: stop trying to get *into* the browser. Chrome already leaks presence-level state
*outward* through ordinary OS channels. Observe those.

## 2. The signals (verified on a live dev machine)

### 2a. MPRIS media sessions (D-Bus) — the flagship signal

A running Chrome with any media session registers on the D-Bus session bus:

```
org.mpris.MediaPlayer2.chromium.instance24616   ← PID embedded in the bus name
```

While media plays, `org.mpris.MediaPlayer2.Player` exposes:

- `Metadata` — `xesam:title` (video title), `xesam:artist` (channel), `mpris:artUrl` (thumbnail)
- `PlaybackStatus` — `Playing` / `Paused` / `Stopped`
- `PropertiesChanged` D-Bus signals — **push, not polling**

This alone answers the motivating scenario ("app knows what YouTube video I'm watching, and whether
it's paused") in ~50 lines of D-Bus subscription code. The PID in the bus name maps to the process
(`/proc/{pid}/cmdline`) and thence to the profile dir — PID tracking as *discovery*, not ownership;
no pid-file needed because we never own or launch the process.

### 2b. Session files on disk — the tab list

- `~/.config/google-chrome/{Profile}/Sessions/Tabs_*` / `Session_*` — SNSS-format records of all
  open tabs and their URLs. Parseable (format is stable and well-documented by third parties).
- `~/.config/google-chrome/{Profile}/History` — SQLite of visited URLs. Locked while Chrome runs;
  the standard copy-then-query trick works and gives near-live "recently visited."

### 2c. Window titles — the active tab

The window manager exposes Chrome's window title, which is the active tab's title
(`"Video Name - YouTube - Google Chrome"`). Cheap corroboration of which tab is *focused*, which
neither 2a nor 2b provides.

### Signal ceiling — stated honestly

This tier is **read-only and coarse**. It can say *"user is watching Video X, currently paused, and
has 14 tabs open including two GitHub PRs."* It can **never** see an in-page event ("like was
pressed") and can **never** act. That is not a flaw to fix here — it is the boundary that makes this
tier safe enough to ship with zero browser-side setup. The rich tier is the extension's job.

## 3. Architecture

A server-side feature (not a sandboxed app — this is platform glue: D-Bus, `/proc`, profile dirs):

```
features/browser/presence.ts
  ├── MprisWatcher      (D-Bus subscribe → media state, per Chrome instance/PID)
  ├── SessionFileReader (SNSS parse + History copy-query, debounced on file mtime)
  └── ActiveWindowProbe (WM title poll or event, platform-specific)
         │
         ▼  merged into one presence model
  yaar://browser/presence          (read)  — { media, activeTab, tabCount, browsers[] }
  yaar://browser/presence/media    (read)  — just the MPRIS state (cheapest, most useful)
  yaar://browser/presence/tabs     (read)  — session-file tab list (title+URL)
         │
         ▼  change detection
  subscriptionRegistry (http/subscriptions.ts) → verb-subscription events → apps re-read
```

- **Delivery reuses existing plumbing unchanged.** Apps `subscribe()` to a `yaar://browser/presence*`
  URI exactly as they subscribe to windows today; `MprisWatcher` calls the registry's notify path on
  `PropertiesChanged`, file watchers on session-file writes. No new event machinery.
- **Registered in `handlers/`** like every other resource (a thin `handlers/browser-presence.ts`
  importing from `features/browser/presence.ts`), so agents reach it via the 5 verbs and apps via
  `POST /api/verb`.

### 3a. Access model — extraction, not exception

[`session_agent_browser_design.md`](./session_agent_browser_design.md) Q3 established the rule:
*"widen it by extraction, never by exception."* This namespace is that rule applied. We do **not**
open `yaar://session/browser` to lower tiers; we mint a **separate, read-only** namespace,
`yaar://browser/presence*`, with its own (weaker) gate:

| Caller | Access |
|--------|--------|
| Session agent | ✅ (trivially — it can already do more) |
| Monitor agents | ✅ read/list |
| Apps via `/api/verb` | ✅ read/list **iff declared in `app.json` `permissions`** (existing default-deny) — plus a per-app user consent grant on first use (§4) |
| Anyone, any verb that mutates | ❌ nothing to mutate; the namespace is read-only by construction |

`yaar://session/browser` remains session-principal-only and untouched.

### 3b. Platform scope

Linux-first (D-Bus/MPRIS, `~/.config/google-chrome`, X11/Wayland title). The equivalents exist
elsewhere and slot behind the same `presence.ts` interface later:

- **Windows** — `GlobalSystemMediaTransportControlsSessionManager` (SMTC) for media; same session
  files under `%LOCALAPPDATA%`.
- **macOS** — Now Playing (`MRMediaRemote`, semi-private) or the accessibility API; same session
  files under `~/Library/Application Support`.

Chromium-family browsers (Chrome, Brave, Edge, Chromium) all emit MPRIS and use SNSS; Firefox emits
MPRIS too, so 2a generalizes beyond Chrome for free.

## 4. Privacy — the real cost of this proposal

The signals are "just" presence, but presence is sensitive: **URLs and titles alone profile a
person.** Reading `Sessions/` and `History` is reading the user's browsing record. Mitigations are
part of v1, not deferred (the lesson of the substrate proposal's phase-4 consent debt):

1. **Per-app grant, origin-scoped.** An app declares `yaar://browser/presence` in `app.json`; first
   read triggers a permission dialog (existing permission-dialog flow, persisted in
   `config/permissions.json`). The grant names *what* the app sees ("media playback and open-tab
   titles/URLs").
2. **Origin filtering for apps.** An app's grant can be narrowed to origins (`youtube.com`) —
   presence entries for other origins are elided from that app's reads. Agents (monitor tier) see
   the unfiltered feed; they already operate under broader trust.
3. **A visible indicator** ("presence observed by: {app}") surfaced in the dock/status area whenever
   at least one app holds an active presence subscription.
4. **History is opt-in separately.** `presence/tabs` (current tabs) and `presence/media` ship first;
   the History DB (`recently visited`) is a distinct, scarier grant and its own URI if ever.

## 5. Honest costs

- **SNSS parsing is reverse-engineered.** Stable for years and multiple OSS parsers exist, but it is
  not a contract. Guard with fixture tests; degrade to "tab count unknown" on parse failure, never
  crash the feed.
- **Coarseness will disappoint eventually.** The first user request after shipping will be "can the
  app know when I press like?" The answer is the extension proposal — this feed's URI surface is
  designed so that upgrade changes nothing for apps.
- **Polling residue.** MPRIS is push, but session files and window titles are watch/poll. Debounce
  aggressively; presence does not need sub-second latency.
- **Multi-browser / multi-profile ambiguity.** Several Chromes/profiles may run at once (the
  `pgrep` on the dev machine already shows VS Code's Electron alongside Chrome). `browsers[]` is a
  list keyed by PID+profile, and Electron apps must be filtered out (they register MPRIS too).

## 6. Phasing

1. **`presence/media` (MPRIS only).** `MprisWatcher` + handler + subscription notify + per-app
   grant. Smallest shippable slice; already demo-able ("now playing" app).
2. **`presence/tabs` (session files).** SNSS reader + mtime watcher; origin filtering for apps.
3. **Consent surface.** Permission-dialog text, origin narrowing, the "observed by" indicator.
4. **`presence` (merged view) + active-window probe.**
5. **Cross-platform** (SMTC / macOS) — only if/when YAAR itself targets those hosts seriously.

Each phase independently shippable; phase 1 alone delivers the motivating scenario.

## 7. Files / seams

- `packages/server/src/features/browser/presence.ts` — watchers + merged model (new).
- `packages/server/src/handlers/browser-presence.ts` — URI registration, read/list (new).
- `packages/server/src/http/subscriptions.ts` — reused as-is (notify on change).
- `config/permissions.json` — existing persisted-grant store, reused.
- `apps/*/app.json` — consuming apps declare `yaar://browser/presence` in `permissions`.

## 8. Open questions

1. **Is `yaar://browser/*` the right authority,** given `yaar://session/browser` exists? (Position
   taken here: yes — the substrate docs already treat "session-gated actuation" and "extracted
   read-only observation" as different namespaces by design. But naming deserves one review.)
2. **Should monitor agents get presence pushed into context** (like `HINT.md` / window
   subscriptions) rather than pull-only? A monitor agent that *knows* the user is watching a video
   could be proactive — or annoying. Default to pull; revisit with usage.
3. **Wayland title access** varies by compositor (KWin scripting vs. wlr protocols vs. GNOME shell
   extension). May land as "best effort, null when unavailable."
