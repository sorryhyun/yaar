# @yaar/shared

Shared types and schemas used by both `@yaar/server` and `@yaar/frontend`.

## What's in here

- **OS Actions** (`actions.ts`) — The JSON command language the AI uses to control the desktop (create windows, show notifications, etc.)
- **WebSocket Events** (`events.ts`) — Client/server event types for the real-time connection
- **Component DSL** (`components.ts`) — Zod v4 schemas for interactive UI components
- **App Protocol** (`app-protocol.ts`) — Types for bidirectional agent-to-iframe communication

## Usage

```typescript
import { type OSAction, ServerEventType, ClientEventType } from '@yaar/shared';
```

## Development

```bash
pnpm build       # Compile TypeScript
pnpm dev         # Watch mode
pnpm test        # Run tests
pnpm typecheck   # Type check without emitting
```

Build this package before starting the server or frontend — `make dev` handles this automatically.
