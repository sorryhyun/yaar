#!/bin/bash
# Run all tests

set -e

cd "$(dirname "$0")/.."

echo "=== Running Backend Tests ==="
pytest backend/ -v --tb=short

echo ""
echo "=== Running Frontend Tests ==="
cd frontend
npm test -- --watchAll=false

echo ""
echo "=== All Tests Passed ==="
