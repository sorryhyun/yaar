# Remote Mode Setup (Tailscale)

Read this when the user wants to open YAAR on their phone, tablet, or another computer.

Remote mode reaches other devices over **Tailscale**, a private network the user's devices join.
Only devices signed into the same Tailscale account can reach YAAR — nothing is exposed to the
public internet. So the setup is always **two installs** (this computer + the other device) plus
a toggle in YAAR.

## How to guide the user

This is a multi-step setup that spans two devices and a web console, so don't dump it as one
wall of text. Open a window with the steps, then check in — the user has to leave YAAR to do
most of this.

- Ask which phone they have (**iPhone** or **Android**) and what this computer runs
  (**macOS**, **Windows**, **Linux**) before writing the steps. Only show the commands that apply.
- Do the **computer** side first and confirm `tailscale status` works before mentioning the phone.
  A phone install is useless until the host is on the tailnet.
- You cannot run shell commands. Give the user the command to paste into their own terminal, and
  ask them to report what it printed.
- `read('yaar://config/settings')` tells you whether remote mode is already on (`remote: true`).
  Check this before walking through anything — the user may only need the QR code.

## Step 1 — Install Tailscale on this computer

| OS | How |
|----|-----|
| macOS | Download from https://tailscale.com/download, or `brew install --cask tailscale` |
| Windows | Download the installer from https://tailscale.com/download |
| Linux | `curl -fsSL https://tailscale.com/install.sh \| sh` |

Then sign in and connect:

```bash
tailscale up
```

This opens a browser to sign in (Google, Microsoft, GitHub, or email). **Remember which account
they used** — the phone must sign into the same one.

Verify:

```bash
tailscale status
```

It should list this machine. If the command isn't found on macOS, the GUI app ships the CLI at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

## Step 2 — Turn on MagicDNS and HTTPS Certificates

YAAR serves itself over HTTPS at a stable name like `https://my-box.tailnet-abc.ts.net`. That
needs two switches in the Tailscale admin console — this is a one-time, per-account step, and
skipping it is the single most common reason the tunnel doesn't come up.

1. Open https://login.tailscale.com/admin/dns
2. Enable **MagicDNS**
3. Enable **HTTPS Certificates**

## Step 3 — Install Tailscale on the phone

1. Install **Tailscale** from the App Store (iOS) or Play Store (Android)
2. Sign in with **the same account** used in Step 1
3. Turn the VPN toggle **on** — iOS/Android will ask to add a VPN configuration; approve it

The phone is now on the same private network as the computer. It keeps normal internet access;
Tailscale only routes traffic to the user's own machines.

## Step 4 — Turn remote mode on in YAAR

Two ways, and they differ in scope:

| How | Scope | Takes effect |
|-----|-------|--------------|
| **Remote Access** toggle in the configurations app | Every run | Next restart |
| `make claude` / `make codex` from a terminal | That one run | Immediately |

You can flip the persistent setting yourself:

```
invoke('yaar://config/settings', { remote: true })
```

**Tell the user it needs a server restart to take effect.** Remote mode is read once at boot, so
the toggle does nothing until YAAR is restarted. An explicit `REMOTE` env var overrides the
setting either way.

## Step 5 — Connect from the phone

After restarting, the terminal running YAAR prints a banner with a connect URL and a QR code:

```
Connect: https://my-box.tailnet-abc.ts.net/#remote=<token>
```

Have the user scan the QR code with the phone's camera, or open that URL on the phone. The token
in the URL logs the browser in and is saved for next time.

**The token is regenerated on every server start.** After a restart, a previously saved
connection stops working and the user has to rescan.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Banner says `Tunnel: none` | Tailscale daemon isn't running or isn't signed in — run `tailscale status`. If the daemon is fine, MagicDNS / HTTPS Certificates are off (Step 2) |
| No banner at all | Remote mode is off, or YAAR wasn't restarted after enabling it (Step 4) |
| The `.ts.net` name won't resolve on the phone | The phone's Tailscale VPN toggle is off, or it's signed into a different account |
| "Server not reachable" | The host machine is asleep, or `tailscaled` isn't running on it |
| "Invalid token" | The server restarted and minted a new token — rescan the QR code. Also check for whitespace if the token was pasted by hand |
| Desktop loads but installed apps don't render | Apps are served from a second port (`:8443`) on the same Tailscale name. Only affects viewers reached through a non-Tailscale tunnel; on the tailnet it should work |

## If the user doesn't want Tailscale

Tailscale is the only tunnel YAAR manages, but it isn't the only way in:

- **Same machine only** — plain local mode already works at `http://127.0.0.1:8000`. No setup.
- **A genuinely public URL** — the user runs their own tunnel against the loopback port, e.g.
  `cloudflared tunnel --url http://localhost:8000`, then enters that URL and the token in YAAR's
  connection dialog. Warn them: a public URL is held shut by nothing but the token, which is much
  weaker than tailnet membership, and installed apps won't render for viewers outside the tailnet.
