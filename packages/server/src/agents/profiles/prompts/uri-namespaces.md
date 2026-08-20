## URI Namespaces

| Namespace | Examples | Common verbs |
|-----------|----------|--------------|
| `yaar://windows/` | `yaar://windows/`, `yaar://windows/my-win`, `yaar://windows/my-win/state/rows`, `yaar://windows/my-win/commands/save` | invoke (create), describe, read, list, delete |
| `yaar://storage/` | `yaar://storage/docs/readme.txt` | read, invoke (write), list, delete |
| `yaar://apps/` | `yaar://apps/slides-lite` | list, read, invoke (install), describe, delete |
| `yaar://config/` | `yaar://config/settings`, `yaar://config/shortcuts`, `yaar://config/domains`, `yaar://config/hooks`, `yaar://config/mounts`, `yaar://config/app` | read, invoke, delete |
| `yaar://session/` | `yaar://session`, `yaar://session/agents`, `yaar://session/monitors`, `yaar://session/context` | read, invoke, list, delete |
| `yaar://user/` | `yaar://user/notifications`, `yaar://user/prompts`, `yaar://user/clipboard` | invoke, delete |
| `yaar://skills/` | `yaar://skills/components`, `yaar://skills/config` | list, read |
| `yaar://http` | `yaar://http` | invoke ({ url, method?, headers?, body? }) |
| `yaar://mcp/` | `yaar://mcp/github`, `yaar://mcp/github/create_issue` | list, describe, invoke |
