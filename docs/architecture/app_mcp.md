# App MCP: a window, shared by URL

**Source:** `packages/server/src/features/window/external-share.ts`, `packages/server/src/mcp/server.ts` (`handleExternalMcpRequest`), `packages/server/src/mcp/external-help.ts` (the GET page), `packages/server/src/http/routes/window-share.ts`, `packages/frontend/src/lib/windowShare.ts`

An agent outside YAAR — a Claude Code session in some repo, a Codex thread — can drive one
YAAR window the user shared with it. The user presses the wifi button in the window's
titlebar, the URL lands on the clipboard, and the user pastes it wherever the outside agent
takes an MCP server:

```
http://127.0.0.1:8000/mcp/window/{token}
```

That URL is an ordinary MCP endpoint (Streamable HTTP, revision 2026-07-28). What it serves
is the **window's app agent**: the same tools, the same authority, pointed at that one
window. The path says `window` because that is what the token is bound to — one window, not
its app.

Fetched with GET (a browser, or an agent probing it with curl), the URL describes itself: which
window and app it is bound to, the revision, the `claude mcp add` line, the headers and `_meta`
envelope a raw request needs with a working curl, the tool list, and how the URL is revoked.

This is a rough first cut of [the proposal](../proposals/external_window_access_proposal.md),
and it deliberately takes a smaller path than the proposal describes (see the last section).

## The two ideas

**1. The URL is the credential, and the window is its lifetime.**

The token is minted on the window's side record (`WindowSideState.externalShare` in
`session/window-state.ts`) — the same record that holds the window's grants and history, and
that the one `window.close` path deletes. So:

- closing the window revokes the URL;
- a reopened window with the same id (`notes` again) starts unshared — the token was never
  keyed by the id string, so it cannot silently cover a new window;
- right-clicking the button (stop sharing) revokes it early;
- shares live in memory, so a server restart revokes all of them.

There is no pairing, no client registry, no header to configure: presenting the path is
presenting the credential. Clicking the button on a window that is already shared copies the
*same* URL — sharing is idempotent, so an agent holding it keeps working.

**2. Authority is borrowed, not invented.**

The app-agent tools (`mcp/app-agent/`) take all of their authority from the context they run
in: `getWindowId()`, `getMonitorId()`, `role: 'app'`. `handleExternalMcpRequest` resolves the
token to a window and runs the request in exactly that context, under the agent id
`external:{windowKey}`. So the outside agent gets precisely what the window's own app agent
holds, and nothing needed a new access tier:

| Reaches | Why |
|---|---|
| The app protocol (`query` / `command` / `describe`) | the window in context |
| The window's own `__screenshot` / `__content` / `__console` (`query`) | the window in context — the same builders as `read('yaar://windows/{id}/state/…')` |
| The app's own storage tree and the commons (`storage:*`, `storage/…`) | built into the app tools for every app |
| Shared storage past the commons | only what the app's `app.json` grants |
| Other apps | only what the app's `controls` names |
| The monitor agent (`relay`), other agents (`direct_message`) | same rules as the app agent |
| `yaar://session/*`, delegating grants | refused — `role: 'app'` is held to the same gates |

An app agent connects two namespaces (`app`, `messaging`); an outside client is handed one
URL, and one URL is one MCP server, so the external handler registers both on one server
(`getExternalHandler`). Tool names do not collide.

## Flow

```
titlebar click ──POST /api/window-share──▶ setWindowShared()          (host-only route)
                                             ├─ WindowStateRegistry.shareExternally() → token
                                             └─ session.broadcast(WINDOW_EXTERNAL_SHARE)  → every tab lights the button
            ◀── { path, localUrl } ──────────┘
clipboard ← localUrl (or the remote server URL + path in remote mode)

outside agent ──POST /mcp/window/{token}──▶ handleExternalMcpRequest()
                                         ├─ resolveExternalShare(token) → { sessionId, monitorId, windowId, role: 'app' }
                                         └─ runWithAgentContext(...) → app + messaging tools → app protocol → the iframe
                                                                                  └─ __screenshot → window.capture → the desktop
anyone ──GET /mcp/window/{token}──▶ the self-describing page (markdown; `Accept: text/event-stream` still 405)
```

