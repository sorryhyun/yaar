# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeOS is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show toasts, etc.).

## Commands

### Backend (Python)
```bash
uv sync                          # Install dependencies
uv run uvicorn backend.main:app --reload  # Start dev server (port 8000)
uv run pytest                    # Run all tests
uv run pytest backend/providers/test_factory.py  # Run specific test file
uv run pytest -k "test_name"     # Run tests matching pattern
uv run ruff check backend        # Lint
uv run ruff format backend       # Format
uv run mypy backend              # Type check
```

### Frontend (Node.js)
```bash
cd frontend
npm install                      # Install dependencies
npm run dev                      # Start dev server (port 5173)
npm run build                    # Build for production
npm run lint                     # ESLint
npm run typecheck                # TypeScript check
```

## Architecture

```
User Input → WebSocket → FastAPI Backend → AI Provider → OS Actions → Frontend Renders UI
```

### Three-Layer Design

1. **Frontend** (React + Zustand + Vite): Renders windows/toasts based on OS Actions. Vite proxies `/ws` to `ws://localhost:8000` and `/api` to `http://localhost:8000`.

2. **Backend** (FastAPI): WebSocket server that connects frontend to AI providers. Entry point: `backend/main.py`.

3. **Provider Abstraction** (`backend/providers/`): Pluggable AI backends (Claude Code CLI, Codex CLI).

### Provider System

- `base.py` - Abstract interfaces: `AIProvider`, `AIClient`, `AIStreamParser`, `ParsedStreamMessage`
- `factory.py` - Singleton provider factory with availability checking and fallback selection
- `platform_support.py` - Cross-platform binary detection (bundled binaries in `bundled/` take priority)
- `claude/`, `codex/` - Provider implementations (currently stubs)

### OS Actions DSL

AI controls UI through actions like:
- `window.create`, `window.setContent`, `window.close`, `window.focus`
- `toast.show`, `notification.show`

Content types: `markdown`, `table`, `text`, `html`

## Key Files

- `backend/main.py` - FastAPI app with CORS configured for localhost:5173
- `backend/providers/base.py` - Core interfaces all providers implement
- `frontend/vite.config.ts` - Dev server config with WebSocket/API proxy
- `frontend/src/App.tsx` - Root React component
- `shared/schemas/` - OS Actions DSL schema definitions

## Code Style

- Backend: ruff formatting, mypy strict mode, line length 100
- Frontend: TypeScript strict mode, path alias `@/` → `src/`
- Use `pytest-asyncio` with `asyncio_mode = "auto"` for async tests
