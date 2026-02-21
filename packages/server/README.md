# @yaar/server

WebSocket server that connects AI providers (Claude, Codex) to the YAAR frontend. Runs on [Bun](https://bun.sh/).

## Quick start

```bash
pnpm dev          # Start with file watching (bun --watch)
pnpm build        # Build for production
pnpm test         # Run tests
pnpm typecheck    # Type check
pnpm lint         # Lint
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDER` | auto-detect | Force `claude` or `codex` |
| `PORT` | `8000` | Server port |
| `MAX_AGENTS` | `10` | Global agent concurrency limit |
| `MCP_SKIP_AUTH` | — | Set `1` to skip MCP auth (local dev) |
| `REMOTE` | — | Set `1` for remote mode with token auth |

## Key concepts

- **Session > Monitor > Window** — nested abstractions for conversation state, virtual desktops, and UI surfaces
- **Pluggable providers** — `AITransport` interface with Claude (Agent SDK) and Codex (JSON-RPC) implementations
- **MCP tools** — domain-organized tool servers (`system`, `window`, `storage`, `apps`, `user`, `dev`, `browser`)
- **Policy pattern** — complex behaviors decomposed into focused policy classes

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.
