# YAAR Design Decisions

## 1. The Agent Workflow Model

- **Codify the monitor vs. window heuristic.** The system prompt has no guidance on when to create a new monitor vs. open a window. We should bake in a clear rule ("new topic = new monitor, subtask = window") or let the user decide explicitly.

- **Surface background monitor progress.** A background agent doing a long task is completely invisible to the user. Pick a pattern and commit: taskbar badge with status, minimized status window, or completion notification.

- **Stale window agents need a strategy.** Window agents get 5 turns of main context on creation, then rely on provider session continuity — no catch-up mechanism. After a long, topic-shifting conversation they go stale. Options: proactive recycling, periodic re-injection of recent main context, or user-triggered refresh.

- **Real-time multi-agent interaction.** Currently agents can only share state through ContextTape and WindowStateRegistry — no direct messaging. A "debate" or "discussion" pattern (agents responding to each other in real-time, not just reading shared files) could be powerful for complex reasoning. The question is implementation: a lightweight message bus between agents? A shared "conversation window" where multiple agents post turns? How to prevent infinite loops and manage turn-taking?

## 2. Window Lifecycle & Behavior

- **Pick a transition strategy for content swaps.** Content changes are instant (Immer swap, no animation). When the AI replaces window content (markdown → iframe, component A → component B), should we add a crossfade, loading skeleton, or is instant-swap the right call?

- **Make capture proactive or leave it opt-in?** Capture is fully on-demand today. Auto-capturing after every user interaction with an iframe app would improve AI situational awareness but costs latency and tokens. Where's the right trigger point?

## 3. Interaction Design

- **Make steering visible.** `MESSAGE_ACCEPTED` and `MESSAGE_QUEUED` events exist on the wire but the frontend shows nothing. Users have no idea if their mid-turn message was injected (steering), queued, or went to an ephemeral agent. Even a subtle indicator would help.

- **Promote drawing to first-class.** Drawing/annotation works but isn't window-aware. It should support: annotating a specific window, circling something to ask "what's this?", sketching a layout the AI interprets as a window arrangement.

## 4. The Verb & Tool Interface

- **Audit verb reliability.** 5 generic verbs replaced ~30 named tools. Error handling is solid (lock checks, timeouts, CSP detection), but we should measure: how often does the AI pick the wrong verb or miss parameters? If failure rates are high, auto-generate cheat-sheet shortcuts in the system prompt.

## 5. The App Model

- **Plan for SKILL.md at scale.** 19 apps today, system prompt already long. At 50+ apps we need a strategy: short summaries of all apps for ambient awareness + full SKILL.md loaded on demand? Or something smarter?

- **Design inter-app communication.** "Open PDF viewer with this file from storage" requires the AI to orchestrate manually. File associations or intent-like patterns could make this automatic. Worth building, or is AI orchestration good enough?

## 6. Context & Coherence

- **Improve pruning beyond the 200-message cutoff.** Pruning keeps the latest 100 messages but doesn't pin system messages or the user's initial goal. We could lose critical context silently. At minimum: pin important messages. Better: summarize old context instead of discarding.

- **Build context summarization.** Periodically have the AI produce a conversation summary that replaces raw history — memory consolidation. This is the single highest-leverage improvement for long sessions.

- **Make window context injection tunable.** The 5-turn limit is hardcoded in `ContextAssemblyPolicy` constructor. This should be configurable per window type or use case — a complex app window needs more context than a simple display.

## 7. OS Metaphor & Identity

- **Audit the OS vocabulary.** "Monitors" may confuse users. "Workspaces" or "desktops" might land better. The metaphor should serve the user, not the architecture.

- **Make input contextual.** A single global input field gets limiting with many windows. Typing while a window is focused should default to that window's agent. The global input becomes the "desktop" channel.

- **Design progressive disclosure.** New users see a blank desktop + input. Power users have 4 monitors, 15 windows, background agents. The ramp between these shouldn't be a cliff.

## 8. Resilience & Recovery

- **Add provider degradation UX.** No circuit breaker or explicit timeout — if the AI provider is slow, the user stares at a locked window. Add a visible "AI is slow, request pending" state with cancel option.

- **Make reconnection more patient.** Fixed 3s delay, 5 attempts, linear — gives up after 15s. Server restart can take 30s. Use exponential backoff and show a "reconnecting..." UI that lets the user wait indefinitely.

## 9. Future Directions

- **Cross-window pub/sub.** Let windows communicate directly (data-viewer reacts to control-panel filter change) without routing through the main agent.

- **Session branching.** Fork a session at any point, like `git branch` for conversations. High value for exploration-heavy workflows.

- **Proactive AI.** Useful proactive behaviors: noticing stale window content, suggesting relevant apps, pre-fetching likely next actions. Start small with one trigger and see if users like it.

- **Warm pool for window agents.** Only the first main agent is pre-warmed. When the AI is about to open a window, warm a provider in parallel for instant window agent response.

- **App marketplace trust model.** As third-party apps grow: sandboxing + permission scopes + review, or "local install = full trust" permanently?
