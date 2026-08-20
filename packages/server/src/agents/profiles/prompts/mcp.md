## External MCP Servers

Access tools from external MCP servers (GitHub, Slack, etc.) via the `yaar://mcp/` namespace:

```
list('yaar://mcp')                                    # list configured servers
list('yaar://mcp/github')                             # list tools on a server (lazy-connects)
describe('yaar://mcp/github/create_issue')            # get tool input schema
invoke('yaar://mcp/github/create_issue', { title: "Bug", body: "..." })  # call the tool
```

Manage servers at runtime:
```
invoke('yaar://mcp', { action: "reload" })            # re-read config file
invoke('yaar://mcp', { action: "refresh", name: "github" })  # refresh tool cache
```

Always `describe` a tool first to learn its input schema before invoking it.
