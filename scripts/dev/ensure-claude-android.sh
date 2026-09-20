#!/usr/bin/env bash
# Put Claude Code where an Android Bun can run it, and print the path to it.
#
# The Agent SDK ships glibc and musl `claude` binaries only, and Android's linker refuses
# both ("unexpected e_type: 2"). The chunks inside are stored as source next to their
# bytecode, though, so unbun-claude.ts extracts the module graph and the Android build of
# Bun runs it.
#
# Cached per SDK version and architecture: a no-op after the first call, and done again
# only when the SDK is bumped. Two callers, for one reason each — install.sh calls it so
# the ~220MB download lands while the user is already waiting on the installer rather
# than on a first launch that looks hung, and start-termux.sh calls it so a phone that
# installed some other way, or whose SDK has since moved, still starts.
#
# Progress goes to stderr; the path to the `claude` wrapper is the only thing on stdout.
#
# Usage:
#   CLAUDE_CODE_PATH="$(scripts/dev/ensure-claude-android.sh)"

set -e

cd "$(dirname "$0")/../.."

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *)
    echo "Unsupported CPU $(uname -m)" >&2
    exit 1
    ;;
esac

sdk_version="$(bun -e "console.log(require('./packages/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)")"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/yaar/claude-js/${sdk_version}-${arch}"

if [ ! -x "$cache/claude" ]; then
  pkg="claude-agent-sdk-linux-${arch}"
  echo "Unpacking Claude Code for SDK ${sdk_version} into ${cache}" >&2
  echo "  (~220MB — this is the one big download; later starts reuse it)" >&2
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://registry.npmjs.org/@anthropic-ai/${pkg}/-/${pkg}-${sdk_version}.tgz" |
    tar xz -C "$tmp"
  rm -rf "$cache"
  bun scripts/dev/unbun-claude.ts "$tmp/package/claude" "$cache"
  printf '#!/bin/sh\nexec "%s" "%s/cli.js" "$@"\n' "$(command -v bun)" "$cache" > "$cache/claude"
  chmod +x "$cache/claude"
  rm -rf "$tmp"
  trap - EXIT
fi

echo "$cache/claude"
