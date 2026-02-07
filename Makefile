.PHONY: dev claude codex claude-dev codex-dev server frontend install lint build clean test test-frontend test-server test-shared

# Run both server and frontend (auto-select provider)
dev:
	@./scripts/dev.sh

# Run with Claude provider
claude:
	@./scripts/dev.sh claude

# Run with Codex provider
codex:
	@./scripts/dev.sh codex

# Run with Claude provider (dev mode - no MCP auth)
claude-dev:
	@MCP_SKIP_AUTH=1 ./scripts/dev.sh claude

# Run with Codex provider (dev mode - no MCP auth)
codex-dev:
	@MCP_SKIP_AUTH=1 ./scripts/dev.sh codex

# Run server only
server:
	pnpm --filter @yaar/server dev

# Run frontend only
frontend:
	pnpm --filter @yaar/frontend dev

# Install all dependencies
install:
	pnpm install

# Lint all packages
lint:
	pnpm -r lint

# Build all packages
build:
	pnpm -r build

# Run all tests
test:
	pnpm -r test

# Run frontend tests
test-frontend:
	pnpm --filter @yaar/frontend test

# Run server tests
test-server:
	pnpm --filter @yaar/server test

# Run shared tests
test-shared:
	pnpm --filter @yaar/shared test

# Clean generated files
clean:
	rm -rf packages/*/dist packages/*/node_modules node_modules
