# Installing YAAR on Android (Termux)

This guide takes a phone from nothing to a running YAAR: install Termux, install YAAR in it,
log in to Claude, and add the YAAR app. At the end, the phone is both server and client. The
server runs in Termux, and the desktop opens on the same phone at `http://localhost:8000`.
Only the Claude provider is supported.

How those pieces fit together (the two apps, the launcher, why Claude Code is unpacked) is
[YAAR on Android](../installations/android.md). This page covers only what you do.

> **Want to use YAAR on your phone while it runs on a PC?** That is
> [remote mode](./remote_mode.md), not this page.

## What you need

- An **arm64 Android phone**. Termux runs on Android 7 and later. The YAAR app needs
  Android 10 (API 29) or later, and without it the desktop opens in Chrome.
- **Several GB of free storage.** YAAR installs its full dependency tree, and the Claude
  Code download alone is about 220 MB.
- A **Claude account** that Claude Code can log in to.
- **Chrome** is recommended but optional. Without the YAAR app, the desktop opens there
  ([why Chrome](#why-chrome-and-not-the-default-browser)).

---

## Step 1: Install Termux

Termux comes from three places. The builds are signed with different keys, so they do not
update each other and their add-ons (Termux:API, Termux:Widget) do not mix. **Get Termux and
every add-on from the same source.**

| Source | Where | With YAAR |
|---|---|---|
| **F-Droid** (recommended) | [f-droid.org/packages/com.termux](https://f-droid.org/packages/com.termux/). Use the F-Droid app, or download the APK from that page | Everything works. The YAAR app can start the server itself, and install.sh can hand the app to Android's installer directly |
| **GitHub** | [github.com/termux/termux-app/releases](https://github.com/termux/termux-app/releases). Take the `arm64-v8a` APK | Same as F-Droid |
| **Google Play** | Search for "Termux" | Works, with two manual steps: you start the server yourself by running `yaar`, and the YAAR app downloads through Chrome |

An F-Droid or GitHub APK is a file you install yourself. The first time, Android asks you to
allow your browser (or the F-Droid app) to install apps. Allow it, then tap **Install**.

Open Termux once and wait for its first-run setup to finish, until the `$` prompt appears.
Then bring its packages up to date:

```bash
pkg update && pkg upgrade -y
```

If `pkg` is slow or cannot reach its mirror, `termux-change-repo` picks another one.

---

## Step 2: Install YAAR

In Termux:

```bash
curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
```

There is no Android release binary, so on Termux the installer builds from source. It takes a
few minutes, mostly for the Claude Code download:

1. Installs any missing `git`, `make`, `curl` or `unzip` with `pkg`.
2. Installs Bun's Android build to `~/.bun/bin`.
3. Clones the release tag to `~/yaar` and runs `bun install`.
4. Downloads **Claude Code** and unpacks it for Android, into `~/.cache/yaar/`. This is the
   big download (about 220 MB).
5. Installs **yt-dlp** with `pkg`, for YouTube audio download. If that fails, the install
   continues without it.
6. Installs **poppler** with `pkg`, for PDFs. Chrome on Android cannot show a PDF inside a
   window, so YAAR draws the pages itself. If that fails, the install continues, and a PDF
   window tells you to run `pkg install poppler`.
7. Installs **Chromium** (`x11-repo`, then `chromium`), for the
   [companion desktop](#chromium-page-reads-while-youre-in-another-app) and the Browser app.
   This is the other large download. If it fails, the install continues without it.
8. Adds the `yaar` command, and a home-screen shortcut in `~/.shortcuts/YAAR`
   ([Termux:Widget](#termuxwidget-a-home-screen-button)).
9. Offers the **YAAR app**. See [Step 4](#step-4-install-the-yaar-app).

Options go in front of `bash`, e.g. `curl -fsSL … | VERSION=v0.20.4 bash`:

| Option | Default | Meaning |
|---|---|---|
| `VERSION` | latest | Release tag to check out |
| `YAAR_DIR` | `~/yaar` | Where the source checkout goes |
| `INSTALL_DIR` | `$PREFIX/bin` | Where the `yaar` command goes |
| `YAAR_SKIP_CLAUDE` | off | `1` leaves the Claude Code download to the first `yaar` run |
| `YAAR_SKIP_YTDLP` | off | `1` skips installing yt-dlp |
| `YAAR_SKIP_CHROMIUM` | off | `1` skips installing Chromium |
| `YAAR_SKIP_APK` | off | `1` skips offering the YAAR app |

---

## Step 3: First run and Claude login

```bash
yaar
```

The first time, Claude is not logged in yet, so `yaar` starts `claude auth login` in the
terminal. Open the URL it prints, approve, and paste the code back into Termux. This has to be
the full login. `CLAUDE_CODE_OAUTH_TOKEN` (a `setup-token` token) also works for chat, but it
is inference-only, so [Claude Remote](./claude_remote.md) refuses it. The launcher tells you
when you are using one.

Once the server answers, the desktop opens: in the YAAR app if it is installed, otherwise in
Chrome. Starting with "install essential apps" is a good first message.

Leave the Termux session open. Closing it stops YAAR.

---

## Step 4: Install the YAAR app

The YAAR app is the desktop's own window. It is a full-screen app instead of a Chrome tab. It
saves into `Download/YAAR/`, reads the clipboard directly, and can start the server when it is
not running. [What it does](../installations/android.md#what-the-window-does-that-a-browser-tab-doesnt).

install.sh (Step 2) offers it when the release has one and the app is missing or older.
Android installs an app only when you tap Install, and the way to that screen depends on your
Termux:

- **F-Droid or GitHub Termux**: install.sh downloads the APK, checks it against
  `SHA256SUMS`, and opens Android's installer. If Android asks which app to use, pick
  **Package installer**. The first time, allow Termux to install apps. Then tap **Install**.
- **Google Play Termux**: this Termux is not allowed to install apps, so the APK opens in
  Chrome. Tap **Download anyway** at Chrome's warning, open the download, allow Chrome to
  install apps the first time, and tap **Install**.

Missed it? Run the install one-liner again. Termux can't always see whether the app is
installed, and when it can't, each version is offered only once. To be offered it again,
delete `~/.cache/yaar/android-apk-offered` first.

Skipping the app changes nothing else. The desktop opens in Chrome, and you can
[install it from Chrome](#no-yaar-app-install-it-from-chrome) instead.

### Let the app start the server (F-Droid or GitHub Termux)

With these two one-time grants, tapping YAAR starts the server when it is not running, so you
never have to open Termux. The same goes for a server that stops while the app is open, or
while it is in the background: the app notices within a few seconds of being in front, and
starts it again.

1. Let Termux accept commands from other apps:

   ```bash
   echo 'allow-external-apps = true' >> ~/.termux/termux.properties
   termux-reload-settings
   ```

2. Open the YAAR app while the server is stopped. When Android asks
   "Allow YAAR to run commands in Termux?", tap **Allow**.

With the **Google Play Termux**, this is not possible: that build cannot run commands for
other apps. The app's waiting screen says "run `yaar` in Termux" and has an **Open Termux**
button. Run `yaar`, and the app picks the server up within a second.

---

## Step 5: Stop Android from killing YAAR (Android 12 and later)

Android 12 and later kill background child processes of apps ("phantom processes") without
warning. Under Termux, that means the YAAR server, every agent's Claude process, and the
companion Chromium. It happens most when you switch to another app while an agent is working.

While these restrictions are on, YAAR limits each session to 2 monitors, and the
**Configurations** app shows a warning in its Android section. To turn them off:

- **Android 14 and later**: enable Developer options (Settings → About phone → tap
  **Build number** seven times). Then go to Settings → Developer options and turn on
  **Disable child process restrictions**.
- **Android 12 and 13**: there is no toggle. It takes `adb` from a computer, see
  [Termux's instructions](https://github.com/termux/termux-app/issues/2366).

Also exempt Termux from battery optimization: Settings → Apps → Termux → Battery →
**Unrestricted**. On Galaxy phones, also keep Termux out of "Sleeping apps".

---

## Optional add-ons

YAAR works without any of these. Termux:Widget and Termux:API are separate apps. Install them
from the same source as Termux.

### Termux:Widget: a home-screen button

Install Termux:Widget, add its widget to the home screen, and pick **YAAR**. Tapping it starts
YAAR, or brings back the desktop if YAAR is already running. With the YAAR app, you can use
the app's own icon instead.

### Termux:API: notifications, clipboard, share sheet

```bash
pkg install termux-api   # plus the Termux:API app
```

With both installed, YAAR uses the phone itself:

- **Native notifications.** While you are not looking at the desktop, agent notifications,
  permission dialogs, questions, and finished monitor turns show up in the Android
  notification shade. Tapping one opens the desktop, and they are all cleared when you come
  back. This matters most for permission dialogs, which have a deadline: one you never see
  counts as a denial.
- **Clipboard.** Text reads and writes use the phone's real clipboard, without the browser's
  focus rule. Images still go through the browser.
- **Share sheet.** Storage files gain a `share` action that opens Android's share sheet.

You need both the package **and** the app. If only one is installed, YAAR notices at startup
and leaves the integration off. `YAAR_TERMUX_API=0` turns it off on purpose.

### Phone storage: your downloads, photos and documents

YAAR starts out seeing only Termux's own folder. To work with files from the rest of the phone,
ask YAAR for one (for example, "open the PDF in my downloads"). It walks you through running
`termux-setup-storage` in Termux once, then mounts only the folders you need, each behind an
approval dialog. Photos are mounted read-only unless you say otherwise.

### Chromium: page reads while you're in another app

install.sh installs this one for you (Step 2), unless you set `YAAR_SKIP_CHROMIUM=1` or the
install failed.

When you switch apps, Android freezes the desktop, and agents can no longer read from it. The
one that matters is taking screenshots: an agent building an app can no longer see what it
built. A Termux Chromium lets the server keep a hidden
[companion desktop](../installations/android.md#the-companion-desktop) that keeps answering.
The Browser app uses the same Chromium. To install it by hand:

```bash
pkg install x11-repo
pkg install chromium
```

YAAR finds it on the next start. It costs memory (a Chromium process, plus a second copy of
each open app window). `YAAR_COMPANION_TAB=0` turns the companion off.

### No YAAR app: install it from Chrome

Without the YAAR app, open the desktop in Chrome and use **Install app** (or
**Add to Home screen → Install**). The installed desktop opens full-screen, and `yaar`,
Termux:Widget and notification taps then open it rather than a Chrome tab. It has to be
**installed**. A plain home-screen *shortcut* still opens in a Chrome tab.

If its cached page ever misbehaves, open `http://localhost:8000/?nosw` once to clear it.

### Why Chrome and not the default browser

On a Galaxy phone the default browser is Samsung Internet, which warns "can't be downloaded
securely" on every plain-http download, `localhost` included. Chrome treats `localhost` as
secure and does not warn. To use another browser, set `YAAR_TERMUX_BROWSER` to its package
name (empty means the default browser):

```bash
YAAR_TERMUX_BROWSER=org.mozilla.firefox yaar
```

The YAAR app and an installed Chrome app still come first.

---

## Day to day

| To… | Do this |
|---|---|
| Start YAAR | Tap the YAAR app, run `yaar` in Termux, or tap the Termux:Widget button |
| Bring the desktop back | Same as starting: when YAAR is already running, it opens the running desktop |
| Close the desktop only | Swipe the YAAR app (or Chrome) away. The server keeps running in Termux |
| Stop YAAR | `Ctrl-C` in the Termux session running it, or close that session. The server stops within a few seconds |
| Update | Run the install one-liner again. The next `yaar` reinstalls dependencies and, if needed, a newer Claude Code |

While YAAR runs, Termux shows a persistent **wake-lock** notification. That is what keeps the
server alive with the screen off, and it goes away when YAAR stops.

Only one YAAR runs per phone. A second `yaar` opens the first one's desktop and exits.

## Uninstalling

```bash
rm -rf ~/yaar ~/.cache/yaar ~/.shortcuts/YAAR $PREFIX/bin/yaar
rm -rf ~/.bun   # Bun, unless something else uses it
```

Remove the YAAR app like any other app (Settings → Apps → YAAR → Uninstall). `Download/YAAR/`,
where the desktop saved your files, is left alone. Your Claude login is in `~/.claude/`, which
the Claude CLI shares, so remove it only if nothing else uses it.

---

## Troubleshooting

**`bun does not run here`.** The installed Bun is not the Android build. Download
`bun-linux-aarch64-android.zip` from the [Bun releases](https://github.com/oven-sh/bun/releases)
and put its `bun` in `~/.bun/bin`.

**`Claude is not logged in` and `yaar` exits.** It was started without a terminal (from the
YAAR app, a widget, or a script). Run `yaar` once in a Termux session to log in.

**Every turn fails right after an update.** Start YAAR through `yaar`, not the server
directly. `yaar` is what reinstalls dependencies and unpacks a newer Claude Code.

**`Ignoring CLAUDE_CODE_PATH=…`.** Your shell profile points `CLAUDE_CODE_PATH` at a Claude
Code older than the one YAAR needs, so YAAR uses its own instead. Unset the variable to drop
the note.

**YAAR stops by itself, or stops with the screen off.** Android is killing it. Do
[Step 5](#step-5-stop-android-from-killing-yaar-android-12-and-later), check that the Termux
wake-lock notification is showing, and exempt Termux from battery optimization.

**The YAAR app says "Starting YAAR in Termux…" and nothing happens.** Termux refused the
command. Add `allow-external-apps = true`
([Step 4](#let-the-app-start-the-server-f-droid-or-github-termux)). Otherwise, open Termux:
the new session there shows what `yaar` is doing.

**The YAAR app says "Open Termux and run `yaar`".** This is the Google Play Termux, which
cannot start the server for another app. Run `yaar` in it.

**The YAAR app says Termux is not installed.** Install Termux ([Step 1](#step-1-install-termux)),
then YAAR in it.

**The installer screen never appeared.** Allow Termux (or, with the Play Termux, Chrome) to
install apps under Settings → Apps → Special access → Install unknown apps. Then delete
`~/.cache/yaar/android-apk-offered` and run the install one-liner again.

**"App not installed", or the package conflicts.** A YAAR app signed with another key is
installed, usually a build of your own. Uninstall YAAR, then install the release.

**`yaar` opens Chrome, not the YAAR app.** Your checkout is older than the app. Run the
install one-liner again.

**A toast says the WebView is too old.** Update **Android System WebView** from the Play Store.
Until then, the app saves and copies the way Chrome does.

**An app's Save or Export does nothing, or "Couldn't save this download (blob:)".** That app
was compiled with an older SDK. YAAR recompiles such apps when the server starts, so restart
YAAR. If it persists, ask the agent to recompile the app.

**The desktop opens in a Chrome tab even though you installed it from Chrome.** Check what
Android reports for the desktop URL:

```bash
/system/bin/cmd package query-activities --brief -a android.intent.action.VIEW -d http://localhost:8000/
```

A line with `org.chromium.webapk.…` means the app is found. No such line means it was added
as a shortcut rather than installed: remove it and use **Install app**.

**Screenshots or other page reads time out while you're in another app.** The companion
desktop is not running. [Install Chromium](#chromium-page-reads-while-youre-in-another-app),
and check that `YAAR_COMPANION_TAB` is not set to `0`.

## Related

- [YAAR on Android](../installations/android.md): how the pieces fit together, and building
  the YAAR app
- [`docs/reference/server_env.md`](../reference/server_env.md): `YAAR_TERMUX_API`,
  `YAAR_TERMUX_BROWSER`, `YAAR_COMPANION_TAB`, and why each one defaults the way it does on
  Android
