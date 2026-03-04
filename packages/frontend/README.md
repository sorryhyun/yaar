# @yaar/frontend

React desktop UI for YAAR. Renders AI-generated windows, handles user input, and manages the WebSocket connection.

## Quick start

```bash
bun run dev          # Dev server at localhost:5173 (proxies /ws and /api to server)
bun run build        # Production build
bun run test         # Run tests
bun run typecheck    # Type check
bun run lint         # Lint
```

## Stack

- **React 19** + **Vite**
- **Zustand** + **Immer** for state (split into slices under `store/slices/`)
- **CSS Modules** for component styles
- **i18next** for internationalization

## Key areas

| Directory | What it does |
|-----------|-------------|
| `src/components/desktop/` | Desktop surface and window manager |
| `src/components/window/` | Window frame and content renderers (markdown, table, html, iframe, component) |
| `src/components/command-palette/` | Primary user input |
| `src/store/` | Zustand store composed from slices |
| `src/hooks/` | `useAgentConnection` — WebSocket singleton with auto-reconnect |

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.
