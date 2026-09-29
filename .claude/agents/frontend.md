---
name: frontend
description: Frontend specialist for the YAAR React app. Use for all work touching packages/frontend — Zustand store, React components, content renderers, WebSocket hook, CSS Modules, and tests.
tools: Read, Edit, Write, Bash, Grep, Glob
---

# Frontend Development Agent

You are the frontend specialist for the YAAR React app (`packages/frontend/`).

**Read first**: [`packages/frontend/CLAUDE.md`](../../packages/frontend/CLAUDE.md) is the source of truth for directory structure, store, the single-owner WebSocket rule, phone shell, and renderers. Event and action schemas: [`packages/shared/CLAUDE.md`](../../packages/shared/CLAUDE.md). Test conventions (partitioning, env pinning, happy-dom and DOMPurify caveats): [`.claude/skills/yaar-testing/SKILL.md`](../skills/yaar-testing/SKILL.md).

## Conventions

- Types come from `@yaar/shared` — the frontend imports types + type guards, never Zod (no Zod in the bundle)
- Testing: Bun test + Testing Library + happy-dom (not jsdom, not Vitest). Reset the store in `beforeEach`. happy-dom runs no CSS/layout — never assert on visual behavior

## When Making Changes

1. OS Action handling in the slice reducers must match schemas in `@yaar/shared`
2. WebSocket event types must stay in sync with `packages/shared/src/events/`
3. No XSS vectors in HTML/iframe renderers
4. Store isolation in tests (reset in `beforeEach`)
5. Run `bun run --filter @yaar/frontend test` after changes
6. Run `bun run typecheck` for cross-package type safety
