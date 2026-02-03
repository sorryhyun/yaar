# YAAR Milestones

## Vision

Transform YAAR into a true AI-native operating system where multiple AI agents work autonomously across virtual screens while users maintain full control and visibility.

---

## Phase 1: Window-Based Agent Orchestration

### Killer Feature: Agent Windows (In-Screen Orchestration)

**Concept**: Multiple agents work in parallel **within the same screen**, each with their own dedicated window. User sees all agent activity at once - no screen switching needed.

```
┌─────────────────────────────────────────────────────────────┐
│ YAAR - Single Screen, Multiple Agents                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────────────────┐  ┌──────────────────┐               │
│   │ 🤖 Planner       │  │ 🤖 Coder         │               │
│   │ ─────────────────│  │ ─────────────────│               │
│   │ Task breakdown:  │  │ Writing code...  │               │
│   │ 1. Setup API     │  │ ```typescript    │               │
│   │ 2. Build UI      │  │ function fetch() │               │
│   │ 3. Add tests     │  │ ```              │               │
│   └──────────────────┘  └──────────────────┘               │
│                                                             │
│   ┌──────────────────┐  ┌──────────────────┐               │
│   │ 🤖 Researcher    │  │ 👤 User Terminal │               │
│   │ ─────────────────│  │ ─────────────────│               │
│   │ Found 3 APIs:    │  │ $ pnpm dev       │               │
│   │ • OpenWeather    │  │ Server running   │               │
│   │ • WeatherAPI     │  │ on :3000         │               │
│   └──────────────────┘  └──────────────────┘               │
│                                                             │
│   [Main Input: Talk to all agents or @mention specific one] │
└─────────────────────────────────────────────────────────────┘
```

**Why In-Screen is Better**:
- Already have `windowAgents` mapping (window → agent)
- Already have window locking per agent
- User sees everything at once - no context switching
- Natural tiling/arrangement of agent workspaces
- Agents can reference each other's visible output

**Implementation**:
- [ ] Agent-owned windows with visual indicator (🤖 icon, colored border)
- [ ] Agent status in window title bar (thinking, working, idle, error)
- [ ] @mention routing in main input (`@planner what's the status?`)
- [ ] Cross-window agent communication via shared ContextTape
- [ ] Agent window auto-arrangement (tile new agent windows)

**New OS Actions**:
```typescript
type AgentWindowAction =
  | { type: 'window.createForAgent'; windowId: string; agentId: string; role: string; title: string }
  | { type: 'window.setAgentStatus'; windowId: string; status: 'thinking' | 'working' | 'idle' | 'error' }
  | { type: 'agent.message'; fromAgent: string; toAgent: string; message: string }
  | { type: 'agent.broadcast'; fromAgent: string; message: string }
```

### Nice-to-Have: Virtual Screens (for User Organization)

- Optional multiple screens for **user** organization (not agent isolation)
- Example: "Development" screen vs "Research" screen
- User manually moves windows between screens
- Agents can work on any screen the user assigns them to

---

## Phase 2: Multi-Agent Orchestration

### Killer Feature: Agent Conductor

**Concept**: A meta-agent that coordinates specialized sub-agents. When user requests a complex task, the Conductor spawns role-specific agents, each getting their own window to work in.

```
User: "Build a weather app"
         │
         ▼
   ┌──────────────┐
   │  Conductor   │  ← Orchestrates from main input
   └──────────────┘
         │
         │ spawns agents with windows
         │
    ┌────┴────┬────────┬────────┐
    ▼         ▼        ▼        ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│Planner │ │Research│ │ Coder  │ │Reviewer│
│Window 1│ │Window 2│ │Window 3│ │Window 4│
└────────┘ └────────┘ └────────┘ └────────┘
    │         │        │        │
    └─────────┴────────┴────────┘
                  │
                  ▼
    All visible on same screen to user
```

