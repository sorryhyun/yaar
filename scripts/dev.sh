#!/bin/bash
# Start development environment
# Single-port architecture: server builds and serves frontend on port 8000

set -e

cd "$(dirname "$0")/.."

# Parse provider argument
PROVIDER_ARG=""
if [ -n "$1" ]; then
  PROVIDER_ARG="$1"
  echo "Using provider: $PROVIDER_ARG"
fi

# Build shared and compiler packages first (needed by other packages)
echo "Building shared package..."
bun run --filter @yaar/shared build
echo "Building compiler package..."
bun run --filter @yaar/compiler build

# Optionally launch a local Chrome with remote debugging, opened on the YAAR
# desktop, so (a) you don't have to navigate to it by hand and (b) the session
# agent's real-browser door (yaar://session/browser) can attach. Opt in with
# LAUNCH_CHROME=1 (set by `make claude-dev`). No-op on headless/cloud boxes
# without a Chrome binary. Backgrounds itself: waits for the server, then opens
# the URL (which also brings the debug port up).
CHROME_PID=""
launch_chrome_when_ready() {
  [ "${LAUNCH_CHROME:-0}" = "1" ] || return 0

  local bin
  bin="$(command -v google-chrome || command -v google-chrome-stable \
    || command -v chromium-browser || command -v chromium || true)"
  if [ -z "$bin" ]; then
    echo "[chrome] No Chrome/Chromium on PATH — skipping local browser launch"
    return 0
  fi

  local port="${CHROME_DEBUG_PORT:-9222}"
  # A non-default profile is mandatory: Chrome refuses remote debugging on the
  # default profile (the one holding your real logins).
  local profile="${YAAR_CHROME_PROFILE:-$HOME/.yaar-chrome}"
  local url="http://localhost:${PORT:-8000}"

  (
    # Wait up to ~60s for the server to start answering before opening the tab.
    for _ in $(seq 1 120); do
      curl -s --max-time 1 "${url}" >/dev/null 2>&1 && break
      sleep 0.5
    done
    echo "[chrome] Opening ${url} (port ${port}, profile ${profile})"
    # If a Chrome with this profile is already running, this just opens a tab in
    # it and exits; otherwise it starts a fresh instance with the debug port.
    exec "$bin" --remote-debugging-port="${port}" --user-data-dir="${profile}" \
      --no-first-run --no-default-browser-check "${url}" >/dev/null 2>&1
  ) &
  CHROME_PID=$!
}

# Cleanup function
cleanup() {
  echo ""
  echo "Shutting down..."

  # Kill process groups (negative PID kills the group)
  kill -TERM -$SERVER_PID 2>/dev/null

  # Give the server time to gracefully stop child processes (e.g. codex app-server)
  sleep 3

  # Force kill if still running
  kill -KILL -$SERVER_PID 2>/dev/null

  # Clean up any orphaned codex app-server processes
  pkill -f "codex app-server" 2>/dev/null || true

  # Stop the Chrome waiter / the Chrome we launched. If a pre-existing Chrome was
  # reused, this PID already exited (the open-a-tab handoff returns immediately),
  # so we never kill a browser we didn't start. The profile dir persists, so
  # logins survive across runs.
  [ -n "$CHROME_PID" ] && kill -TERM "$CHROME_PID" 2>/dev/null

  exit 0
}

trap cleanup INT TERM

# Enable job control for process groups
set -m

# In remote mode, build frontend once (production build served by server)
if [ -n "$REMOTE" ] && [ "$REMOTE" != "0" ]; then
  echo "Building frontend for remote mode..."
  bun run --filter @yaar/frontend build
fi

# Start server (in dev mode, server builds + watches frontend automatically)
echo "Starting server..."
PROVIDER="$PROVIDER_ARG" REMOTE="${REMOTE:-}" bun run --filter @yaar/server dev --elide-lines=0 2>&1 &
SERVER_PID=$!

# Open a local debuggable Chrome on the YAAR desktop once the server is up (opt-in).
launch_chrome_when_ready

echo ""
echo "YAAR running at http://localhost:8000"
echo "Press Ctrl+C to stop"

# Wait for server
wait
