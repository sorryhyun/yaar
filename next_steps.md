# Multi-Client Session — Future Phases

## Phase 1 (Complete): Multi-Client Session Foundations
- LiveSession singleton owns ContextPool, WindowStateRegistry, ReloadCache
- Multiple WebSocket connections share the same session
- EventSequencer stamps events with monotonic `seq` for replay
- Frontend reconnects with `?sessionId=X` to rejoin sessions
- wss:// protocol support for tunnel/mobile access

## Phase 2: Session Persistence & Recovery
- Persist LiveSession state across server restarts
- Session timeout: configurable delay before cleanup after all connections drop
- Session resume: reconnect to a session even after server restart using saved thread IDs
- LiveSession.serialize() / LiveSession.restore() for state persistence

## Phase 3: Mobile-Optimized View
- Responsive frontend layout for mobile screens
- Touch-optimized window interactions
- Simplified window chrome for small screens
- Mobile-specific input mode (full-screen input overlay)

## Phase 4: Session Management UI
- Session listing in frontend (desktop & mobile)
- Create new session / switch between sessions
- Session sharing: QR code or link to join a session from another device
- Session permissions: read-only observer mode vs. full interaction

## Phase 5: Optimized Sync
- Use EventSequencer ring buffer for incremental sync on reconnect
- Delta compression for window state updates
- Selective event filtering per connection (e.g., mobile skips AGENT_THINKING)
- Bandwidth-aware quality settings