**Implementation**:
- [ ] Conductor system prompt with spawning capabilities
- [ ] Inter-agent message passing via ContextTape tags
- [ ] Agent lifecycle management (spawn, monitor, terminate)
- [ ] Progress aggregation from all active agents
- [ ] Conflict resolution when agents modify same resources
- [ ] Auto-tile windows when spawning multiple agents

**New MCP Tools for Conductor**:
```typescript
// Spawn specialized agent with its own window
conductor_spawn_agent(role: string, task: string, windowTitle?: string)

// Send message to specific agent (appears in their window)
conductor_message_agent(agentId: string, message: string)

// Wait for agent completion
conductor_await_agent(agentId: string, timeoutMs?: number)

// Get status of all agents
conductor_status()

// Broadcast to all agents
conductor_broadcast(message: string)
```

### Killer Feature: Agent Status Bar / Activity Panel

**Concept**: Since agents are visible in their windows, add a compact status bar or collapsible panel showing all agent states at a glance.

```
┌─────────────────────────────────────────────────────────────┐
│ Agents: 🔵 Planner (working) │ 🟢 Coder (idle) │ 🔴 Research│
└─────────────────────────────────────────────────────────────┘

Or expanded panel:
┌─────────────────────────────────────────┐
│ Agent Activity                      [▼] │
├─────────────────────────────────────────┤
│ 🔵 Planner → Task Window                │
│    Creating task breakdown...           │
│                                         │
│ 🟢 Coder → Code Window                  │
│    Writing WeatherService.ts            │
│    ████████░░ 80% complete              │
│                                         │
│ 🔴 Research → Research Window           │
│    Error: API rate limited              │
│    [Retry] [Skip] [Help]                │
└─────────────────────────────────────────┘
```

**Implementation**:
- [ ] Aggregate `AGENT_THINKING` events from all agents
- [ ] Show agent status, current tool, progress
- [ ] Allow user intervention (pause, redirect, cancel)
- [ ] Click agent name to focus their window
- [ ] Compact mode for taskbar, expanded for details

---

## Phase 3: Context Persistence & Restoration

### Killer Feature: Session Snapshots

**Concept**: Save complete workspace state (windows, positions, content, agent context) to restore later. Like VM snapshots but for AI workspaces.

```
┌─────────────────────────────────────────┐
│ Sessions                           [+]  │
├─────────────────────────────────────────┤
│ 📁 Weather App Project                  │
│    Last active: 2 hours ago             │
│    3 screens, 7 windows                 │
│    [Resume] [Clone] [Delete]            │
│                                         │
│ 📁 Code Review: PR #123                 │
│    Last active: Yesterday               │
│    1 screen, 2 windows                  │
│    [Resume] [Clone] [Delete]            │
│                                         │
│ 📁 Debug Session                        │
│    Last active: 3 days ago              │
│    2 screens, 4 windows                 │
│    [Resume] [Clone] [Delete]            │
└─────────────────────────────────────────┘
```

**What Gets Saved**:
```typescript
interface SessionSnapshot {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date

  // UI State
  screens: ScreenState[]
  windows: WindowModel[]
  activeScreenId: string

  // Agent State
  contextTape: Message[]        // Full conversation history
  agentStates: AgentState[]     // Agent configs and assignments

  // App State
  appConfigs: Record<string, unknown>  // Per-app credentials/settings
}
```

**Implementation**:
- [ ] Snapshot serialization (Zustand → JSON)
- [ ] Server-side snapshot storage (SQLite or filesystem)
- [ ] Snapshot management API endpoints
- [ ] Restore flow with conflict resolution
- [ ] Auto-snapshot on disconnect/close

### Killer Feature: Context Warm Loading

**Concept**: When server restarts or user reconnects, automatically restore the previous session with AI context intact.

**Flow**:
```
Server Start
    │
    ▼
Load latest session snapshot
    │
    ▼
Pre-warm AI providers with context
    │
    ▼
User connects → Instant restoration
    │
    ▼
"Welcome back! Resuming where you left off..."
```

