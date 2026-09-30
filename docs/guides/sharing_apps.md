# Sharing Apps

A YAAR app can leave your desktop in two shapes, and they carry different things:

| | **Static — the file** | **Dynamic — the window** |
|---|---|---|
| What you hand over | `dist/index.html`, one self-contained file | a URL: `http://127.0.0.1:8000/mcp/window/{token}` |
| Who it is for | a person with a browser | an agent (Claude Code, Codex, any MCP client) |
| What travels | the app's code, styles, assets and libraries | a live window: its state, its storage, its commands |
| Needs your YAAR running | no | yes, with the window open on a desktop |
| Lifetime | forever — it is a copy | until the window closes (or you stop sharing) |

Pick static when someone should *use* the app. Pick dynamic when an agent should *work with*
the app you're looking at, right now.

## Static: the app is one HTML file

Every app compiles to a single file with everything inline — its JavaScript and CSS, its images
and fonts as `data:` URIs, the design tokens, the bundled libraries (Solid, Three.js, Tone.js,
…) and the iframe SDK. That file *is* the app:

```
apps/{appId}/dist/index.html        # bundled apps
user-apps/{appId}/dist/index.html   # installed apps (or $YAAR_USER_APPS, or your workspace's)
```

Send it, attach it, put it on any static host, or double-click it. It opens in any browser,
from disk (`file://`) or from a server, with no YAAR anywhere.

### What works outside YAAR

Everything that happens inside the page. Nothing that reaches the YAAR server.

"Self-contained" describes the bytes, not the runtime. On your desktop the app talks to the
server for storage, its database, the `yaar://` verbs and the fetch proxy. Outside YAAR there
is no server and no iframe token, so those calls fail. The rest of the page runs as normal.

Measured by opening two built apps from `file://` in Chrome:

- **Music Maker** renders and plays: the sequencer, the Tone.js synths and the melody generator
  are all in-page. Only saving a pattern (`appStorage`) would fail.
- **Memo** renders its shell and says "No memos yet". Its memos live in `appDb`, and every
  database call fails (`fetch` to `file:///api/verb` is blocked, `Failed to fetch`).

So a game, a visualizer, a calculator or a synth travels well. An app whose point is its saved
data — notes, a file browser, anything built on `appDb` or `storage` — arrives as an empty
shell. A copy served over `http` from another host is no better: its `/api/...` calls go to
that host and get 404s. And there is no agent: an app agent needs YAAR to run.

### Before you send it

- **Make sure it's current.** `dist/` is regenerated on every deploy, and YAAR rebuilds stale
  apps at startup. For a fresh build right now: `bun run build:apps {appId}`.
- **Don't edit it.** `dist/` is derived. The next deploy or rebuild replaces it. Change the
  source (or ask the app to change itself) and rebuild.
- **It contains nothing from `config/`.** Credentials live in the config directory, never in
  the app directory, so they are never compiled in. Whatever the app *imports* (images,
  data files) is in the file, though, so check that before you post it publicly.

### To another YAAR: share the source, not the file

A copied `dist/index.html` is a frozen snapshot. For someone who runs YAAR too, share the app
itself so their machine compiles it and they can keep changing it:

- **The folder.** An app is a directory (`app.json`, `src/`, optional `agent/`). Copy it
  without `dist/` into their `user-apps/`. It compiles the next time YAAR starts, or right away
  with `bun run build:apps {appId}`.
- **YAAR Market.** Say "publish it", or use the Market Apps app. The market ships the source
  without `dist/`, the installing machine compiles it locally, and the install asks the user
  before granting any permission the app wants. Details:
  [Publishing and installing](../architecture/app_pipeline.md#publishing-and-installing).

## Dynamic: share a live window with an agent

Here an outside agent drives *your* window while you watch. A Claude Code session in some repo
can load a model into 3D Studio, check the result and adjust it, without ever opening YAAR.

### Share

1. Press the **wifi button** in the titlebar of an app window. The button lights up and a URL
   is copied to your clipboard:
   ```
   http://127.0.0.1:8000/mcp/window/{token}
   ```
2. Hand the URL to the agent. For Claude Code:
   ```bash
   claude mcp add --transport http yaar-window http://127.0.0.1:8000/mcp/window/{token}
   ```
   Or just paste the URL into the conversation. A `GET` on it returns a page that explains
   itself: which app and window it controls, the protocol revision, the headers, a `curl`
   example, the tools, and how the URL is revoked. An agent that fetches the URL first learns
   how to connect in one round trip.

App windows only, and the button is hidden on phones for now.

### What the agent gets

Exactly what the window's own app agent has. The URL is an MCP server (Streamable HTTP,
revision 2026-07-28) whose tools run in that window's app-agent context:

| Tool | Does |
|---|---|
| `describe` | The app's protocol: its state keys and commands. Call this first. |
| `query` | Reads app state. `__screenshot` returns what the window is showing right now, `__content` its raw content, `storage/…` the app's own files. |
| `command` | Runs an app command, or writes the app's own storage. |
| `relay` | Hands a message to your monitor agent. |
| `direct_message` | Messages another agent, under the same rules as the app agent. |

The agent gets no more than that. It reaches other apps only through the `controls` in the
app's `app.json`, shared storage only as far as the app's permissions go, and never
`yaar://session/*`. Nothing new was granted to make sharing work. The agent borrows the
authority the window already had.

Your monitor agent is told about every command an outside agent runs, so it does not find
the window changed with no idea why.

### Keep the window hosted

The app's state lives in its page, so a desktop tab (or the
[companion tab](../reference/server_env.md)) has to be showing the window. If no page is hosting
it, commands time out the same way they would for the app's own agent.

### Stop sharing

The URL is the credential: anyone who holds it can drive the window. It is revoked when:

- you **close the window**. A reopened window starts unshared, even with the same id;
- you **right-click the wifi button** (stop sharing);
- the **server restarts**. Shares live in memory.

Pressing the button again on a shared window copies the *same* URL, so an agent that already
holds it keeps working. After a revoke the URL answers `404` ("No shared window at this URL").

Treat the URL like a password. It ends up in shell history, MCP configs and chat transcripts.
Locally it only answers on `127.0.0.1`. In [remote mode](./remote_mode.md) the copied URL is the
tunnel URL, and it works for anyone on your tailnet who has it.

### Clients

Current Claude Code negotiates revision 2026-07-28 on its own. An MCP client that only speaks
the older 2025-era protocol is refused with a message naming the opt-in flags. Internals — how
the token maps to a window, why the URL uses the plain loopback socket, what is still open:
[App MCP: a window, shared by URL](../architecture/app_mcp.md).
