# Claude Remote (hosted Remote Control)

YAAR can host `claude remote-control` and make every session it spawns a **YAAR monitor agent**.
Open claude.ai/code or the Claude mobile app, and the Claude you talk to there works on your YAAR
desktop: it opens apps, reads windows, and takes screenshots, and all of it shows up live on the
monitor that started it.

This is different from [Remote Mode](./remote_mode.md). Remote Mode sends the YAAR *desktop* to
another device over Tailscale. Claude Remote leaves the desktop where it is and gives you a YAAR
*agent* in the Claude app, with no tunnel and no second browser.

**Source:** `apps/remote-control/`, `packages/server/src/features/remote-control/host.ts`, `packages/server/src/features/remote-control/agent-config.ts`, `packages/server/src/handlers/remote-control.ts`, `packages/server/src/mcp/external-principals.ts`, `packages/server/src/session/live-session.ts`

## Using it

**From the app.** Open **Remote Control** (📡) on the monitor you want the remote Claude to
drive and flip the switch. After the permission dialog it shows `starting`, then the session link
with Open / Copy once the CLI prints it, and the terminal tail while it waits (Press Enter answers
a prompt). The host is bound to the monitor of the window that started it. A window on another
monitor shows where it is running and can turn it off. The app follows the host through a
subscription on `yaar://system/remote-control`: `host.ts` pings it on start, on the link, on exit,
and (throttled) on terminal output. `read` also returns `callerMonitorId`, which is how a window
learns its own monitor.

**From the monitor agent.** Ask: "claude remote 켜줘" / "start remote control". It will:

1. Call `invoke('yaar://system/remote-control', { action: "start" })`. **You get a permission
   dialog first, every time.**
2. Poll `read('yaar://system/remote-control')` until `state` is `"ready"`.
3. Show you the `sessionUrl`, a `https://claude.ai/code?environment=env_…` link. Open it, or pick
   the environment (named after this machine) in the Claude app.

Stop it with "remote control 꺼줘", which calls `delete('yaar://system/remote-control')`. Shutting
YAAR down stops it too.

| Verb | Payload | Does |
|---|---|---|
| `read` | — | `state` (`starting`/`ready`/`exited`), `sessionUrl`, `monitorId`, `pid`, `tail` (ANSI-stripped terminal output) |
| `invoke` | `{ action: "start", name?, permissionMode?, spawn?, continue? }` | User-confirmed spawn. The flags pass through to the CLI, plus `--no-chrome`. `spawn` is `same-dir` (default, always passed so the CLI never asks) or `session`; `worktree` is refused, because a worktree checkout lacks the git-ignored generated config. `continue` reattaches to the last session (the CLI keeps it for about 4h) and can't be combined with `spawn` |
| `invoke` | `{ action: "write", data }` | Types into the host terminal, e.g. `"\r"` for a prompt the `tail` shows it waiting on |
| `delete` | — | SIGINT, then SIGKILL after 3s |

There is one host at a time. POSIX only, since Windows has no PTY here.

## How it works

Four pieces are needed, and leaving out any one of them breaks the feature in a different way.

### 1. A PTY host (`host.ts`)

`remote-control` is a TTY program, so it runs under Bun's built-in PTY (`Bun.spawn({ terminal })`)
instead of a pipe. Bun 1.4 ships this, so there is no `node-pty`. The terminal bytes are kept in a
64 KB ring buffer. The link is matched against the **raw** bytes, because the CLI prints it as an
OSC 8 hyperlink and `Bun.stripANSI` would delete the URL along with the escape.

### 2. The monitor agent's options, written where a plain CLI reads them (`agent-config.ts`)

`claude remote-control` takes no `--mcp-config`, `--system-prompt` or `--tools`. The sessions it
spawns do read their working directory and inherit its environment, though. So on every start YAAR
runs the **same `buildSDKOptions`** that a real monitor turn uses (monitor tool set, monitor model,
env), and writes each field into `config/remote-control/`, which becomes the cwd:

| SDK option | Where the remote session gets it |
|---|---|
| `env` (`buildClaudeEnv`) | the spawn env of `remote-control` itself |
| `mcpServers` + headers | `.mcp.json`, with header values as `${YAAR_MCP_HEADER_n}` refs. The bearer and the agent token live only in env, never on disk |
| `systemPrompt` | `.claude/output-styles/yaar.md` with `keep-coding-instructions: false`, selected by `outputStyle`. It is the **remote** orchestrator prompt (below) |
| `allowedTools` | `permissions.allow` in `.claude/settings.json` |
| `tools` / `disallowedTools` | `permissions.deny`: every CLI built-in the SDK set leaves out (Bash, Edit, Read, …) |
| `model` | `model` in the same settings |

Three things deliberately differ from a local monitor turn:

