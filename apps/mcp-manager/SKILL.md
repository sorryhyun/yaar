# MCP Manager

Discover and manage external MCP (Model Context Protocol) servers.

## Features

- **Probe**: Test an MCP server URL to see its tools before adding
- **Add/Remove**: Register or unregister MCP servers in the config
- **Browse**: View configured servers, their status, and available tools
- Supports HTTP transport MCP servers

## Launch

```
create({ uri: "mcp-manager", title: "MCP Manager", renderer: "iframe", content: "yaar://apps/mcp-manager" })
```
