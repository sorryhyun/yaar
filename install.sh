#!/usr/bin/env bash
# YAAR installer — downloads the latest release binary for your platform.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sorryhyun/yaar/master/install.sh | bash
#
# Options (env vars):
#   INSTALL_DIR  — where to put the binary (default: ~/.local/bin)
#   VERSION      — specific version tag (default: latest)

set -euo pipefail

REPO="sorryhyun/yaar"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="yaar"

# — Detect platform ——————————————————————————————————————————————————

detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="macos" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# — Resolve version ——————————————————————————————————————————————————

resolve_version() {
  if [ -n "${VERSION:-}" ]; then
    echo "$VERSION"
    return
  fi

  local latest
  latest=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

  if [ -z "$latest" ]; then
    echo "Could not determine latest version." >&2
    exit 1
  fi

  echo "$latest"
}

# — Main ——————————————————————————————————————————————————————————————

main() {
  local platform version asset_name url tmp

  platform=$(detect_platform)
  version=$(resolve_version)

  echo "Installing YAAR ${version} for ${platform}..."

  # Asset naming: yaar-linux-x64, yaar-macos-x64, yaar-windows-x64.exe
  if [[ "$platform" == windows-* ]]; then
    asset_name="${BINARY_NAME}-${platform}.exe"
  else
    asset_name="${BINARY_NAME}-${platform}"
  fi

  url="https://github.com/${REPO}/releases/download/${version}/${asset_name}"

  # Download
  tmp=$(mktemp)
  if ! curl -fSL --progress-bar -o "$tmp" "$url"; then
    echo ""
    echo "Failed to download: $url" >&2
    echo "Check that version '${version}' exists and has a binary for ${platform}." >&2
    rm -f "$tmp"
    exit 1
  fi

  # Install
  mkdir -p "$INSTALL_DIR"
  local dest="${INSTALL_DIR}/${BINARY_NAME}"
  mv "$tmp" "$dest"
  chmod +x "$dest"

  echo ""
  echo "Installed to: $dest"

  # Check PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "⚠  $INSTALL_DIR is not in your PATH. Add it:"
    echo ""
    echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc"
    echo ""
  fi

  echo "Run 'yaar' to start."
}

main