- **Prompt.** `REMOTE_ORCHESTRATOR_PROMPT` swaps the intro and Visibility for remote ones: the user
  reads the chat reply, not the desktop. It also says the session runs on the user's machine,
  which overrides the "cloud container, git push" section claude.ai adds to the base prompt. It
  leaves out what a remote session never receives (Interaction Timeline, Action Reload Cache, User
  Drawings), user-prompt dialogs nobody may be at the desktop to answer, its own Remote Control
  section, and onboarding.
- **Tools.** `reload_cached` / `list_reload_options` are dropped, since only local turns get
  `<reload_options>`, so `.mcp.json` lists just `verbs` and `messaging`.
- **Env.** `ENABLE_TOOL_SEARCH=false`. The CLI otherwise defers MCP tools behind ToolSearch, which
  cost the first remote turn a round trip just to load the verbs. An explicit off also beats the
  service-side force flag.

Because the directory is regenerated from `buildSDKOptions` on each start, a change to the monitor
agent's prompt, tools or env reaches remote sessions automatically. **Don't hand-edit
`config/remote-control/`. It is overwritten.**

### 3. An identity outside the agent pool (`mcp/external-principals.ts`)

`handleMcpRequest` maps `X-Agent-Token` to an agent id, then asks the `SessionHub` for that agent's
session, monitor and role. Only the agent pool can answer that. The remote session is not pooled,
so without extra help it would resolve to `'unknown'` with no monitor.

`start` mints a token for the agent id `remote-control` and registers it as an **external
principal** bound to the caller's session and monitor. The MCP handler falls back to that table
when the hub doesn't know the id. The role is fixed to `monitor` by type, so a remote session
**never** gets `session-principal` access (`yaar://session/*`, the user's real browser). When the
process exits, the token is revoked and the principal removed.

### 4. Delivery to the screen (`live-session.ts`)

Pooled agents reach the frontend through their `ToolActionBridge`. The remote agent has none. It
used to fall through `LiveSession.handleEmittedAction`, whose direct broadcast only covered
`iframe:` callers, and the result was confusing: the server's window registry held the window (the
agent could `read` it and saw it in its layout), but no screen ever rendered it
(`renderConfirmed: false`), and notifications went nowhere. External principals now take the same
direct-broadcast path as iframe apps, `requestId` included, so render feedback and `__screenshot`
work.

## Verified live (2026-09-17)

- The remote session loaded the `yaar` output style and `claude-opus-5`, and reached YAAR's
  `verbs` server through the generated `.mcp.json`.
- It opened `music-maker` as window `0/music-maker`, which appeared on the desktop.
- It read `yaar://windows/music-maker/state/__screenshot` and described the rendered window in the
  Claude app.
- The CLI prints the environment link (`claude.ai/code?environment=env_…`), not a
  `session_…` link. `host.ts` matches both.

## Debugging

- **What the remote agent actually did:** its transcripts are plain Claude Code sessions under
  `~/.claude/projects/-Users-kscnc-yaar-config-remote-control/`. Tool calls, results and the
  loaded output style are all there. YAAR's own session log records the *actions* it emitted, not
  its conversation.
- **Stuck in `starting`:** read `tail`. The CLI is usually waiting on a prompt (folder trust on a
  fresh cwd, for example). Answer it with `write`.
- **Tools missing in the remote session:** `/mcp` in that session should list `system`, `verbs`
  and `messaging` as connected. If they are missing, check that `.mcp.json` exists in the cwd and
  that the process env carries the `YAAR_MCP_HEADER_*` vars.
- **Windows exist but don't render:** that was the missing broadcast (piece 4). Check that the
  agent id is still registered as an external principal.

## Known gaps

- **Separate histories.** Remote turns are not in the monitor agent's `ContextTape`, so the desktop
  monitor agent doesn't know what the remote one did, and vice versa. They share only the desktop
  itself.
- **Invisible to the desktop UI.** No status-bar chip, and not listed in `yaar://session/agents`.
- **No YAAR-side hooks.** The escape-repair `PreToolUse` hook and per-turn session logging don't
  apply.
- **Deny list is hand-spelled.** Settings can only *deny* tools, so the SDK's allowlist becomes a
  list of CLI built-in names (Cron*, worktree, plan mode, Monitor, SendMessage, … included). A
  built-in the CLI adds later isn't denied until it is added there. Check the transcript's
  `deferred_tools_delta` / tool list after a CLI upgrade.
- **One monitor, one host.** The principal is bound to the monitor that ran `start`. A second host,
  or one host per monitor, is not supported yet.

## Next

The reverse direction, **attaching to a Remote Control session from inside YAAR**, rests on the
same PTY host. `claude --cloud <session id | URL>` in a PTY behind an xterm window is the likely
shape.
