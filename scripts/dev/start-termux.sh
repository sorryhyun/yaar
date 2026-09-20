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

[ -e node_modules/.bin/tsc ] || bun install

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

# No debuggable Chrome to launch on a phone; open the desktop in the default browser once
# the server answers instead.
if command -v termux-open-url >/dev/null 2>&1; then
  (
    url="http://localhost:${PORT:-8000}"
    for _ in $(seq 1 120); do
      curl -s --max-time 1 "$url" >/dev/null 2>&1 && break
      sleep 0.5
    done
    termux-open-url "$url"
  ) &
fi

MCP_SKIP_AUTH="${MCP_SKIP_AUTH-1}" LAUNCH_CHROME=0 exec ./scripts/dev/start.sh claude
