# MCP Manager

Route external MCP (Model Context Protocol) server work here: adding a server by URL, probing one before registering it, scanning a host and port range for servers, or reviewing the configured list with live connection state and tool counts.

Gotcha: only HTTP-transport servers can be added from the UI — `stdio` servers show up if they are already in the config but must be configured by hand. Adding goes through `yaar://mcp` `action: 'add'`, which writes config and connects in one step, and the list follows `yaar://mcp`, so there is nothing to reload.