Reloads and reconnects get the shared set in the `SNAPSHOT` (`sharedWindows`), so the lit
button survives a refresh. The URL itself is never in the store or in an event — only the
tab that pressed the button ever sees it.

## Things that were not obvious

- **The URL is built on the plain loopback socket, never `location.origin`.** A desktop
  opened on the local TLS socket (`https://localhost:8443`) would hand out a URL whose
  self-signed certificate Node, Bun, and therefore Claude Code refuse before sending a byte.
  The route answers `localUrl` (`http://127.0.0.1:{PORT}/mcp/window/…`); a remote desktop uses its
  remote server URL, which carries a real certificate.
- **Current Claude Code needs no flags.** 2.1.285 negotiated 2026-07-28 on its own with
  `--mcp-config '{"type":"http","url":…}'`, with and without `MCP_SDK_GENERATION` /
  `MCP_PROTOCOL_NEGOTIATION`. An older client is refused by `refuseLegacyEra`, whose message
  names both flags.
- **The monitor agent is told.** Every protocol command an outside agent runs is pushed to the
  monitor's timeline (`noteExternalCommand`, called beside `recordAppCommand`), so it does not
  find the window changed under it with no idea why. Reads are not reported. The command name
  comes from outside, so it is quoted into the prompt only when it looks like a name.
- **A window needs a page.** The app's state lives in its iframe, so a desktop tab (or the
  companion tab) has to be hosting it; otherwise commands time out like any app agent's would.
- **App windows only**, and the button is hidden on phones for now.
- **The window's own keys are the OS's, not the app's.** `__screenshot` and `__content` are
  answered by `features/window/builtin-state.ts` for both doors — the verbs door's `read` and
  the app agent's `query`. `query` used to hand every key to the iframe, which has never heard
  of them, so the app agent (and any outside agent borrowing it) could drive a window it could
  not look at. The `query` tool's parameter description names them, since an outside agent
  never sees the app agent's system prompt.
- **The GET page is measured, not recalled.** Every stateless POST needs
  `Content-Type: application/json`, an `Mcp-Method` header (plus `Mcp-Name` on `tools/call`),
  and a `_meta` with the protocol version and client capabilities; `Accept` is not checked.
  The page's tool list is asked of the endpoint itself, so it cannot drift from what is served.
- **Unmatched `/mcp/*` and `/.well-known/*` paths answer 404**, not the desktop's SPA
  fallback: a client probing `/.well-known/mcp.json`, or holding a mistyped share URL, used to
  get a 200 of HTML (`servesSpaFallback` in `http/routes/static.ts`).

## Where this departs from the proposal

The proposal pairs a named client with a durable key, then shares windows to it at `read` or
`operate` level through the `verbs` namespace, behind a default-deny gate in
`ResourceRegistry.execute`. v1 does none of that:

- no pairing and no levels — one capability URL per window, full app-agent authority;
- no new `external` role — `role: 'app'`, with the window's context, is the whole grant;
- no `verbs` surface — the outside agent speaks the app agent's four tools plus
  `direct_message`.

Open, roughly in order of how much they matter:

- **Remote mode.** `/mcp/*` skips remote-mode auth, so under `REMOTE=1` the URL works through
  the tunnel for anyone who has it. That is what makes it useful to a remote agent; it is also
  a bearer link.
- **Storage writes are not reported** to the monitor's timeline — only protocol commands are.
- **No status-bar presence.** An outside agent's calls stream nothing, so the agent roster
  does not show it; the lit button is the only indicator.
- **No subscriber notify** (`pool.notifyWindowSubscribers`) after an external command.
