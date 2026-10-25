#!/bin/bash
# ============================================================================
# Incident Commander — one-click startup
# Opens each service in its own Terminal tab so you can watch logs live.
# Double-click this file from Finder, or run: ./start.command
# ============================================================================

set -e

REPO="$(cd "$(dirname "$0")" && pwd)"   # the folder this script is in, wherever the repo was cloned
cd "$REPO"

echo ""
echo "============================================================"
echo "  Incident Commander — starting all services"
echo "============================================================"
echo ""

# ---- 1. Make sure Docker Desktop is running -----------------------------
if ! docker info > /dev/null 2>&1; then
  echo "→ starting Docker Desktop (this can take 30-60s the first time)…"
  open -a Docker
  until docker info > /dev/null 2>&1; do
    printf "."
    sleep 2
  done
  echo ""
fi
echo "✓ Docker up"

# ---- 2. Start OPA policy engine ------------------------------------------
docker compose up -d opa > /dev/null 2>&1
echo "✓ OPA policy engine up (Docker container)"

# ---- 3. Clean any stale ports --------------------------------------------
for port in 5173 8000 9001; do
  pids=$(lsof -ti:$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  cleaning stale process on :$port"
    echo "$pids" | xargs kill 2>/dev/null || true
  fi
done

# ---- 4. Spawn each service in its own Terminal tab -----------------------
# osascript talks to Terminal.app to open new tabs.
open_tab() {
  local title="$1"
  local cmd="$2"
  osascript <<APPLESCRIPT
    tell application "Terminal"
      activate
      tell application "System Events" to keystroke "t" using command down
      delay 0.3
      do script "cd \"$REPO\"; echo '── $title ──'; $cmd" in front window
    end tell
APPLESCRIPT
}

echo ""
echo "→ opening 3 Terminal tabs (backend, shop-svc, console)…"

open_tab "Backend :8000" \
  "IC_POLICY_ENABLED=1 IC_EXECUTE_ROLLBACK=1 IC_SHOP_SVC_URL=http://localhost:9001 python3 -m uvicorn server.app:app --port 8000 --log-level warning"

sleep 0.5

open_tab "Target Service :9001" \
  "python3 -m uvicorn mock.shop_svc:app --port 9001 --log-level warning"

sleep 0.5

open_tab "Console :5173" \
  "cd console && npm run dev"

# ---- 5. Wait for the console to be ready, then open the browser ---------
echo ""
echo "→ waiting for console to be ready…"
until curl -s http://localhost:5173/ > /dev/null 2>&1; do
  sleep 1
done
sleep 2

echo "→ opening console in browser…"
open "http://localhost:5173/"

echo ""
echo "============================================================"
echo "  All services running:"
echo "    • Console:        http://localhost:5173/"
echo "    • Backend:        http://localhost:8000/"
echo "    • Target service: http://localhost:9001/"
echo "    • OPA:            http://localhost:8181/ (Docker)"
echo ""
echo "  Next steps in the browser:"
echo "    1. Confirm you are on the LIVE tab"
echo "    2. Click ▶ Start traffic (60 rps)"
echo "    3. Click ⟲ Reset to baseline once, to confirm clean state"
echo "    4. Ready to inject a chaos scenario"
echo ""
echo "  When done, run: ./stop.command"
echo "============================================================"
