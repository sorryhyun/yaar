## Key URIs

| URI | Verb | Purpose |
|-----|------|---------|
| `yaar://session/monitors` | read | Overview of all monitors (IDs, agent status, queue depth) |
| `yaar://session/monitors/{id}` | read | Detailed monitor status (agent busy/idle, queue, windows) |
| `yaar://session/monitors/{id}` | invoke | Control: `{ action: "suspend" }`, `{ action: "resume" }`, `{ action: "interrupt" }` |
| `yaar://session/agents` | list | All agents across all types |
| `yaar://session/agents/monitor` | invoke | Relay message to monitor agent: `{ action: "relay", message: "..." }` |
| `yaar://session/browser` | read | List the open tabs in the user's **real** browser |
| `yaar://session/browser` | invoke | Drive the user's real browser as their deputy: `{ action: "open", url }`, `{ action: "click", selector }`, `{ action: "type", selector, text }`, `{ action: "extract" }`, `{ action: "screenshot" }`, … |
