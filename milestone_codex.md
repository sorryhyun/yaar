# ClaudeOS Milestones (Codex)

This is an **implementation-first** roadmap: fewer “big ideas”, more shippable increments with clear “done” criteria.

## North Star

Make ClaudeOS feel like a trustworthy “AI desktop”:
- **Observable**: you can always tell *what* the AI is doing and *why*.
- **Interruptible**: you can stop/redirect safely at any moment.
- **Recoverable**: sessions restore cleanly after reload/restart.
- **Extensible**: apps/tools are easy to add without weakening safety.

## Guiding Principles

1. **Ship small, end-to-end slices** (server → shared types → frontend).
2. **Prefer a small, strict OS Actions DSL** over bespoke UI code paths.
3. **Permission by default for risk** (network, filesystem, “deploy”, cross-origin).
4. **Everything replayable** (event log → restore → debug).
5. **Provider-agnostic core** (Claude/Codex are transports; UX should be identical).

---

## Milestone 0 — Safety & Trust Baseline (P0)

**Goal:** make it hard for the AI to surprise the user.

### Deliverables
- [x] **Unify “permission” UX** around `dialog.confirm` (remove/replace legacy `REQUEST_PERMISSION` event path if unused).
- [x] **Tool risk levels** (low/medium/high) surfaced in the dialog copy (e.g. HTTP domain allowlist, app deployment, cross-origin iframe).
- [x] **Remember decisions** (allow once / allow always / deny) persisted via `storage/` (e.g. `storage/permissions.json`).
- [x] **User-visible audit trail**: a “Recent Actions” panel fed from existing debug/event streams (OS Actions + tool progress + confirmations).

### Definition of Done
- “AI asks to do risky thing” always routes through a confirmation UI.
- Decisions are visible, reversible, and persisted.
- No silent cross-origin embedding or new network domains without explicit approval.

---

## Milestone 1 — Sessions: Restore, Replay, and Share (P0)

**Goal:** treat `session_logs/` as a first-class product feature, not just debug output.

### Deliverables
- [ ] **Sessions UI** (a window/app) that:
  - lists sessions (`GET /api/sessions`)
  - opens transcript (`GET /api/sessions/:id/transcript`)
  - restores windows (`POST /api/sessions/:id/restore`)
- [ ] **“Restore last session” on connect** with a user prompt and one-click rollback.
- [ ] **Export/share**: one button to bundle a session into a zip-like artifact (metadata + transcript + messages JSONL) for debugging or collaboration.

### Definition of Done
- A cold refresh can restore the previous workspace in <5 seconds on a typical laptop.
- A restored workspace is clearly labeled as restored (to avoid confusion).

---

## Milestone 2 — Agent UX: Make Work Visible (P1)

**Goal:** reduce ambiguity when multiple agents and windows are active.

### Deliverables
- [ ] **Per-window agent indicator** (badge/border) based on `WINDOW_AGENT_STATUS` + lock owner (`window.lockedBy`).
- [ ] **Agent Activity panel** (expandable from the status bar):
  - running tool name (from `TOOL_PROGRESS`)
  - current state (thinking/responding/idle)
  - queue position hints (from `MESSAGE_QUEUED`)
- [ ] **@mention routing** in the command palette:
  - `@default …`, `@window:<id> …`, `@last …`
  - tab-complete from active agents/windows
- [ ] **Interrupt improvements**:
  - “stop all” + “stop this agent” buttons in the Activity panel
  - consistent UI feedback when interrupts succeed

### Definition of Done
- You can answer: “Which agent is changing this window?” at a glance.
- You can stop the *right* agent without guesswork.

---

## Milestone 3 — App Ecosystem: From Demo to Platform (P1)

**Goal:** turn `apps/` into a real extension system with good DX and guardrails.

### Deliverables
- [ ] **App Manager UI**:
  - show installed apps (from `/api/apps`)
  - show app metadata (`apps/<id>/app.json`)
  - uninstall/disable (new server endpoint + tool)
- [ ] **App Dev “happy path”** window:
  - scaffold → edit → compile → preview → deploy using existing tools (`app_write_ts`, `app_compile`, `app_deploy`)
- [ ] **Iframe hardening**:
  - sandbox-by-default policy + clear exemptions (same-origin vs cross-origin)
  - explicit permission for cross-origin iframes
- [ ] **App ↔ OS bridge (minimal)**:
  - a tiny client SDK for iframe apps to `postMessage` “open window / show toast” requests
  - requests go through the same permission/audit system as tools

### Definition of Done
- A user can create and deploy a small app in <5 minutes with no manual file edits.
- Apps cannot silently escalate privileges (network, OS actions) without confirmation.

---

## Milestone 4 — Hardening: Performance, Quality, and Security (P1/P2)

**Goal:** make the system resilient under real usage (long sessions, many windows, mixed content).

### Deliverables
- [ ] **HTML renderer sanitation** (or strict “trusted-only” gating) to reduce XSS risk.
- [ ] **Error boundaries** around window renderers to prevent UI lockups.
- [ ] **Context budgeting**:
  - token estimates per agent/context branch
  - automatic pruning strategy + user controls (“summarize older context”, “pin this window”)
- [ ] **Contract tests**:
  - OS Actions reducer tests (`@claudeos/frontend`)
  - WebSocket event schema tests (`@claudeos/shared`)
  - session restore snapshot test (restore actions reconstruct window state)

### Definition of Done
- Long sessions do not degrade UX sharply (no runaway memory, no “stuck” agents without UI indication).
- The most important invariants are test-enforced (action schema, restore, locking).

---

## Milestone 5 — Distribution & Operations (P2)

**Goal:** make it easy to run ClaudeOS as a product (not just a dev repo).

### Deliverables
- [ ] **Single-command local install** guide per OS (including poppler for PDF rendering).
- [ ] **Bundled builds** polished:
  - `dist/claudeos` artifacts (Windows/Linux/macOS) plus `public/` + `storage/` layout
  - first-run experience (storage dir creation, provider selection, auth hints)
- [ ] **Operational diagnostics**:
  - “System Info” window (providers available, warm pool stats, storage path, poppler availability)
  - log viewer for server/runtime errors

### Definition of Done
- A new user can go from “download” → “running” in <10 minutes.

---

## Always-On Workstreams (parallel to all milestones)

- **Docs**: keep `README.md`, `docs/common_flow.md`, and tool docs accurate; add “How to debug” and “How to restore sessions”.
- **Design consistency**: standardize window presets and typography; keep a single place for UI tokens.
- **Security posture**: treat cross-origin, raw HTML, and network as high-risk; prefer allowlists.

---

## Suggested Success Metrics

- **Time to first meaningful UI** after message: <1.5s (warm pool helps).
- **Restore time** for last session: <5s, with clear user confirmation.
- **User-visible interrupts**: 99% of interrupts show explicit “stopped”/“canceled” feedback.
- **Permission surprises**: 0 silent network domain additions; 0 silent cross-origin embeddings.

---

## Open Questions (to resolve early)

1. Should `REQUEST_PERMISSION` (ServerEvent) be removed in favor of `dialog.confirm`, or reintroduced with a full response path?
2. What is the canonical “source of truth” for replay/restore: `session_logs/messages.jsonl` or a new snapshot format?
3. How strict should iframe sandboxing be for same-origin apps (current approach is “trusted”)?

---

*Last updated: 2026-01-31*

