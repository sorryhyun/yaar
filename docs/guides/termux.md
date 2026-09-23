# YAAR on Android (Termux)

YAAR runs on an Android phone under [Termux](https://termux.dev/), with the phone acting as
both server and client: the server runs in Termux, and the desktop opens in the phone's own
browser at `http://localhost:8000`. Only the Claude provider is supported.

> **Want to use YAAR on your phone while it runs on a PC?** That is
> [remote mode](./remote_mode.md), not this page.

## Install

Install Termux, then run this in it:

```bash
curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
yaar
```

There is no Android release binary, so on Termux the installer builds from source instead:

1. Installs any missing `git`, `make`, `curl` or `unzip` with `pkg`.
2. Installs **Bun's Android build** (`bun-linux-aarch64-android`) to `~/.bun/bin`. The build
   the bun.sh installer picks does not run on Android.
3. Clones the release tag to `~/yaar` and runs `bun install`.
4. Fetches **Claude Code** and unpacks it for Android — about 220 MB, and the one big
   download. It lands in `~/.cache/yaar/claude-js/<sdk-version>-<arch>/`.
5. Puts a `yaar` launcher in `$PREFIX/bin` (it runs `make termux` in `~/yaar`), and a
   home-screen shortcut in `~/.shortcuts/YAAR`.

| Option | Default | Meaning |
|---|---|---|
| `VERSION` | latest | Release tag to check out |
| `YAAR_DIR` | `~/yaar` | Where the source checkout goes |
| `INSTALL_DIR` | `$PREFIX/bin` | Where the `yaar` launcher goes |
| `YAAR_SKIP_CLAUDE` | off | `1` leaves the Claude Code download to the first `yaar` run |

Pass them in front of `bash`, e.g. `curl -fsSL … | VERSION=v0.20.4 bash`.

### Why Claude Code has to be unpacked

The Agent SDK ships `claude` as glibc and musl executables, and Android's linker refuses
both (`unexpected e_type: 2`). Those executables are Bun single-file builds, though, and
the JavaScript inside is stored as source next to its bytecode.
`scripts/dev/unbun-claude.ts` extracts that module graph into a plain directory, and a small
`claude` wrapper runs its `cli.js` on the Android Bun. `CLAUDE_CODE_PATH` points at the
wrapper. The result is cached per SDK version, so it runs again only when the SDK is bumped.

## First run

```bash
yaar
```

If Claude is not logged in, the launcher starts `claude auth login` in the terminal: open
the URL it prints, approve, and paste the code back. This has to be the full login.
`CLAUDE_CODE_OAUTH_TOKEN` (a `setup-token` token) also works for chat, but it is
inference-only, so the CLI refuses [Claude Remote](./claude_remote.md) with it, and the
launcher tells you so.

Once the server answers, the desktop opens in the installed YAAR app if there is one
(see [Install it as an app](#install-it-as-an-app)), otherwise in **Chrome** if it is
installed, and in the default browser if not. Starting with "install essential apps" is a
good first message.

### Why Chrome and not the default browser

On a Galaxy phone the default browser is Samsung Internet, which warns "can't be downloaded
securely" on every plain-http download, `localhost` included. Chrome counts loopback as
secure and does not warn. To use another browser, set `YAAR_TERMUX_BROWSER` to its package
name (empty means the default browser):

```bash
YAAR_TERMUX_BROWSER=org.mozilla.firefox yaar
```

The installed app, when there is one, still comes first.

### Install it as an app

In Chrome, use **Install app** (or **Add to Home screen → Install**). An installed YAAR
opens full-screen, and a service worker caches the shell, so reopening it after Android has
discarded the tab loads immediately while the server is still waking up.

Once it is installed, `yaar`, the home-screen button, and taps on native notifications all
open **the app** rather than a Chrome tab. The launcher finds it by asking Android which
apps handle `http://localhost:8000/`: Chrome's installed apps are WebAPKs
(`org.chromium.webapk.*`) that claim their site's URL. Two cases are not found and open in
Chrome as before: a plain home-screen *shortcut* (Chrome offers one when it cannot install
a WebAPK), and a `PORT` other than the one the app was installed on.

If the cached shell ever misbehaves, opening `http://localhost:8000/?nosw` unregisters the
worker and clears its caches.

## Day to day

| To… | Do this |
|---|---|
| Start YAAR | `yaar`, or tap the home-screen button (below) |
| Bring the desktop back | Run `yaar` again, or tap the button again: a second launch opens the running desktop and exits |
| Stop YAAR | `Ctrl-C` in the Termux session running it |
| Update | Re-run the install one-liner (it moves `~/yaar` to the new tag). The next launch notices the changed `bun.lock`, reinstalls, and unpacks a newer Claude Code if the SDK moved |

**One YAAR per phone.** The launcher writes `$TMPDIR/yaar-termux.pid`, so a second `yaar`
does not start a second server. It opens the first server's desktop and exits.

**The wake lock.** While the server runs, the launcher holds `termux-wake-lock`, so Android
does not put Termux to sleep with the screen off. Termux shows this as a persistent
notification. It is released when the server exits. On phones with aggressive battery
management it can also help to exempt Termux from battery optimization in Android's
settings.

**No file watcher.** `make termux` runs the server without `bun --watch`, so a `git pull`
under a running YAAR does not restart it and drop every agent. `NO_WATCH=0 yaar` turns
watching back on if you are editing the server on the phone.

## Optional add-ons

YAAR works without any of these. Termux:Widget and Termux:API are separate apps: install them
from the same store you got Termux from.

### Termux:Widget: a home-screen button

The installer writes `~/.shortcuts/YAAR`. Install Termux:Widget, add its widget to the home
screen, and pick **YAAR**. Tapping it starts YAAR, or brings back the desktop if YAAR is
already running.

### Termux:API: notifications, clipboard, share sheet

```bash
pkg install termux-api   # plus the Termux:API app
```

With both installed, the server uses the phone itself:

- **Native notifications.** While you are not looking at the desktop, agent notifications,
  permission dialogs, questions, and finished monitor turns show up in the Android
  notification shade. Tapping one opens the desktop (in the installed app, if there is
  one), and they are all cleared when you come back. This matters most for permission dialogs, which have a deadline: one you never
  see counts as a denial.
- **Clipboard.** Text reads and writes use the phone's real clipboard, without the browser's
  focus rule. Images still go through the browser.
- **Share sheet.** Storage files gain a `share` action that opens Android's share sheet.

You need both the package **and** the app. With only the package, every `termux-*` command
hangs instead of failing. So the server makes one test call at startup and turns the
integration on only if it answers in time. If you don't install it, the launcher prints a
one-line tip and nothing else changes. `YAAR_TERMUX_API=0` turns it off.

### Chromium: page reads while you're in another app

When you switch apps, Android hides YAAR's tab and then freezes it. After that, anything the
agent reads out of the page stops answering. The one that hurts is `__screenshot`: an agent
building an app can no longer see what it built.

To keep those reads working, the server parks a **companion desktop**: a second,
always-visible desktop in its own headless Chromium, running inside Termux and so on the
server's side of the freeze. It is on by default on Android and needs a Termux Chromium
(`chromium-browser` on `PATH`). YAAR already passes the `--browser-subprocess-path` flag that
Chromium needs to start its child processes under Termux.

The companion costs a Chromium process and a second live iframe per open app window.
`YAAR_COMPANION_TAB=0` turns it off. Details:
[`server_env.md` → Companion desktop](../reference/server_env.md#companion-desktop).

## What differs from a desktop install

| | Desktop | `make termux` |
|---|---|---|
| Providers | Claude, Codex | Claude only |
| Remote mode | `REMOTE=1` / settings toggle | Always off: the launcher pins `REMOTE=0`, even over a `REMOTE=1` in your shell profile |
| MCP auth | On (except `*-dev` targets) | Skipped (`MCP_SKIP_AUTH=1`) |
| React build | Development (dev server) | Production. The dev build doubled render cost on the phone shell (`YAAR_REACT_PROD`) |
| Companion desktop | Off | On |
| Layout | Desktop | The phone shell, chosen by the browser's own media query (coarse pointer, narrow window) |

## Troubleshooting

**`bun does not run here`.** The installed Bun is not the Android build. Download
`bun-linux-aarch64-android.zip` from the [Bun releases](https://github.com/oven-sh/bun/releases)
and put its `bun` in `~/.bun/bin`.

**`Ignoring CLAUDE_CODE_PATH=…`.** Your shell profile points `CLAUDE_CODE_PATH` at a Claude
Code older than the one the SDK was built against. An older CLI fails every turn with a bare
400 as soon as it is asked for a model it does not know, so the launcher uses the unpacked
build instead. Unset the variable to drop the note.

**Every turn fails right after an update.** Launch through `yaar` / `make termux`, not the
server directly. The launcher is what reinstalls dependencies when `bun.lock` has moved and
re-unpacks Claude Code for a new SDK.

**`Claude is not logged in` and the launcher exits.** It was started without a terminal
(from a widget or a script). Run `yaar` once from a Termux session to log in.

**YAAR stops with the screen off.** Check that the Termux wake-lock notification is showing,
and exempt Termux from battery optimization.

**The desktop opens in a Chrome tab even though the app is installed.** Check what Android
reports for the desktop URL:

```bash
/system/bin/cmd package query-activities --brief -a android.intent.action.VIEW -d http://localhost:8000/
```

An `org.chromium.webapk.…` line means the app is found. No such line means it was added as
a shortcut rather than installed: remove it and use **Install app**. An error means this
phone does not let Termux query the package manager, and the launcher falls back to Chrome.

**Screenshots or other page reads time out while you're in another app.** The companion
desktop is not running. Install Chromium in Termux, and check that `YAAR_COMPANION_TAB` is
not set to `0`.

## Related

- [`docs/reference/server_env.md`](../reference/server_env.md): `YAAR_TERMUX_API`,
  `YAAR_TERMUX_BROWSER`, `YAAR_COMPANION_TAB`, `YAAR_REACT_PROD`, and why each one defaults
  the way it does on Android
- `scripts/dev/start-termux.sh`: the launcher; every step above is commented there
- `scripts/dev/termux-open-desktop.sh`: installed app → Chrome → default browser
- `scripts/dev/ensure-claude-android.sh`, `scripts/dev/unbun-claude.ts`: Claude Code for Android
- `packages/server/src/features/android/`, `packages/lib/src/termux/`: the Termux:API integration
- `make mobile-bench`: phone-shell performance with a mock agent, set up the way Termux runs
  (companion on, production React)
