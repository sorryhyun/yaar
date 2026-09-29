---
name: sub-agents
description: Read before building an app that spawns AI characters or workers (sub-agents / personas) — manifest keys, streaming replies, persona tools.
audience: agent
---

## Sub-agents (personas)

An app can spawn AI instances from its iframe at `yaar://apps/self/agents`, each with a system
prompt the app supplies and its own memory. They hold no YAAR verbs or permissions.
`describe('yaar://apps/self/agents')` returns the verb surface; this topic is what it leaves out.

**Manifest.** `"subagents": { "max": N }` enables spawning; `"streams": ["agents"]` is needed to
watch replies. Write `subagents` — the retired `"personas"` key refuses every spawn, whatever
older text says. For an installed app both keys are requests the user approves at install, and
the approval is a ceiling. Neither is in force in a preview (the `preview-debugging` topic):
test the spawning path on the deployed app.

```ts
const { personaId, streamUri } = await invoke('yaar://apps/self/agents', {
  action: 'spawn', personaId: 'alice', systemPrompt: PROMPT,
});
await stream(streamUri, onFrame, { kinds: ['text', 'done', 'error'] });
await invoke(`yaar://apps/self/agents/${personaId}`, { action: 'message', content: 'Hi!' });
```

- **Await the stream, not the verb.** `message` resolves when the turn is *queued*; the reply is
  the `done` frame. Give each turn a watchdog so a silent persona costs one slow turn.
- **Spawn is idempotent and never updates the prompt.** A remount's re-spawn returns the live
  persona with `reused: true` and its memory intact. To recast, `delete` then spawn.
- **`message` is refused while that persona is mid-turn** (`busy: true`), not queued. The app
  schedules turns.
- **Persistence is the app's job.** Sub-agents die with the app's last window on the monitor;
  store history in `appDb`/`appStorage` and replay it into a respawn.

### Persona tools

`tools: [{ name, description, input? }]` at spawn gives a persona tools that call back into the
app: a call runs the protocol command `persona:{name}` in the app's active window with
`personaId` stamped last (a model cannot spoof it), and the handler's return is the tool result.
Declare each `persona:*` command in `defineApp` with `replay: 'never'`; they are hidden from the
app agent's manifest. Prefer a tool (`skip`) over a sentinel in the reply text (`[[skip]]`), and
use one for any lookup whose result must come back mid-turn (`recall`). With no window open, a
tool call returns an error result and the turn continues.
