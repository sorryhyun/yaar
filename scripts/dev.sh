#!/bin/bash
# Start development environment

set -e

cd "$(dirname "$0")/.."

# Build shared package first (needed by other packages)
echo "Building shared package..."
pnpm --filter @claudeos/shared build

# Start server in background
echo "Starting server..."
pnpm --filter @claudeos/server dev &
SERVER_PID=$!

# Wait for server to start
sleep 2

# Start frontend
echo "Starting frontend..."
pnpm --filter @claudeos/frontend dev &
FRONTEND_PID=$!

echo ""
echo "Development servers started:"
echo "  Server:   http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all servers"

trap "kill $SERVER_PID $FRONTEND_PID 2>/dev/null; exit 0" INT
wait
