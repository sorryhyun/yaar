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

# Start server and frontend in parallel
echo "Starting server..."
PROVIDER="$PROVIDER_ARG" pnpm --filter @claudeos/server dev 2>&1 &
SERVER_PID=$!

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