**Implementation**:
- [ ] Detect clean vs crash shutdown
- [ ] Automatic snapshot on graceful shutdown
- [ ] Context replay on provider initialization
- [ ] UI restoration from snapshot
- [ ] Diff-based updates (only send changed state)

### Nice-to-Have: Session Branching

- Fork a session to explore alternative approaches
- Compare branches side-by-side
- Merge successful branches back

---

## Phase 4: Advanced Window Features

### Killer Feature: Window Linking

**Concept**: Link windows so actions in one affect another. Example: Code editor linked to terminal - saving file auto-runs tests.

```
┌──────────────────┐      ┌──────────────────┐
│  editor.ts       │ ───► │  Terminal        │
│                  │ save │  $ pnpm test     │
│  function foo()  │      │  ✓ 5 tests pass  │
└──────────────────┘      └──────────────────┘
        │
        └──────────────────────┐
                               ▼
                    ┌──────────────────┐
                    │  Preview         │
                    │  [Live Reload]   │
                    └──────────────────┘
```

**Implementation**:
- [ ] `window.link` action with trigger/action pairs
- [ ] Link types: data flow, event propagation, sync scroll
- [ ] Visual link indicators (lines between windows)
- [ ] Link management UI

### Killer Feature: Smart Window Layouts

**Concept**: AI-suggested window arrangements based on task type.

**Layouts**:
- **Development**: Editor (60%) + Terminal (20%) + Preview (20%)
- **Research**: Browser (50%) + Notes (50%)
- **Code Review**: Diff (70%) + Comments (30%)
- **Planning**: Task Board (full screen)

**Implementation**:
- [ ] Layout templates as window arrangement presets
- [ ] `layout.apply` action
- [ ] AI learns preferred layouts from user behavior
- [ ] Context-aware layout suggestions

### Nice-to-Have: Window Tabs

- Group related windows into tabbed containers
- Drag to combine/separate
- Tab groups persist across sessions

---

## Phase 5: Enhanced Agent Capabilities

### Killer Feature: Tool Pipelines

**Concept**: Chain tools together declaratively. Output of one becomes input of next.

```typescript
// Instead of multiple tool calls:
pipeline([
  { tool: 'read_file', args: { path: 'data.json' } },
  { tool: 'transform', args: { jq: '.users[]' } },
  { tool: 'window.create', args: { content: '$previous' } }
])
```

**Benefits**:
- Fewer round-trips
- Atomic execution
- Easier error handling
- Reusable patterns

### Killer Feature: Agent Memory

**Concept**: Persistent memory that survives sessions. Agent remembers user preferences, past decisions, common patterns.

```
┌─────────────────────────────────────────┐
│ Agent Memory                            │
├─────────────────────────────────────────┤
│ User Preferences:                       │
│ • Prefers TypeScript over JavaScript    │
│ • Uses pnpm, not npm                    │
│ • Dark theme for code windows           │
│                                         │
│ Project Context:                        │
│ • Main branch: master                   │
│ • Test command: pnpm test               │
│ • Deploy: Vercel                        │
│                                         │
│ Past Decisions:                         │
│ • Chose Zustand over Redux (Jan 15)     │
│ • Preferred Tailwind classes (Jan 10)   │
└─────────────────────────────────────────┘
```

**Implementation**:
- [ ] Memory store (vector DB or structured JSON)
- [ ] Memory injection into system prompts
- [ ] Memory update triggers (explicit save or auto-detect)
- [ ] Memory management UI (view, edit, delete)

### Nice-to-Have: Agent Personas

- Named agents with distinct personalities/expertise
- "Ask the Security Agent to review this"
- Agents can disagree and discuss

---

## Phase 6: Collaboration Features

### Killer Feature: Multiplayer Mode

**Concept**: Multiple users sharing the same workspace. Each user has their cursor, can type in shared input, see each other's windows.

