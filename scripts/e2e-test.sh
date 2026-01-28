#!/bin/bash
# End-to-end test script for ClaudeOS

set -e

echo "=== ClaudeOS E2E Test ==="

# Check dependencies
echo "Checking dependencies..."
command -v python3 >/dev/null 2>&1 || { echo "Python 3 required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js required"; exit 1; }

# Start backend
echo "Starting backend..."
cd "$(dirname "$0")/.."
uvicorn backend.main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!
sleep 2

# Check backend health
echo "Checking backend health..."
curl -s http://localhost:8000/health | grep -q '"status":"ok"' || {
    echo "Backend health check failed"
    kill $BACKEND_PID 2>/dev/null
    exit 1
}
echo "Backend OK"

# Check providers
echo "Checking providers..."
PROVIDERS=$(curl -s http://localhost:8000/api/providers)
echo "Available providers: $PROVIDERS"

# Start frontend
echo "Starting frontend..."
cd frontend
npm run dev &
FRONTEND_PID=$!
sleep 3

# Check frontend
echo "Checking frontend..."
curl -s http://localhost:5173 | grep -q "ClaudeOS" || {
    echo "Frontend check failed"
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit 1
}
echo "Frontend OK"

echo ""
echo "=== All checks passed ==="
echo "Backend PID: $BACKEND_PID"
echo "Frontend PID: $FRONTEND_PID"
echo ""
echo "Open http://localhost:5173 in your browser"
echo "Press Ctrl+C to stop"

# Wait for interrupt
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT
wait
