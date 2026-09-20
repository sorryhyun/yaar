.PHONY: dev claude codex claude-dev claude-dev-mobile codex-dev termux claude-windows codex-windows server install lint build build-exe clean test test-frontend test-server test-shared test-lib test-integration bench claude-bench codex-types design design-preview

# GNU make on Windows runs recipes with cmd.exe by default, which can't parse
# the POSIX `VAR=1 ./script.sh` lines below. Route recipes through Git Bash
# (ships with Git for Windows) instead.
ifeq ($(OS),Windows_NT)
SHELL := C:/Program Files/Git/bin/bash.exe
endif

# Codex CLI binary (override with: make codex-types CODEX_BIN=./my-codex)
CODEX_BIN ?= codex
DESIGN_PREVIEW_PORT ?= 4321

# Run both server and frontend (auto-select provider)
dev:
	@./scripts/dev/start.sh

# Run with Claude provider (remote mode - accessible over network with auth)
# LAUNCH_CHROME=1 opens the local desktop for you, as in claude-dev — in remote mode the
# tab carries #remote=<token> so it connects without a manual paste.
claude:
	@REMOTE=1 LAUNCH_CHROME=1 ./scripts/dev/start.sh claude

# Run with Codex provider (remote mode - accessible over network with auth)
codex:
	@REMOTE=1 LAUNCH_CHROME=1 ./scripts/dev/start.sh codex

# Run with Claude provider in app window (simulates exe from source)
claude-windows:
	@powershell -ExecutionPolicy Bypass -File scripts/dev/start-windows.ps1 -Provider claude

# Run with Codex provider in app window (simulates exe from source)
codex-windows:
	@powershell -ExecutionPolicy Bypass -File scripts/dev/start-windows.ps1 -Provider codex

# Run with Claude provider (dev mode - no MCP auth)
# LAUNCH_CHROME=1 starts a local debuggable Chrome (dedicated profile) so the
# session agent's real-browser door (yaar://session/browser) can attach.
claude-dev:
	@MCP_SKIP_AUTH=1 LAUNCH_CHROME=1 ./scripts/dev/start.sh claude

# Same, but the browser is a phone: a phone-shaped window on its own Chrome profile,
# with mouse drags arriving as touch events so the phone gestures actually work on a
# PC. No ?ui= pin — a coarse pointer in a narrow window is what the shell's own media
# query asks for, so a desktop layout here means the emulation did not land.
# Size it with YAAR_MOBILE_VIEWPORT=WxH (default 412x915). MOBILE=1 works on any of
# the targets above: MOBILE=1 make codex-dev.
claude-dev-mobile:
	@MOBILE=1 MCP_SKIP_AUTH=1 LAUNCH_CHROME=1 ./scripts/dev/start.sh claude

# Run with Claude provider on Android (Termux): unpacks the SDK's claude binary to JS
# so the Android build of Bun can run it. See scripts/dev/start-termux.sh.
termux:
	@./scripts/dev/start-termux.sh

# Run with Codex provider (dev mode - no MCP auth)
codex-dev:
	@MCP_SKIP_AUTH=1 LAUNCH_CHROME=1 ./scripts/dev/start.sh codex

# Run server only (also serves frontend in dev mode)
server:
	bun run --filter @yaar/server dev

# Install all dependencies
install:
	bun install
	@./scripts/dev/setup-webgpu-linux.sh

# Enable WebGPU in local Chrome/Chromium profiles (Linux only; no-op elsewhere)
webgpu:
	@./scripts/dev/setup-webgpu-linux.sh

# Lint all packages
lint:
	bun run --filter '*' lint

# Build all packages
build:
	bun run --filter '*' build

# Run all tests
test:
	bun run test

# Run frontend tests
test-frontend:
	bun run --filter @yaar/frontend test

# Run server tests
test-server:
	bun run --filter @yaar/server test

# Run shared tests
test-shared:
	bun run --filter @yaar/shared test

# Run lib tests (packages/lib/ — the bytes-in/bytes-out utilities)
test-lib:
	bun run --filter @yaar/lib test

# Run integration/security tests (packages/tests/)
test-integration:
	bun run --filter @yaar/tests test

# Run performance benchmarks (packages/tests/src/benchmarks/)
bench:
	bun run --filter @yaar/tests bench

# CPU/memory benchmark: launch a Claude session under Bun's profiler, drive a
# headless Chrome to open apps, sample the whole process tree per phase, and
# write bench/report.md. Override apps: make claude-bench APPS=market-apps,memo
claude-bench:
	@bun scripts/bench/claude.ts $(if $(APPS),--apps $(APPS),) $(if $(SETTLE),--settle $(SETTLE),) $(BENCH_ARGS)

# Regenerate Codex app-server TypeScript types
# Post-processes imports to add .js extensions required by ESM resolution
codex-types:
	bun scripts/codegen/codex-types.js $(CODEX_BIN)

# Regenerate design tokens + preview cards from packages/shared/src/design.
# Both generators read the real token module, so neither the browsable previews nor
# the design canvas can drift from what ships. Set YAAR_DESIGN_OUT to build the cards
# somewhere other than dist/ (which agents are denied read access to) before publishing
# the canvas — see docs/architecture/design_system.md.
design:
	bun scripts/codegen/design-tokens.ts
	bun scripts/codegen/design-previews.ts

# Serve the generated preview cards for visual review — no server, no `make dev`.
# file:// is blocked by browser automation, so review over http.
design-preview: design
	@echo "Design previews on http://127.0.0.1:$(DESIGN_PREVIEW_PORT)/previews/ (Ctrl-C to stop)"
	bun x --bun serve dist/design-previews -p $(DESIGN_PREVIEW_PORT)

# Build standalone executables (yaar-{claude,codex}.exe with bundled-libs embedded)
build-exe: codex-types
	bun run build:exe

# Clean generated files
clean:
	rm -rf packages/*/dist packages/*/node_modules node_modules
