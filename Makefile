.PHONY: dev claude codex claude-dev codex-dev server frontend install lint build build-exe clean test test-frontend test-server test-shared test-integration bench codex-types

# Codex CLI binary (override with: make codex-types CODEX_BIN=./my-codex)
CODEX_BIN ?= codex

# Run both server and frontend (auto-select provider)
dev:
	@./scripts/dev.sh

# Run with Claude provider (remote mode - accessible over network with auth)
claude:
	@REMOTE=1 ./scripts/dev.sh claude

# Run with Codex provider (remote mode - accessible over network with auth)
codex:
	@REMOTE=1 ./scripts/dev.sh codex

# Run with Claude provider (dev mode - no MCP auth)
claude-dev:
	@MCP_SKIP_AUTH=1 ./scripts/dev.sh claude

# Run with Codex provider (dev mode - no MCP auth)
codex-dev:
	@MCP_SKIP_AUTH=1 ./scripts/dev.sh codex

# Run server only
server:
	bun run --filter @yaar/server dev

# Run frontend only
frontend:
	bun run --filter @yaar/frontend dev

# Install all dependencies
install:
	bun install

# Lint all packages
lint:
	bun run --filter '*' lint

# Build all packages
build:
	bun run --filter '*' build

# Run all tests
test:
	bun run --filter '*' test

# Run frontend tests
test-frontend:
	bun run --filter @yaar/frontend test

# Run server tests
test-server:
	bun run --filter @yaar/server test

# Run shared tests
test-shared:
	bun run --filter @yaar/shared test

# Run integration/security tests (packages/tests/)
test-integration:
	bun run --filter @yaar/tests test

# Run performance benchmarks (packages/tests/src/benchmarks/)
bench:
	bun run --filter @yaar/tests bench

# Regenerate Codex app-server TypeScript types
# Post-processes imports to add .js extensions required by ESM resolution
codex-types:
	bun scripts/generate-codex-types.js $(CODEX_BIN)

# Build standalone executables (yaar-{claude,codex}.exe with bundled-libs embedded)
build-exe: codex-types
	bun run build:exe

# Clean generated files
clean:
	rm -rf packages/*/dist packages/*/node_modules node_modules
