# Remote Control — hosted Claude Remote Control

A switch for `yaar://system/remote-control`. Turning it on spawns `claude remote-control`, and
the sessions it starts from claude.ai/code or the Claude mobile app run as a YAAR monitor agent
on **the monitor this window is on** — the window's monitor is what binds it, so open the app
on the monitor the remote user should get.

## Flow

1. `start` — the user gets a permission dialog every time; a denial fails the command.
2. The state goes `starting` → `ready` once the CLI prints its link, and the window shows it
   with Open and Copy. The app follows the host live; there is nothing to poll.
3. If it sits in `starting`, the terminal tail shows why — usually a prompt (folder trust on a
   fresh directory). `pressEnter` answers the common case.
4. `stop` ends the host. Shutting YAAR down does too.

## Limits

- One host at a time, across all monitors. A window on another monitor shows the host as
  running elsewhere and can stop it, but cannot start a second one.
- POSIX only.
- The remote session's history is its own: the local monitor agent does not see what the
  remote one did, only the windows it left on the desktop.
