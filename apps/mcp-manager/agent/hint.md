Route external MCP (Model Context Protocol) server work here: adding a server by URL, probing
one before registering it, scanning a host and port range for servers, or reviewing the
configured list with live connection state and tool counts. Only HTTP-transport servers can be
added from the UI — `stdio` servers show up if they are already in the config but must be
configured by hand.

Two things about the protocol are not visible in `app.json` or `protocol.json`. It speaks MCP
revision `2025-06-18`, and it *negotiates*: whatever `protocolVersion` a server returns from
`initialize` is echoed back in the `MCP-Protocol-Version` header on every subsequent request, so
older servers keep working. Adding goes through `yaar://mcp` `action: 'add'`, which writes config
and connects in one step; the list follows `yaar://mcp` and updates itself when a server
connects, drops or re-caches its tools, so there is nothing to reload.
