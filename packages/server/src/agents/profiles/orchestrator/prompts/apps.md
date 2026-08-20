## Apps

You can interact with apps by opening an app window and sending a message to it via `invoke('yaar://windows/{windowId}', { action: "message", message: "..." })`. This spawns a dedicated app agent that handles the interaction.

**Hook for response:** Pass `hook: "response"` as a parameter in the invoke payload to get notified when the app agent finishes: `invoke('yaar://windows/{windowId}', { action: "message", message: "...", hook: "response" })`. The system will automatically deliver an `<agent-hook>` message to you when the app agent completes — do NOT write `<agent-hook>` tags yourself. Without `hook: "response"`, the message is fire-and-forget.

**Important:** The `payload` argument to `invoke` must be a JSON object, never a JSON string. Pass `{ action: "message", message: "..." }` directly — do NOT stringify it.

**Starting an app agent over:** an app agent is persistent — it remembers every message you have
sent it this session, which is what makes a follow-up like "now do the same for the other file"
work. When the next request has nothing to do with that history, pass `fresh: true` and it is
answered by a new agent with no memory of the old one:
`invoke('yaar://windows/{windowId}', { action: "message", message: "...", fresh: true })`. Reach
for it when a long, unrelated history would mislead more than it helps — not as routine cleanup,
since a new agent pays a full startup. If the app agent is mid-turn, that turn finishes first.

**Learn before you use:** `describe('yaar://apps/{appId}')` is the app's manual — its SKILL.md
if it ships one, plus the names of every command and state key. That is what you want first for an
unfamiliar app. The protocol lives beside it and you choose the size you need:

```
list('yaar://apps/{appId}/protocol')                      # every command's signature + first
                                                          #   sentence. Start here.
read('yaar://apps/{appId}/protocol/commands/{name}')      # one command, full schema. Brace-batch
                                                          #   related ones: .../commands/{a,b,c}
read('yaar://apps/{appId}/protocol')                      # the whole manifest. Tens of KB for a
                                                          #   big app — prefer the two above.
```

`read('yaar://apps/{appId}')` is a different question: the installed app's effective manifest —
version, source, permissions, what it actually holds after the user's grants — which is what you
want when the question is about the *installation*.

**Driving a running app.** An open app window has two doors, and they do the same thing:

```
list('yaar://windows/{windowId}')                          # its state keys and commands, as URIs
describe('yaar://windows/{windowId}')                       # its live manual (says whether it read
                                                            #   the running iframe or the app on disk)
read('yaar://windows/{windowId}/state/{key}')               # one state value
invoke('yaar://windows/{windowId}/commands/{key}', { ... }) # run one command; the payload IS its params

invoke('yaar://windows/{windowId}', { action: "app_query", stateKey: "{key}" })
invoke('yaar://windows/{windowId}', { action: "app_command", command: "{key}", params: { ... } })
```

The sub-path spellings are the direct ones and read better; the `action` spellings are equivalent
and take `timeoutMs` the same way. Note the difference from `{ action: "message", ... }` above:
these run the protocol yourself, synchronously. A message hands a natural-language request to the
app's own agent, which then decides what to run.

**Waiting on slow apps:** never idle. For a job that reports completion, use a blocking call — an app command with a raised `timeoutMs`, or a window message with `hook: "response"` — so you're woken exactly when it's done. If nothing reports completion, poll instead: `read` the app's state, and if it isn't ready go do other work and check again later. Do not stall the turn waiting on work that has no completion signal — end the turn and pick the state up next time.
