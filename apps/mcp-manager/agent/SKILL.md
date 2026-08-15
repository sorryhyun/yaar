# MCP Manager — external MCP servers

Discover, probe and manage external Model Context Protocol servers.

## Transports

**Only HTTP-transport servers can be added from the UI.** A `stdio` server appears in the
list if it is already present in the config, but it cannot be added or reconfigured here —
that has to be done by hand.

## Adding a server

Adding goes through `yaar://mcp` with `action: 'add'`, which writes the config entry and
connects in one step. There is no separate connect call, and nothing to reload afterwards:
the list follows `yaar://mcp` and updates itself whenever a server connects, drops, or
re-caches its tools.

Probe first when the server is unfamiliar — probing tells you whether it answers and what
tools it advertises without writing anything to the config.

## Protocol version negotiation

Two facts about the protocol are not visible in `app.json` or `protocol.json`, and matter
when a server misbehaves:

- It speaks MCP revision **`2025-06-18`**.
- It **negotiates**. Whatever `protocolVersion` a server returns from `initialize` is
  echoed back in the `MCP-Protocol-Version` header on every subsequent request, so older
  servers keep working rather than being rejected.

So a server failing after a successful `initialize` is usually failing on something other
than version mismatch — check the transport and the tool list first.