```
┌─────────────────────────────────────────────┐
│ YAAR - Shared Workspace                 │
│ 👤 Alice  👤 Bob  🤖 Claude                 │
├─────────────────────────────────────────────┤
│                                             │
│   ┌──────────────┐  ┌──────────────┐       │
│   │ Alice's Code │  │ Bob's Notes  │       │
│   │ 👤           │  │        👤    │       │
│   └──────────────┘  └──────────────┘       │
│                                             │
│   ┌────────────────────────────────┐       │
│   │ Shared Terminal (all can type) │       │
│   │ $ 👤 Alice: pnpm build         │       │
│   └────────────────────────────────┘       │
│                                             │
│ [Alice is typing...] [Claude is thinking]   │
└─────────────────────────────────────────────┘
```

**Implementation**:
- [ ] User identity and authentication
- [ ] Presence indicators (cursors, avatars)
- [ ] Window permissions (private, shared, view-only)
- [ ] Shared input with turn management
- [ ] Conflict-free replicated data types (CRDTs)

### Nice-to-Have: Async Handoff

- Leave a task for the AI to complete overnight
- AI sends notification when done
- Review and approve changes in the morning

---

## Phase 7: Developer Experience

### Killer Feature: Custom Window Components

**Concept**: Users can create custom React components that render in windows. Like VS Code extensions but for YAAR.

```typescript
// user-components/chart.tsx
export default function ChartWindow({ data }) {
  return <LineChart data={data} />
}

// AI can then:
window.create({
  content: {
    renderer: 'user-component',
    component: 'chart',
    props: { data: [...] }
  }
})
```

**Implementation**:
- [ ] Component registration API
- [ ] Hot-reload for development
- [ ] Component marketplace
- [ ] Sandboxed execution

### Nice-to-Have: Scriptable Automations

- User-defined automations in JavaScript/TypeScript
- Trigger on events (window open, file save, etc.)
- Access to full OS Action API

---

## Implementation Priority

### Immediate (This Week)
1. **Agent Window Indicators** - Visual distinction for agent-owned windows (icon, status in title)
2. **Session Snapshots** - Critical for context persistence

### Short Term (This Month)
3. **Agent Conductor Tools** - `conductor_spawn_agent`, `conductor_message_agent`, etc.
4. **Context Warm Loading** - Seamless restart experience
5. **Agent Status Bar** - Compact visibility into all agents

### Medium Term (This Quarter)
6. **@mention Routing** - Direct messages to specific agents
7. **Window Linking** - Power user productivity
8. **Agent Memory** - Personalized experience
9. **Smart Layouts** - Auto-tile agent windows

### Long Term (Future)
10. **Multiplayer Mode** - Collaboration
11. **Custom Components** - Extensibility
12. **Tool Pipelines** - Performance optimization
13. **Virtual Screens** - Optional user organization (lower priority)

---

## Technical Debt to Address

Before major features:
- [ ] Token counting for context management
- [ ] Automatic context pruning when approaching limits
- [ ] Frontend state persistence (localStorage baseline)
- [ ] Error boundaries for window rendering
- [ ] Rate limiting for agent spawning
- [ ] Resource quotas per agent/screen

---

## Success Metrics

| Feature | Metric | Target |
|---------|--------|--------|
| Multi-Screen | Avg screens per session | 2-3 |
| Context Restore | Restore time | <2 seconds |
| Agent Conductor | Tasks completed autonomously | 80%+ |
| Session Snapshots | Sessions resumed vs abandoned | 70%+ |
| Memory | User preference accuracy | 90%+ |

---

## Open Questions

1. **Screen limits**: How many screens before performance degrades?
2. **Agent coordination**: How do agents negotiate conflicting changes?
3. **Context limits**: What's the max context size before quality drops?
4. **Snapshot size**: How to handle large snapshots efficiently?
5. **Security**: How to sandbox user-created components?

---

*Last updated: 2026-01-31*
