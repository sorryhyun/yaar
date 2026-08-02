# Running YAAR Headlessly (Agents Driving YAAR)

YAAR can be launched and driven by an external agent — including from inside another Claude Code
session. The Claude provider spawns the `claude` CLI as a subprocess; the harness scrubs
nested-Claude env vars before the spawn (see
`packages/server/src/providers/claude/session-provider.ts`), so it works inside cloud sandboxes
without IPC clashes.

## Launch (cloud / headless)

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # required if not already logged in
export CLAUDE_CODE_PATH=/path/to/claude           # optional; only if not in ~/.local/bin or PATH
make claude-dev                                   # PROVIDER=claude, MCP_SKIP_AUTH=1, port 8000
# server is ready when you see "[banner] YAAR running at ..."
```

## Drive YAAR like a user — through the browser

YAAR is a desktop UI; an external agent should use it the way a person does, via Chromium and the
command palette. Internal HTTP routes (`/api/*`) and WebSocket frames (`USER_MESSAGE` etc.) are
YAAR's own plumbing — used by the frontend and bundled tools — and are **not** the supported entry
point for outside automation. Driving via the browser exercises the real user surface, makes
failures visible (you can screenshot), and avoids coupling external agents to internal event
schemas that may change.

**Recommended flow** (any CDP client works — Playwright, Puppeteer, the `claude-in-chrome` MCP
tools, or YAAR's own `yaar-web` SDK from inside an app):

```
1. Launch Chromium pointed at http://127.0.0.1:8000
2. Wait for the desktop to render (the command palette textarea appears at the bottom)
3. Click/focus the textarea (it's the only <textarea> on the page)
4. Type your prompt
5. Press Enter to submit (Shift+Enter inserts a newline; Enter sends)
6. Optionally press Shift+Tab to toggle the CLI panel and watch the agent stream
```

Minimal example using the `claude-in-chrome` MCP tools available to an agent:

```
navigate("http://127.0.0.1:8000")
form_input(selector: "textarea", text: "create a memo window saying hello")
press(key: "Enter", selector: "textarea")
press(key: "Shift+Tab")                       # open CLI panel (streaming + Monitor/Session "act as me" target toggle)
```

`press()` correctly handles modifier prefixes (`Shift+Tab`, `Ctrl+1`, `Meta+P`); navigation
timeouts resolve with `null` instead of rejecting, so a stalled page doesn't crash the server.

## Caveats for agent-driven sessions

- Don't drive YAAR through YAAR's own Browser app — that nests YAAR inside YAAR and produces
  recursive rendering plus duplicate-element selectors.
- The desktop sometimes auto-opens a Browser window when YAAR detects a browsing-related need; for
  clean demos, drive YAAR from a separate Chromium instance you control, not from a window inside
  YAAR.
- Take a screenshot before each action — the AI may have moved/added windows since your last view.

## Watching the agent's reasoning

`Shift+Tab` toggles the CLI panel (`DesktopSurface.tsx`), which streams every assistant token, tool
call, and OS Action live. For shell-based monitoring, tail the JSONL log:

```bash
tail -f session_logs/$(ls -t session_logs | head -1)/*.jsonl
```

## Claude-in-Claude (an AI agent inside YAAR, driven by a parent agent)

The parent agent (an outer Claude Code session) launches `make claude-dev`, opens Chromium at
`http://127.0.0.1:8000`, and types prompts into the command palette like a user. YAAR's own Claude
provider spawns its own `claude` subprocess to handle each prompt — that's two separate Claude
sessions stacked. The env-scrub in `session-provider.ts` is what makes this stacking work; without
it the inner `claude` inherits the outer's FD-based auth and
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, and immediately exits with code 1.
