# Claude Remote (the monitor agent on claude.ai)

YAAR can put a monitor agent's conversation on claude.ai through Claude Remote Control. Open
claude.ai/code or the Claude mobile app and you are talking to **that monitor's agent**, the
same one the desktop talks to, with the same conversation, tools and desktop. What you ask
there, it does on the desktop. What the desktop asks it shows up there too.

This is different from [Remote Mode](./remote_mode.md). Remote Mode sends the YAAR *desktop* to
another device over Tailscale. Claude Remote leaves the desktop where it is and lets you talk to
its agent from the Claude app, with no tunnel and no second browser.

**Source:** `packages/server/src/providers/claude/session-provider.ts` (bridge, pump,
reattach), `packages/server/src/providers/claude/turn-router.ts` (whose frame is whose),
`packages/server/src/agents/context-pool.ts` (`enableRemoteControl`, `remotePromptContext`),
`packages/server/src/agents/monitor-task-processor.ts` (`remote` tasks),
`packages/server/src/features/remote-control.ts`, `packages/server/src/http/routes/remote-control.ts`,
`apps/remote-control/`

## Using it

**From the app.** Open **Remote Control** (📡) on the monitor you want to reach and flip the
switch. After the permission dialog it shows the session link with Open and Copy. The link
belongs to the monitor of the window that started it. A window on another monitor shows where it
is on and can turn it off. The app polls its state every few seconds while visible; the status
also carries `callerMonitorId`, which is how a window learns its own monitor.

**From the monitor agent.** Ask: "claude remote 켜줘" / "start remote control". There is no
`yaar://` verb for this: the agent opens the Remote Control app and runs its `start` command, so
whatever turned it on, a window on screen shows that it is on. **You get a permission dialog first, every time.** The command returns the `sessionUrl`
(`https://claude.ai/code/session_…`). "remote control 꺼줘" runs the app's `stop`. Shutting YAAR
down or resetting the monitor stops it too.

The app talks to the server over REST, open only to the desktop and the bundled Remote Control
app (`kind: "system"`, which cannot be self-granted):

| Route | Body | Does |
|---|---|---|
| `GET /api/remote-control` | — | `running`, `state` (`ready` or null), `monitorId`, `sessionUrl`, `name`, `callerMonitorId` |
| `POST /api/remote-control/start` | `{ name? }` | User-confirmed. Bridges the caller's monitor agent and returns the status with `sessionUrl` |
| `POST /api/remote-control/stop` | — | Takes the conversation off claude.ai |

It works on one monitor at a time, and only with the Claude provider.

## How it works

### The bridge is the SDK session's own

