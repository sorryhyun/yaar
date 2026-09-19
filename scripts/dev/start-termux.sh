#!/usr/bin/env bash
# Start YAAR with the Claude provider on Android (Termux).
#
# The Agent SDK only ships glibc/musl `claude` binaries, which Android's linker refuses
# ("unexpected e_type: 2"). So this pulls the linux build matching the installed SDK,
# unpacks its JS with unbun-claude.ts, and points CLAUDE_CODE_PATH at a wrapper that runs
# it on the Android build of Bun. The extraction is cached per SDK version, so it only
# happens again after the SDK is bumped. Everything else is start.sh.

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
  case "$(uname -m)" in
    aarch64 | arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *)
      echo "Unsupported CPU $(uname -m)"
      exit 1
      ;;
  esac

  sdk_version="$(bun -e "console.log(require('./packages/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)")"
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/yaar/claude-js/${sdk_version}-${arch}"

  if [ ! -x "$cache/claude" ]; then
    pkg="claude-agent-sdk-linux-${arch}"
    echo "Unpacking Claude Code for SDK ${sdk_version} into ${cache}..."
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "https://registry.npmjs.org/@anthropic-ai/${pkg}/-/${pkg}-${sdk_version}.tgz" |
      tar xz -C "$tmp"
    rm -rf "$cache"
    bun scripts/dev/unbun-claude.ts "$tmp/package/claude" "$cache"
    printf '#!/bin/sh\nexec "%s" "%s/cli.js" "$@"\n' "$(command -v bun)" "$cache" >"$cache/claude"
    chmod +x "$cache/claude"
    rm -rf "$tmp"
    trap - EXIT
  fi
  export CLAUDE_CODE_PATH="$cache/claude"
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "$HOME/.claude/.credentials.json" ]; then
  echo "Claude is not logged in. Either run \`claude setup-token\` on another machine and"
  echo "  export CLAUDE_CODE_OAUTH_TOKEN=<token>"
  echo "or run \`$CLAUDE_CODE_PATH auth login\` here."
  exit 1
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
