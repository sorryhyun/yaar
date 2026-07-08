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

# Pick a free port up front so the server, the browser tab we open, and the
# "running at" banner all agree. The server has its own EADDRINUSE fallback, but
# dev.sh can't see which port it landed on — so if 8000 is busy the server would
# quietly move to 8001 while we still open the browser at 8000 (hitting whatever
# else is on 8000). Choosing here and passing it via PORT (honored by getPort())
# keeps both sides in sync.
port_in_use() {
  # Returns 0 (in use) if something accepts a TCP connect on the port.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&-; return 0; }
  return 1
}
find_free_port() {
  local p base="${1:-8000}"
  for p in $(seq "$base" "$((base + 20))"); do
    port_in_use "$p" || { echo "$p"; return 0; }
  done
  echo "$base" # give up; let the server's own fallback handle it
}
REQUESTED_PORT="${PORT:-8000}"
PORT="$(find_free_port "$REQUESTED_PORT")"
export PORT
if [ "$PORT" != "$REQUESTED_PORT" ]; then
  echo "Port $REQUESTED_PORT in use, using $PORT instead"
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

  # Look on PATH first (Linux), then fall back to the standard macOS app-bundle
  # locations — on macOS Chrome lives inside /Applications and is not on PATH.
  local bin
  bin="$(command -v google-chrome || command -v google-chrome-stable \
    || command -v chromium-browser || command -v chromium || true)"
  if [ -z "$bin" ]; then
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium" \
      "$HOME/Applications/Chromium.app/Contents/MacOS/Chromium" \
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"; do
      if [ -x "$candidate" ]; then
        bin="$candidate"
        break
      fi
    done
  fi
  if [ -z "$bin" ]; then
    echo "[chrome] No Chrome/Chromium found — skipping local browser launch"
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
echo "YAAR running at http://localhost:${PORT}"
echo "Press Ctrl+C to stop"

# Wait for server
wait