Claude's IDE extensions put a headless session on claude.ai with a control request, and the
Agent SDK's `Query` has the same method: `enableRemoteControl(enabled, name?,
{ reattachSessionId? })`. It is there at runtime but missing from the SDK's published typings,
so the provider reaches it through a local interface and checks for it first
(`RemoteControlQuery`). It answers with `session_url` and `bridge_session_id`. After that,
turns YAAR pushes into the stream are mirrored to claude.ai, and messages typed on claude.ai
arrive in the CLI as turns of the same conversation.

So there is no second process and no second agent. The monitor agent's own CLI is bridged, and
the monitor agent's tools, history, timeline and app-agent traffic come along. That includes an
app agent's `hook: "response"` answer: it goes back to the monitor agent, which is now the agent
claude.ai is talking to.

### One reader for the stream (`turn-router.ts`)

A YAAR turn used to read the stream itself: push a message, pull `stream.next()` until the
`result`. That only works while YAAR is the only one that can start a turn. Now a **pump**
reads the stream for as long as the process lives, and `TurnRouter` decides where each frame
goes:

- Every message YAAR pushes carries a `uuid`. The CLI announces each turn with
  `command_lifecycle: started` naming the command it runs. A command YAAR pushed while one of
  its turns is reading belongs to that turn. Anything else is **detached**, meaning a
  claude.ai message, or a YAAR steer that missed its turn.
- Ownership moves only at a `result`. A message the CLI folds into a running turn also gets a
  `started`, and it must not split that turn's frames in two.
- When a YAAR message is folded into a claude.ai turn, that turn's `result` lists it in
  `user_message_uuids`. The waiting YAAR reader is released instead of waiting forever.
- With the bridge off, nothing is ever detached. Frames with no reader wait for the next
  turn, which is what reading the stream from inside the turn used to do with them.

The CLI runs with `--replay-user-messages`, so a claude.ai turn's text arrives as a replayed
`user` frame (`isReplay`, `origin.kind: "human"`). The detached turn is announced with that
text.

### A claude.ai turn is a `remote` task

The provider hands a detached turn to `ContextPool`, which makes it a monitor task of kind
`remote` that carries the running turn (`Task.external`). `MonitorTaskProcessor` runs it
through the usual `runAgentTurn`, so it gets agent status on the desktop, the session log, the
context tape and the stream events. `AgentSession` reads the turn's messages instead of starting
a query. The one thing that differs from other tasks: the turn is already running in the CLI
and runs whether YAAR shows it or not. So a `remote` task is never refused, steered, or given to
an ephemeral agent. If the monitor agent is busy, it goes to the **front** of the queue, past the
size limit (`MonitorQueuePolicy.enqueueFront`), and its frames buffer until then.

Stopping works both ways. `interrupt()` on an idle bridged agent with a claude.ai turn running
sends the soft control interrupt. It does not kill the process, which would take the bridge
down. A desktop message that arrives during a claude.ai turn is steered into it. A relay or an
app agent's `hook: "response"` answer that arrives during a claude.ai turn is queued
**without** interrupting it, unlike during a desktop turn.
Often that answer is exactly what the claude.ai turn asked for. The turn ends by itself, and
the answer runs as the next turn, which claude.ai shows.

### Desktop context for a claude.ai message

A desktop turn's prompt is built by YAAR, with `<timeline>` and `<open_windows>`. A claude.ai
message goes from the browser into the CLI untouched. The provider registers an SDK
`UserPromptSubmit` hook, and for a prompt YAAR did not push it returns `additionalContext` from
`ContextPool.remotePromptContext`. That context has three parts: the `<remote_control>` note
(`orchestrator/prompts/remote-message.md`: reply in chat, don't ask through desktop dialogs),
the monitor's timeline (drained, the same way a desktop turn drains it), and the open windows.

### Reopen and reattach

The stream is fixed when the process starts, so a new system prompt, a crashed process or a
stale resume means a reopen. The bridge belongs to the provider, not to one process. After a
reopen, `attachRemote` sends the request again with `reattachSessionId`, and the claude.ai link
stays the same. A claude.ai page that was open across the swap needs a reload. If the process
exits while the agent is idle, the provider reopens it by itself (backing off to 60s). Otherwise
claude.ai would be talking to nobody until the desktop's next turn.

## Verified live

Against CLI 2.1.277 / SDK 0.3.268, with a probe that logged every frame of an SDK
streaming query:

- `enableRemoteControl(true, name)` on a headless stream-json session returned a
  `claude.ai/code/session_…` link. A message typed there ran as a turn:
  `command_lifecycle queued/started` with a claude.ai-minted `command_uuid`, the usual frames,
  and a `result` whose `user_message_uuids` named it. There was no `user` frame for it until
  `--replay-user-messages` was on.
- A message pushed from the SDK side appeared on the claude.ai page, question and answer.
- A new process opened with `resume` plus `reattachSessionId` got the same session back, and
  answered the next claude.ai message after the page was reloaded.

A YAAR run against the Claude provider (2026-09-19), driven through the Remote Control
app and a claude.ai tab:

- The app's switch returned a `session_…` link titled "YAAR monitor 0". A claude.ai message
  ("open Memo, tell me which windows are open") ran as a `remote` task (`following remote
  turn` in the log). Memo opened on the desktop, the reply listed the right windows, and the
  question was in the session log under the monitor's source.
- A message typed at the desktop appeared on claude.ai with its `<timeline>` and
  `<open_windows>` prefix and its answer.
- From claude.ai, the agent sent Memo's agent a `message` with `hook: "response"`. The turn
  ended by itself, and the `<agent-hook type="response" appId="memo">` answer arrived as the
  next turn in the same claude.ai conversation, where the agent reported it.

## Debugging

- **Nothing shows on the desktop for a claude.ai message:** look for `external turn with no
  handler` in the log. The provider saw the turn, but the pool's handlers were never set, so
  the bridge was probably enabled outside `ContextPool.enableRemoteControl`.
- **The link stopped answering:** the process was replaced. Look for `remote control attached`
  or `could not reattach remote control` in the log, then reload the claude.ai page.
- **A desktop turn ended early or with someone else's answer:** that is a routing bug. The
  frames' `command_lifecycle` / `user_message_uuids` in the CLI transcript show whose turn was
  whose.

## Known gaps

- **The question isn't shown on the desktop.** The agent's reply to a claude.ai message
  streams onto the desktop like any turn's, but the claude.ai user's own text reaches only the
  log and the context tape. No server event echoes a user message to the frontend.
- **Out-of-order display at the seam.** If claude.ai and the desktop start a turn in the same
  instant, the CLI runs them in order but the desktop may show them the other way round. Each
  turn's frames still go to the right owner.
- **A reattached page may say "archived".** When the process is really replaced (a crash, a
  new prompt), the old process's teardown archives the claude.ai session while the new one
  reattaches to it. The conversation keeps working after a reload, and the banner's unarchive
  button clears it.
- **Monitor reset drops it.** Reset replaces the monitor agent and its provider, so the bridge
  goes with them. Start it again.
- **Undocumented SDK surface.** `enableRemoteControl` is not in the SDK's typings. A version
  that drops or renames it makes `start` fail with "This Claude Agent SDK cannot enable Remote
  Control."
