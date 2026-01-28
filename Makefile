.PHONY: dev claude codex server frontend install lint build clean

# Run both server and frontend (auto-select provider)
dev:
	@./scripts/dev.sh

# Run with Claude provider
claude:
	@./scripts/dev.sh claude

# Run with Codex provider
codex:
	@./scripts/dev.sh codex

# Run server only
server:
	pnpm --filter @claudeos/server dev

# Run frontend only
frontend:
	pnpm --filter @claudeos/frontend dev

# Install all dependencies
install:
	pnpm install

# Lint all packages
lint:
	pnpm -r lint

# Build all packages
build:
	pnpm -r build

# Clean generated files
clean:
	rm -rf packages/*/dist packages/*/node_modules node_modules
