# Frontend Package

React + Zustand + Vite frontend that renders the ClaudeOS desktop.

## Commands

```bash
pnpm dev                    # Start dev server (proxies /ws and /api to localhost:8000)
pnpm build                  # Build for production
pnpm vitest                 # Run tests in watch mode
pnpm vitest run             # Run tests once
```

## Code Style

- TypeScript strict mode
- Path alias: `@/` → `src/`
- CSS Modules for component styles

## Directory Structure

```
src/
├── components/
│   ├── desktop/           # DesktopSurface, WindowManager
│   ├── ui/                # CommandPalette, ToastContainer, NotificationCenter, DebugPanel
│   └── windows/           # WindowFrame, ContentRenderer, LockOverlay
│       └── renderers/     # MarkdownRenderer, TableRenderer, HtmlRenderer, etc.
├── contexts/              # ComponentActionContext for interactive components
├── hooks/                 # useAgentConnection (WebSocket singleton)
├── store/                 # Zustand store with Immer
├── styles/                # CSS Modules
└── types/                 # WindowModel, DesktopState, RenderingFeedback
```

## State Management

**Zustand + Immer** pattern:
- All UI state in `store/desktop.ts`
- AI actions processed via `applyAction()` reducer
- User interactions (focus, close, move, resize) logged and sent to server

**Key selectors:**
- `selectWindowsInOrder` - Windows sorted by z-order
- `selectVisibleWindows` - Non-minimized windows
- `selectToasts` - Active toasts

## WebSocket Connection

`useAgentConnection` hook manages:
- Singleton WebSocket with auto-reconnect (exponential backoff)
- Incoming events: `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, `TOOL_PROGRESS`
- Outgoing: `USER_MESSAGE`, `WINDOW_MESSAGE`, `COMPONENT_ACTION`, `INTERRUPT`
- Sends rendering feedback and user interactions back to server

## Content Renderers

| Renderer | Data Type | Description |
|----------|-----------|-------------|
| `markdown` | `string` | Markdown to HTML |
| `table` | `{headers, rows}` | Table rendering |
| `html` | `string` | Raw HTML |
| `text` | `string` | Plain text |
| `iframe` | `string` (URL) | Embedded iframe |
| `component` | `ComponentNode` | Interactive React components from JSON |

## Adding a New Content Renderer

1. Create `src/components/windows/renderers/<Name>Renderer.tsx`
2. Add case in `src/components/windows/ContentRenderer.tsx`
3. Add styles in `src/styles/renderers.module.css`
4. Update renderer enum in `@claudeos/server` tools

## Testing

Uses Vitest + Testing Library + jsdom:
- Store tests: direct access via `useDesktopStore.getState()`
- Reset store in `beforeEach` for isolation
