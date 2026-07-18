#!/usr/bin/env bash
# YAAR installer — downloads the latest release binary for your platform.
#
# Usage:
#   curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
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

  # Bundled apps — the exe reads them from apps/ next to the binary, so extract
  # the (platform-independent) apps archive into INSTALL_DIR. Non-fatal on
  # failure: YAAR still runs, just with no bundled apps until they are added.
  local apps_url="https://github.com/${REPO}/releases/download/${version}/yaar-apps.tar.gz"
  local apps_tmp
  apps_tmp=$(mktemp)
  if curl -fSL --progress-bar -o "$apps_tmp" "$apps_url"; then
    tar -xzf "$apps_tmp" -C "$INSTALL_DIR"
    echo "Installed bundled apps to: ${INSTALL_DIR}/apps"
  else
    echo "⚠  Could not download bundled apps ($apps_url) — YAAR will start with no apps." >&2
  fi
  rm -f "$apps_tmp"

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
