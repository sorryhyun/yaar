.PHONY: dev server frontend install lint typecheck build clean

# Run both server and frontend
dev:
	@./scripts/dev.sh

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

# Type check all packages
typecheck:
	pnpm -r typecheck

# Build all packages
build:
	pnpm -r build

# Clean generated files
clean:
	rm -rf packages/*/dist packages/*/node_modules node_modules
