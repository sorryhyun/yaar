#!/usr/bin/env bash
# Start YAAR with the Claude provider on Android (Termux).
#
# The Agent SDK only ships glibc/musl `claude` binaries, which Android's linker refuses
# ("unexpected e_type: 2"), so CLAUDE_CODE_PATH points at the unpacked JS that
# ensure-claude-android.sh leaves in the cache. install.sh already ran that during the
# install, so this is normally a no-op; it earns its keep on a phone that installed some
# other way, or whose SDK has since been bumped. Everything else is start.sh.

set -e

cd "$(dirname "$0")/../.."

if ! bun --version >/dev/null 2>&1; then
  echo "bun does not run here. On Android it must be the bun-linux-*-android build, not the"
  echo "one the bun.sh installer picks:"
  echo "  https://github.com/oven-sh/bun/releases (bun-linux-aarch64-android.zip)"
  exit 1
fi

# Open the desktop, in Chrome when it is installed. The default browser on a Galaxy is
# Samsung Internet, which warns "can't be downloaded securely" on every plain-http download,
# localhost included; Chrome counts loopback as secure and does not. A home-screen app runs
# in the browser that installed it, so this also decides where "Install app" lands.
# YAAR_TERMUX_BROWSER names another package; empty means the default browser.
# termux-open-url is itself just `am start -a VIEW`; `-p` pins the package, and a phone
# without it fails to resolve the intent, which falls through to the default browser.
open_desktop() {
  local url="$1" pkg="${YAAR_TERMUX_BROWSER-com.android.chrome}" user out
  if [ -n "$pkg" ] && command -v am >/dev/null 2>&1; then
    case "${TERMUX__USER_ID:-}" in '' | *[!0-9]* | 0[0-9]*) user=0 ;; *) user="$TERMUX__USER_ID" ;; esac
    if out="$(am start --user "$user" -a android.intent.action.VIEW -d "$url" -p "$pkg" 2>&1)" &&
      ! printf '%s' "$out" | grep -qiE 'error|exception'; then
      return 0
    fi
  fi
  command -v termux-open-url >/dev/null 2>&1 && termux-open-url "$url"
}

# One YAAR per phone. A second launch (a second tap on the home-screen widget, or `yaar` in
# another session) would otherwise get a second server on the next free port, take the wake
# lock again, and — worse — the first one's exit would release the lock under the one still
# running. So if a launch is already up, just bring its desktop forward.
pidfile="${TMPDIR:-/tmp}/yaar-termux.pid"
if [ -f "$pidfile" ]; then
  running_pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$running_pid" ] && kill -0 "$running_pid" 2>/dev/null &&
    tr '\0' ' ' < "/proc/$running_pid/cmdline" 2>/dev/null | grep -q start-termux.sh; then
    echo "YAAR is already running (pid $running_pid) — opening its desktop."
    open_desktop "http://localhost:${PORT:-8000}"
    exit 0
  fi
fi
echo $$ > "$pidfile"
trap 'rm -f "$pidfile"' EXIT

# Install again whenever bun.lock has moved since the last install here, not only on a bare
# checkout: `git pull` alone leaves the old SDK in node_modules, and ensure-claude-android.sh
# reads the version from there, so a bumped SDK would keep running the old unpacked CLI.
stamp=node_modules/.yaar-termux-install
if [ ! -e node_modules/.bin/tsc ] || [ bun.lock -nt "$stamp" ]; then
  bun install
  touch "$stamp"
fi

# A CLAUDE_CODE_PATH from the shell profile (a hand-installed CLI) is honored only while it
# is at least the version the SDK was built against. Older, it fails every turn once the
# code asks for a model it does not know — as a bare 400 — so fall back to the unpacked one.
if [ -n "${CLAUDE_CODE_PATH:-}" ]; then
  want="$(bun -e "console.log(require('./packages/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion ?? '')")"
  have="$("$CLAUDE_CODE_PATH" --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
  if [ -n "$want" ] && { [ -z "$have" ] ||
    [ "$(printf '%s\n%s\n' "$have" "$want" | sort -V | head -1)" != "$want" ]; }; then
    echo "Ignoring CLAUDE_CODE_PATH=$CLAUDE_CODE_PATH (${have:-unknown version}, SDK needs >= $want);"
    echo "  using the SDK's own build instead. Unset it in your shell profile to drop this note."
    unset CLAUDE_CODE_PATH
  fi
fi

if [ -z "${CLAUDE_CODE_PATH:-}" ]; then
  CLAUDE_CODE_PATH="$(./scripts/dev/ensure-claude-android.sh)"
  export CLAUDE_CODE_PATH
fi

# A full `auth login`, not a `setup-token`: the long-lived token is inference-only, and the
# CLI refuses Remote Control with it. Termux is a terminal, so run the login here rather
# than send the user off to find the unpacked binary.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "$HOME/.claude/.credentials.json" ]; then
  if [ ! -t 0 ]; then
    echo "Claude is not logged in. Run \`$CLAUDE_CODE_PATH auth login\`, then retry."
    exit 1
  fi
  echo "Claude is not logged in. Starting \`claude auth login\` — open the URL it prints,"
  echo "approve, and paste the code back here."
  "$CLAUDE_CODE_PATH" auth login
fi

# The CLI prefers the env token over a full login, and refuses Remote Control with it.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "Note: CLAUDE_CODE_OAUTH_TOKEN is inference-only, so Remote Control will be refused."
  echo "  For Remote Control: unset it and run \`$CLAUDE_CODE_PATH auth login\`."
fi

# No debuggable Chrome to launch on a phone; open the desktop in the phone's own browser
# once the server answers instead.
if command -v am >/dev/null 2>&1 || command -v termux-open-url >/dev/null 2>&1; then
  (
    url="http://localhost:${PORT:-8000}"
    for _ in $(seq 1 120); do
      curl -s --max-time 1 "$url" >/dev/null 2>&1 && break
      sleep 0.5
    done
    open_desktop "$url"
  ) &
fi

# The wake lock is what keeps the server alive with the screen off. Without it Android dozes
# Termux within minutes, and a phone that is both client and server loses both at once. It
# comes from termux-tools, which ships with Termux itself, so there is no extra app behind
# it. It is released on exit so a stopped YAAR does not hold the CPU awake. Taken once per
# phone: the single-instance check above means only the launch that owns the pidfile gets here.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock; rm -f "$pidfile"' EXIT
fi

# Termux:API is optional: with it, the server mirrors notifications into the Android shade
# and uses the phone's clipboard and share sheet (features/android/). Without it, nothing
# changes. It is a separate app as well as a package, so only the package can be checked here.
if ! command -v termux-notification >/dev/null 2>&1; then
  echo "Tip: \`pkg install termux-api\` plus the Termux:API app (same store as Termux) gives"
  echo "  you native notifications, clipboard and share. Optional."
fi

# REMOTE=0 explicitly, not merely unset: on a phone the client and the server are the same
# device, so there is no network leg to secure and nothing to hand a token to — the desktop
# is opened locally, above. Pinning it here also keeps a `REMOTE=1` exported in the
# user's shell profile from quietly turning this launch into a tunnelled one.
# Not `exec`, so the EXIT trap above can release the wake lock.
# NO_WATCH: a phone is not editing the server, and --watch would restart it (dropping every
# agent) on a `git pull` underneath a running YAAR. NO_WATCH=0 brings it back.
MCP_SKIP_AUTH="${MCP_SKIP_AUTH-1}" NO_WATCH="${NO_WATCH-1}" LAUNCH_CHROME=0 REMOTE=0 \
  ./scripts/dev/start.sh claude
