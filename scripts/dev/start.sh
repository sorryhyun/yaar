#!/bin/bash
# Start development environment
# Single-port architecture: server builds and serves frontend on port 8000

set -e

cd "$(dirname "$0")/../.."

# Parse provider argument
PROVIDER_ARG=""
if [ -n "$1" ]; then
  PROVIDER_ARG="$1"
  echo "Using provider: $PROVIDER_ARG"
fi

# Pick a free port up front so the server, the browser tab we open, and the
# "running at" banner all agree. The server has its own EADDRINUSE fallback, but
# dev/start.sh can't see which port it landed on — so if 8000 is busy the server would
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

# In remote mode every endpoint needs the remote token, so the tab we open has to carry
# it as `#remote=<token>` or it lands on the connection dialog. The token is normally
# minted inside the server, which is too late for us and unreadable from here anyway
# (the endpoint that would report it is behind the same token). So mint it *here* and let
# the server adopt it via YAAR_REMOTE_TOKEN — the URL is then known before the server
# starts. Honors an externally-set value, so a caller can pin the token.
if [ -n "$REMOTE" ] && [ "$REMOTE" != "0" ] && [ -z "${YAAR_REMOTE_TOKEN:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    YAAR_REMOTE_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  else
    # base64url alphabet only — this rides in a URL fragment.
    YAAR_REMOTE_TOKEN="$(LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c 43)"
  fi
  export YAAR_REMOTE_TOKEN
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
CHROME_PIDFILE=""

# Kill a Chrome this script started in a previous run but never cleaned up —
# e.g. the terminal/pane was closed (SIGHUP), the shell was force-killed, or the
# server died and `wait` returned, none of which the old INT/TERM-only trap
# caught. Mirrors cleanupStaleChrome() in lib/browser for the headless sandbox
# Chrome; the frontend (.yaar-chrome, port 9222) Chrome otherwise had no
# orphan-reaping at all — and because the next run *reuses* an existing profile
# instance (open-a-tab handoff), the orphan would persist across runs forever.
reap_stale_chrome() {
  local pidfile="$1" port="$2"
  [ -f "$pidfile" ] || return 0
  local pid cmd
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  rm -f "$pidfile" 2>/dev/null || true
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  # Only kill if the live PID is really our debuggable Chrome — a recycled PID
  # could now belong to something unrelated.
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *"remote-debugging-port=$port"*) ;;
    *) return 0 ;;
  esac
  echo "[chrome] Reaping stale Chrome from a previous run (PID ${pid})"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -KILL "$pid" 2>/dev/null || true
}

