#!/bin/bash
# Start development environment

set -e

cd "$(dirname "$0")/.."

# Parse provider argument
PROVIDER_ARG=""
if [ -n "$1" ]; then
  PROVIDER_ARG="$1"
  echo "Using provider: $PROVIDER_ARG"
fi

# Build shared package first (needed by other packages)
echo "Building shared package..."
bun run --filter @yaar/shared build

# Cleanup function
cleanup() {
  echo ""
  echo "Shutting down..."

  # Kill process groups (negative PID kills the group)
  kill -TERM -$SERVER_PID 2>/dev/null
  if [ -n "$FRONTEND_PID" ]; then
    kill -TERM -$FRONTEND_PID 2>/dev/null
  fi

  # Give the server time to gracefully stop child processes (e.g. codex app-server)
  sleep 3

  # Force kill if still running
  kill -KILL -$SERVER_PID 2>/dev/null
  if [ -n "$FRONTEND_PID" ]; then
    kill -KILL -$FRONTEND_PID 2>/dev/null
  fi

  # Clean up any orphaned codex app-server processes
  pkill -f "codex app-server" 2>/dev/null || true

  exit 0
}

trap cleanup INT TERM

# Enable job control for process groups
set -m

# Function to wait for server health endpoint
wait_for_server() {
  local max_attempts=30
  local attempt=0

  while [ $attempt -lt $max_attempts ]; do
    if curl -s http://localhost:8000/health > /dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done

  echo "Warning: Server did not become ready in time"
  return 1
}

# Start server first
echo "Starting server..."
PROVIDER="$PROVIDER_ARG" REMOTE="${REMOTE:-}" bun run --filter @yaar/server dev --elide-lines=0 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server to be ready..."
wait_for_server

if [ -n "$REMOTE" ] && [ "$REMOTE" != "0" ]; then
  # Remote mode: build frontend and serve from server (single port 8000)
  echo "Building frontend for remote mode..."
  bun run --filter @yaar/frontend build
  FRONTEND_PID=""

  echo ""
  echo "Remote mode ready — everything served from port 8000"
  echo "Open the URL or scan the QR code printed above."
  echo ""
  echo "Press Ctrl+C to stop"
else
  # Dev mode: start Vite dev server
  echo "Starting frontend..."
  bun run --filter @yaar/frontend dev 2>&1 &
  FRONTEND_PID=$!

  echo ""
  echo "Development servers started:"
  echo "  Server:   http://localhost:8000"
  echo "  Frontend: http://localhost:5173"
  echo ""
  echo "Press Ctrl+C to stop all servers"
fi

# Wait for server (and frontend if running)
wait
