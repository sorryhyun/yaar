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
pnpm --filter @claudeos/shared build

# Cleanup function
cleanup() {
  echo ""
  echo "Shutting down..."

  # Kill process groups (negative PID kills the group)
  kill -TERM -$SERVER_PID 2>/dev/null
  kill -TERM -$FRONTEND_PID 2>/dev/null

  # Wait briefly for clean shutdown
  sleep 1

  # Force kill if still running
  kill -KILL -$SERVER_PID 2>/dev/null
  kill -KILL -$FRONTEND_PID 2>/dev/null

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
PROVIDER="$PROVIDER_ARG" pnpm --filter @claudeos/server dev 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server to be ready..."
wait_for_server

echo "Starting frontend..."
pnpm --filter @claudeos/frontend dev 2>&1 &
FRONTEND_PID=$!

echo ""
echo "Development servers started:"
echo "  Server:   http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all servers"

# Wait for both processes
wait
