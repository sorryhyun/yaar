# MCP Manager

Discover, probe and manage external MCP (Model Context Protocol) servers for YAAR.

## What it does

- **Add by URL** — enter an MCP endpoint, probe it, and see its name, negotiated
  protocol version and tool list *before* registering it.
- **Scan** — sweep a host and port range for MCP servers on a given path
  (default `/mcp`). Results already registered are filtered out.
- **Manage** — view configured servers with live connection state and tool
  counts; expand a row to list its tools; refresh or remove a server.

Only HTTP-transport MCP servers can be added here. `stdio` servers appear in the
list if they are already in the config, but must be configured by hand.

## Protocol

Speaks MCP revision `2025-06-18`. It negotiates: whatever `protocolVersion` a
server returns from `initialize` is echoed back in the `MCP-Protocol-Version`
header on every subsequent request, so older servers still work.

## Notes

- Connection state is live — the list follows `yaar://mcp` and updates itself
  when a server connects, drops or re-caches its tools. There is no reload button.
- Adding goes through `yaar://mcp` `action: 'add'`, which writes config and
  connects in one step.
- Removing from the UI asks for confirmation; the `removeServer` command does not.
