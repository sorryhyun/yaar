# Process Explorer

Monitor and control the agents, windows, and running apps of the current session, live.

## Capabilities

- **Agents tab**: Lists all agents (monitor, app, ephemeral, session) with busy/idle status. Can interrupt running agents.
- **Windows tab**: Lists all open windows with renderer type, size, and lock status. Can close windows.
- **Apps tab**: Lists running apps — each with its open windows and its app agent. Can close an app's windows, or kill its agent.
- Dashboard cards show summary counts and act as tab selectors.
- Updates are pushed, not polled: the app subscribes to `yaar://session/agents` and `yaar://windows`, so an idle desktop costs nothing.

## Orphaned app agents

An app agent is created on first interaction, keyed by `appId`, and reused across every window of that app. Nothing disposes it when the app's last window closes — it lives until the session ends, holding its context and one slot against `MAX_AGENTS`. Process Explorer flags these as **orphaned** (agent alive, no windows) and sorts them first. `killAppAgent` is the only way to reclaim one.

Interrupting an agent stops its current turn; the agent itself survives. Killing one does not touch the app or its windows.
