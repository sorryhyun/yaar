# Remote Control — the monitor agent on claude.ai

The only way to Claude Remote Control — there is no `yaar://` verb for it. Turning it on
puts **the monitor this window is on** — its agent's conversation — on claude.ai, so the user
can talk to that agent from claude.ai/code or the Claude mobile app. It is not a second agent: a claude.ai message runs as
a turn of the monitor agent, with its tools, timeline and history, and the desktop's own turns
show up on claude.ai too. Open the app on the monitor the user wants to reach.

## Flow

1. `start` — the user gets a permission dialog every time; a denial fails the command. It
   resolves with the `sessionUrl`, which the window shows with Open and Copy.
2. `stop` takes the conversation off claude.ai. Shutting YAAR down or resetting the monitor
   does too.

## Limits

- One monitor at a time. A window on another monitor shows where it is on and can stop it,
  but cannot start a second one.
- Claude provider only.
- A claude.ai page that was open across a restart of the agent's process needs a reload to
  reconnect; the link stays the same.