launch_chrome_when_ready() {
  [ "${LAUNCH_CHROME:-0}" = "1" ] || return 0

  # Look on PATH first (Linux), then fall back to the standard macOS app-bundle
  # and Windows install locations — on macOS Chrome lives inside /Applications
  # and is not on PATH; on Windows (Git Bash) it lives under Program Files.
  local bin
  bin="$(command -v google-chrome || command -v google-chrome-stable \
    || command -v chromium-browser || command -v chromium || true)"
  if [ -z "$bin" ]; then
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium" \
      "$HOME/Applications/Chromium.app/Contents/MacOS/Chromium" \
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
      "${PROGRAMFILES:-}/Google/Chrome/Application/chrome.exe" \
      "${LOCALAPPDATA:-}/Google/Chrome/Application/chrome.exe"; do
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
  # Record the fresh-launched Chrome's PID so a future run can reap it (see
  # reap_stale_chrome). Derive the pidfile from the *unix* profile path, before
  # any cygpath conversion, so bash can read/write it on Git Bash too.
  local pidfile="${profile}.pid"
  CHROME_PIDFILE="$pidfile"
  reap_stale_chrome "$pidfile" "$port"
  # chrome.exe can't interpret MSYS /c/... paths — convert on Git Bash.
  command -v cygpath >/dev/null 2>&1 && profile="$(cygpath -w "$profile")"
  # Two URLs, deliberately: the readiness probe must stay a bare origin (a fragment is
  # client-side only, but the token would end up in curl's argv for no benefit), while the
  # tab we hand to Chrome carries the token so remote mode opens a live desktop instead of
  # the connection dialog. Always localhost, never the tunnel/LAN address — this browser is
  # on the same machine as the server.
  local url="http://localhost:${PORT:-8000}"
  local open_url="$url"
  [ -n "${YAAR_REMOTE_TOKEN:-}" ] && open_url="${url}/#remote=${YAAR_REMOTE_TOKEN}"

  # WebGPU is off by default in Linux Chrome (its Vulkan backend is
  # soft-blocklisted), which breaks yaar-ml/anima inference with "Failed to get
  # GPU adapter". Opt in here — Windows/macOS enable WebGPU out of the box.
  # The Dawn toggle vulkan_enable_f16_on_nvidia lifts Dawn's NVIDIA-wide hold
  # on shader-f16 (crbug.com/42251215) — without it fp16 models fail on Linux
  # while working on Windows/macOS; it's ignored on non-NVIDIA GPUs. Dawn
  # toggles have no chrome://flags entry, so the command line is the only way
  # to set it — which is why this lives here and not in setup-webgpu-linux.sh.
  # Only takes effect when this actually starts a new Chrome: if one with this
  # profile is already running, close it and re-run to pick up the flags.
  # Keep in sync with LINUX_WEBGPU_FLAGS in
  # packages/server/src/lib/browser/webgpu-flags.ts, which the exe's launcher uses —
  # bash cannot import it, so this is a copy. They disagreed once already: the exe
  # shipped with no GPU flags at all, so WebGPU worked under `make claude-dev` and not
  # under `yaar`, on the same machine.
  local gpu_flags=()
  [ "$(uname -s)" = "Linux" ] && gpu_flags=(--enable-unsafe-webgpu --enable-features=Vulkan
    --enable-dawn-features=vulkan_enable_f16_on_nvidia)

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
      --no-first-run --no-default-browser-check "${gpu_flags[@]}" "${open_url}" >/dev/null 2>&1
  ) &
  CHROME_PID=$!
  # exec (above) replaces the subshell in place, so CHROME_PID becomes the Chrome
  # process itself once it launches — record it so a future run can reap it if
  # this one dies without running cleanup. (If an existing Chrome was reused, the
  # handoff exits immediately and this PID goes dead; the reaper's liveness +
  # command check then skips it.)
  echo "$CHROME_PID" > "$pidfile" 2>/dev/null || true
}

# Cleanup function. Guarded so the EXIT trap can't re-run it after an explicit
# signal (INT/TERM/HUP) already did.
_cleanup_ran=0
cleanup() {
  [ "$_cleanup_ran" = 1 ] && return
  _cleanup_ran=1
  echo ""
  echo "Shutting down..."

  # Kill process groups (negative PID kills the group). SERVER_PID may be unset
  # if we abort during the build steps before the server starts.
  [ -n "$SERVER_PID" ] && kill -TERM -$SERVER_PID 2>/dev/null

  # Give the server time to gracefully stop child processes (e.g. codex app-server)
  sleep 3

  # Force kill if still running
  [ -n "$SERVER_PID" ] && kill -KILL -$SERVER_PID 2>/dev/null

  # Clean up any orphaned codex app-server processes
  pkill -f "codex app-server" 2>/dev/null || true

  # Stop the Chrome waiter / the Chrome we launched. If a pre-existing Chrome was
  # reused, this PID already exited (the open-a-tab handoff returns immediately),
  # so we never kill a browser we didn't start. The profile dir persists, so
  # logins survive across runs.
  [ -n "$CHROME_PID" ] && kill -TERM "$CHROME_PID" 2>/dev/null
  [ -n "$CHROME_PIDFILE" ] && rm -f "$CHROME_PIDFILE" 2>/dev/null

  exit 0
}

# Trap HUP (terminal/pane closed) and EXIT (server died and `wait` returned, or
# `set -e` aborted a build step) in addition to INT/TERM. A plain INT/TERM-only
# trap leaked the frontend Chrome whenever the shell went away without one of
# those two signals — the most common way it happens in practice.
trap cleanup INT TERM HUP EXIT

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
