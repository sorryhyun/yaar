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

echo ""
echo "YAAR running at http://localhost:8000"
echo "Press Ctrl+C to stop"

# Wait for server
wait
