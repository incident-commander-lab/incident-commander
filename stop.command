#!/bin/bash
# ============================================================================
# Incident Commander — one-click shutdown
# Kills all services and stops the OPA Docker container.
# Double-click this file from Finder, or run: ./stop.command
# ============================================================================

REPO="$(cd "$(dirname "$0")" && pwd)"   # the folder this script is in, wherever the repo was cloned
cd "$REPO"

echo ""
echo "============================================================"
echo "  Incident Commander — shutting down"
echo "============================================================"
echo ""

echo "→ stopping Python services…"
pkill -f "uvicorn server.app" 2>/dev/null || true
pkill -f "uvicorn mock.shop_svc" 2>/dev/null || true
pkill -f "mock.loadgen" 2>/dev/null || true
pkill -f "ic.slo_detector" 2>/dev/null || true

echo "→ stopping Vite dev server (console)…"
pkill -f "vite.*5173" 2>/dev/null || true

echo "→ force-clearing any stragglers…"
for port in 5173 8000 9001; do
  pids=$(lsof -ti:$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

echo "→ stopping OPA Docker container…"
docker compose stop opa > /dev/null 2>&1 || true

echo ""
echo "============================================================"
echo "  Port check:"
for port in 5173 8000 9001 8181; do
  if lsof -i:$port > /dev/null 2>&1; then
    echo "    :$port  ← STILL LISTENING (something else is using it)"
  else
    echo "    :$port  ✓ free"
  fi
done
echo ""
echo "  All Incident Commander services stopped."
echo "  Docker Desktop is still running (safe to leave, or quit manually)."
echo "============================================================"
echo ""

# Give user a moment to read the output before the Terminal tab closes
sleep 3
