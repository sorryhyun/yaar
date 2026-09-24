#!/usr/bin/env bash
# YAAR installer — downloads the latest release binary for your platform.
#
# Usage:
#   curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
#
# Options (env vars):
#   INSTALL_DIR  — where to put the binary (default: ~/.local/bin; $PREFIX/bin on Termux)
#   VERSION      — specific version tag (default: latest)
#   YAAR_DIR     — Termux only: where the source checkout goes (default: ~/yaar)
#   YAAR_SKIP_CLAUDE — Termux only: 1 leaves Claude Code for the first run to fetch
#   YAAR_SKIP_YTDLP  — Termux only: 1 skips installing yt-dlp (YouTube audio download)

set -euo pipefail

REPO="sorryhyun/yaar"
INSTALL_DIR="${INSTALL_DIR:-}" # default is per platform, set in main
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

# — Termux ———————————————————————————————————————————————————————————
#
# The release binaries are glibc builds, which Android's linker refuses, so on Termux
# there is nothing to download. Instead: the Android build of Bun, a checkout of the
# release tag, Claude Code unpacked for Android, and a `yaar` launcher that runs
# `make termux` in it (which handles the login — see scripts/dev/start-termux.sh).

is_termux() {
  [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == */com.termux/* ]]
}

install_termux() {
  local version="$1"
  local yaar_dir="${YAAR_DIR:-$HOME/yaar}"
  local bun_dir="$HOME/.bun/bin"

  local bun_asset
  case "$(uname -m)" in
    aarch64|arm64) bun_asset="bun-linux-aarch64-android" ;;
    x86_64|amd64)  bun_asset="bun-linux-x64-android" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  echo "Installing YAAR ${version} for Android (Termux) from source..."

  local missing=() cmd
  for cmd in git make curl unzip; do
    command -v "$cmd" > /dev/null 2>&1 || missing+=("$cmd")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    pkg install -y "${missing[@]}"
  fi

  export PATH="$bun_dir:$PATH"
  if ! bun --version > /dev/null 2>&1; then
    echo "Installing Bun (Android build) to ${bun_dir}..."
    local tmp
    tmp=$(mktemp -d)
    curl -fSL --progress-bar -o "$tmp/bun.zip" \
      "https://github.com/oven-sh/bun/releases/latest/download/${bun_asset}.zip"
    unzip -q "$tmp/bun.zip" -d "$tmp"
    mkdir -p "$bun_dir"
    mv "$tmp/${bun_asset}/bun" "$bun_dir/bun"
    chmod +x "$bun_dir/bun"
    rm -rf "$tmp"
  fi

  if [ -d "$yaar_dir/.git" ]; then
    echo "Updating ${yaar_dir} to ${version}..."
    git -C "$yaar_dir" fetch -q --depth 1 origin "$version"
    git -C "$yaar_dir" checkout -q FETCH_HEAD
  elif [ -e "$yaar_dir" ]; then
    echo "${yaar_dir} exists and is not a git checkout — set YAAR_DIR to install elsewhere." >&2
    exit 1
  else
    git clone -q --depth 1 --branch "$version" "https://github.com/${REPO}.git" "$yaar_dir"
  fi

  (cd "$yaar_dir" && bun install)

  # Claude Code, ahead of time. The Agent SDK ships no Android binary, so it has to be
  # unpacked from the linux one — a ~220MB download that start-termux.sh would otherwise
  # do on the first launch, where it reads as a hang rather than as an install step.
  # Non-fatal: the first run does it instead, which is exactly what used to happen.
  if [ "${YAAR_SKIP_CLAUDE:-0}" != "1" ]; then
    if ! (cd "$yaar_dir" && ./scripts/dev/ensure-claude-android.sh > /dev/null); then
      echo "⚠  Could not fetch Claude Code — the first 'yaar' run will try again." >&2
    fi
  fi

  # yt-dlp, for yaar://system/ytdlp (the transcribe app's YouTube leg). Optional everywhere
  # else, where a package manager is one command away; a phone user is far less likely to
  # go and find it, and Termux packages it, landing on the PATH the server probes.
  # Non-fatal: without it only the media download is missing.
  if [ "${YAAR_SKIP_YTDLP:-0}" != "1" ] && ! command -v yt-dlp > /dev/null 2>&1; then
    if ! pkg install -y yt-dlp; then
      echo "⚠  Could not install yt-dlp — YouTube download stays off. Later: pkg install yt-dlp" >&2
    fi
  fi

  mkdir -p "$INSTALL_DIR"
  local dest="${INSTALL_DIR}/${BINARY_NAME}"
  printf '#!/usr/bin/env bash\nexport PATH="%s:$PATH"\ncd "%s" && exec make termux\n' \
    "$bun_dir" "$yaar_dir" > "$dest"
  chmod +x "$dest"

  # A home-screen button, for the Termux:Widget app: it lists whatever is in ~/.shortcuts.
  # Harmless without the app. Tapping it while YAAR runs just reopens the desktop
  # (start-termux.sh's single-instance check).
  mkdir -p "$HOME/.shortcuts"
  printf '#!/usr/bin/env bash\nexec "%s"\n' "$dest" > "$HOME/.shortcuts/YAAR"
  chmod +x "$HOME/.shortcuts/YAAR"

  echo ""
  echo "Installed to: $dest (runs ${yaar_dir})"
  echo "Home-screen button: add the Termux:Widget widget and pick 'YAAR' (~/.shortcuts/YAAR)."
  # The login stays at first run whatever we do here: piped into bash, this script has
  # no TTY on stdin, and `claude auth login` is interactive.
  echo "Run 'yaar' to start. The first run asks you to log in to Claude."
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

# — Verify checksums —————————————————————————————————————————————————
#
# release.yml publishes a SHA256SUMS asset next to the binaries. It travels the
# same HTTPS channel they do, so it is not a defence against a compromised
# release — it catches a truncated download, a stale CDN copy, and a binary
# paired with an apps archive from a different build.
#
# Two deliberate soft-fails, because this must not break installs it did not
# used to break: releases cut before SHA256SUMS existed have no manifest (and
# `VERSION=` can pin one), and a stripped-down container may have no hashing
# tool. Either case warns and continues. A manifest that *is* present and
# disagrees is a hard failure.

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

# verify_checksum <downloaded-file> <asset-name> <sums-file>
verify_checksum() {
  local file="$1" name="$2" sums="$3"
  local want have

  # `sha256sum` writes "<hash>  <name>"; the second field may carry a `*` binary
  # marker. Anchor on the name so `yaar-linux-x64` cannot match `yaar-linux-x64.exe`.
  want=$(grep -E "[[:space:]][*]?${name}\$" "$sums" 2> /dev/null | head -1 | awk '{print $1}') || true

  if [ -z "$want" ]; then
    echo "⚠  No published checksum for ${name} — skipping verification." >&2
    return 0
  fi

  have=$(sha256_of "$file")
  if [ -z "$have" ]; then
    echo "⚠  Neither sha256sum nor shasum found — skipping verification of ${name}." >&2
    return 0
  fi

  if [ "$want" != "$have" ]; then
    echo "" >&2
    echo "Checksum mismatch for ${name} — refusing to install." >&2
    echo "  expected: $want" >&2
    echo "  actual:   $have" >&2
    return 1
  fi

  echo "Verified ${name}"
}

# — Main ——————————————————————————————————————————————————————————————

main() {
  local platform version asset_name url tmp sums

  if is_termux; then
    INSTALL_DIR="${INSTALL_DIR:-$PREFIX/bin}"
    install_termux "$(resolve_version)"
    return
  fi
  INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

  platform=$(detect_platform)
  version=$(resolve_version)

  echo "Installing YAAR ${version} for ${platform}..."

  # Fetch the manifest up front so both the binary and the apps archive verify
  # against one file. An empty file means "no manifest published" and every
  # lookup below soft-fails through verify_checksum.
  sums=$(mktemp)
  curl -fsSL -o "$sums" \
    "https://github.com/${REPO}/releases/download/${version}/SHA256SUMS" || : > "$sums"

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

  if ! verify_checksum "$tmp" "$asset_name" "$sums"; then
    rm -f "$tmp" "$sums"
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
    # A bad apps archive is not worth aborting a good binary install over, but it
    # must not be unpacked either — extracting a corrupt tarball over apps/ is
    # worse than leaving the previous one in place.
    if verify_checksum "$apps_tmp" "yaar-apps.tar.gz" "$sums"; then
      tar -xzf "$apps_tmp" -C "$INSTALL_DIR"
      echo "Installed bundled apps to: ${INSTALL_DIR}/apps"
    else
      echo "⚠  Skipped bundled apps — checksum did not match." >&2
    fi
  else
    echo "⚠  Could not download bundled apps ($apps_url) — YAAR will start with no apps." >&2
  fi
  rm -f "$apps_tmp" "$sums"

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
