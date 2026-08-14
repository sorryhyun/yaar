---
name: headless-driving
description: Launching and driving YAAR headlessly from an agent - browser automation against localhost:8000. Use when asked to run YAAR, verify a change live, or drive it from another Claude session.
---

# Driving YAAR Headlessly

YAAR can be launched and driven by an external agent, including from inside another Claude Code
session. Drive it **like a user, through the browser** — never through YAAR's own internal
plumbing.

## Launch

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # required if not already logged in
export CLAUDE_CODE_PATH=/path/to/claude           # optional, only if claude isn't in ~/.local/bin or PATH
make claude-dev                                   # PROVIDER=claude, MCP_SKIP_AUTH=1, port 8000
# ready when you see "YAAR server running at http://..."
```

This is Claude-in-Claude: the outer session launches YAAR, which spawns its own `claude`
subprocess per prompt. `buildClaudeEnv` in `packages/server/src/config/providers/claude.ts` scrubs
nested-Claude env vars before that inner spawn — without it the inner `claude` inherits the
outer's FD-based auth and exits immediately with code 1.

## Drive through the browser, not internal routes

Point Chromium at `http://127.0.0.1:8000`. Internal HTTP routes (`/api/*`) and WebSocket frames
(`USER_MESSAGE` etc.) are YAAR's own plumbing — **not** the supported entry point for outside
automation.

```
1. Wait for the desktop to render (command palette textarea at the bottom)
2. Click/focus the textarea — it's the only <textarea> on the page
3. Type the prompt
4. Enter to submit (Shift+Enter inserts a newline instead)
5. Shift+Tab toggles the CLI panel — watch the agent stream + tool calls live
```

## Hard rules

- **Never** drive YAAR through YAAR's own Browser app — that nests YAAR inside YAAR: recursive
  rendering, duplicate-element selectors. Use a separate Chromium instance you control.
- Internal HTTP/WS frames are not a supported automation surface — always go through the UI.
- **Screenshot before each action** — the AI may have moved or added windows since your last
  view.

## Watching / verifying

`Shift+Tab` opens the CLI panel live. For shell-side tailing:

```bash
tail -f session_logs/$(ls -t session_logs | head -1)/*.jsonl
```

Per repo-wide guidance: verify a fix in one run — don't repeatedly relaunch/kill the dev server.

Full walkthrough (minimal `claude-in-chrome` MCP example, caveats, stacking details):
`docs/guides/headless_driving.md`.
