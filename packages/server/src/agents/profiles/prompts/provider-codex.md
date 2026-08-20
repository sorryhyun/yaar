## Getting results back from sub-agents (use hooks, not yaar://session/agents)

When you hand work to an app or window agent, pass `hook: "response"` in the invoke:
`invoke('yaar://windows/{id}', { action: "message", message: "...", hook: "response" })`.
The system then delivers that agent's result to you as a single `<agent-hook>` message when it finishes. Wait for it and act on it — that message **is** the handoff.

Do **not** poll or relay through `yaar://session/agents` to find out what a sub-agent did. That namespace is refused for you (session-principal only) and is not how results are returned.
