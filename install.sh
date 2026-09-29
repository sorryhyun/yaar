#!/usr/bin/env bash
# YAAR installer — downloads the latest release binary for your platform.
#
# Usage:
#   curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
#
# Options (env vars):
#   INSTALL_DIR  — where to put the binary (default: ~/.local/bin; $PREFIX/bin on Termux)
#                  On macOS: where the `yaar` launcher goes; the binary lives in YAAR.app
#   APP_DIR      — macOS only: where YAAR.app goes (default: ~/Applications)
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

# — macOS: YAAR.app ——————————————————————————————————————————————————
#
# On macOS the binary is installed inside YAAR.app, assembled here, and `yaar` on the
# PATH is a launcher into it. The bundle is not packaging for its own sake: WKWebView
# exposes no navigator.mediaDevices at all to a process whose main bundle has no
# NSMicrophoneUsageDescription, so a bare binary's window can never record (measured
# on 0.22.0 — see docs/installations/mac.md). The bundle's signature is
# also what macOS files the microphone grant under.
#
# Assembled here rather than downloaded because codesign, sips and iconutil ship with
# every macOS, not with the Linux runner that builds the release. The Info.plist must
# say what scripts/build/exe-bundle.js's does; macos-bundle-plist.test.ts compares them.
#
# The bundle keeps its data in ~/Library/Application Support/YAAR (config/env.ts), where
# a bare install kept it beside the binary. The first bundle install moves it over: it
# is the data the user has been running on. Anything already at a destination is set
# aside under .pre-migration-<time>/, never deleted.

MACOS_DATA_ITEMS=(config storage session_logs user-apps workspaces .env)

migrate_bare_install_data() {
  local from="$1" to="$2"
  local aside="${to}/.pre-migration-$(date +%Y%m%d-%H%M%S)"
  local item moved=0
  mkdir -p "$to"
  for item in "${MACOS_DATA_ITEMS[@]}"; do
    [ -e "${from}/${item}" ] || continue
    if [ -e "${to}/${item}" ]; then
      mkdir -p "$aside"
      mv "${to}/${item}" "${aside}/${item}"
    fi
    mv "${from}/${item}" "${to}/${item}"
    moved=1
  done
  # Install-owned leftovers of the bare layout: its apps copy and an updater backup.
  rm -rf "${from}/apps" "${from}/${BINARY_NAME}.previous" "${from}/.yaar-update"
  if [ "$moved" = 1 ]; then
    echo "Moved your YAAR data from ${from} to: ${to}"
    [ -d "$aside" ] && echo "  (what was already there is kept in ${aside})"
  fi
  return 0
}

write_info_plist() {
  local plist="$1" version="$2" icon_key="$3"
  cat > "$plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>YAAR</string>
  <key>CFBundleDisplayName</key><string>YAAR</string>
  <key>CFBundleIdentifier</key><string>io.github.sorryhyun.yaar</string>
  <key>CFBundleExecutable</key><string>${BINARY_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>YAAR apps record audio when you ask them to, for example to transcribe speech.</string>
${icon_key}</dict>
</plist>
PLIST
}

# make_icns <tag> <out.icns> — the frontend's icon at this tag. Non-fatal: the bundle
# works without one, it just shows the generic app icon.
make_icns() {
  local tag="$1" out="$2" work png size scale px
  work=$(mktemp -d)
  png="${work}/icon.png"
  if ! curl -fsSL -o "$png" \
    "https://raw.githubusercontent.com/${REPO}/${tag}/packages/frontend/public/icon-512.png"; then
    rm -rf "$work"
    return 1
  fi
  mkdir "${work}/YAAR.iconset"
  for size in 16 32 128 256 512; do
    for scale in 1 2; do
      px=$((size * scale))
      [ "$px" -gt 512 ] && continue
      if [ "$scale" = 1 ]; then
        sips -z "$px" "$px" "$png" --out "${work}/YAAR.iconset/icon_${size}x${size}.png" > /dev/null
      else
        sips -z "$px" "$px" "$png" --out "${work}/YAAR.iconset/icon_${size}x${size}@2x.png" > /dev/null
      fi
    done
  done
  iconutil -c icns "${work}/YAAR.iconset" -o "$out"
  local ok=$?
  rm -rf "$work"
  return $ok
}

# install_macos_app <verified-binary> <tag> <verified-apps-tarball-or-empty>
install_macos_app() {
  local binary="$1" tag="$2" apps_tgz="$3"
  local app_dir="${APP_DIR:-$HOME/Applications}"
  local app="${app_dir}/YAAR.app"
  local data="$HOME/Library/Application Support/YAAR"
  local dest="${INSTALL_DIR}/${BINARY_NAME}"
  local stage contents icon_key=""

  # Moving data out from under a running server, or swapping its bundle, is how an
  # install corrupts something. Quitting first is cheap.
  # By process name: the server runs as plain `yaar` (argv[0]), bare or bundled.
  if pgrep -x "$BINARY_NAME" > /dev/null 2>&1; then
    echo "YAAR is running. Quit it (close its window), then run the installer again." >&2
    exit 1
  fi

  # Staged beside the destination, so the final swap is a rename on one filesystem.
  mkdir -p "$app_dir"
  stage=$(mktemp -d "${app_dir}/.YAAR.install.XXXXXX")
  contents="${stage}/YAAR.app/Contents"
  mkdir -p "${contents}/MacOS" "${contents}/Resources"
  mv "$binary" "${contents}/MacOS/${BINARY_NAME}"
  chmod +x "${contents}/MacOS/${BINARY_NAME}"

  # Apps ride read-only in the bundle; each launch of a new stamp copies them out
  # (packages/server/src/macos-bundle.ts).
  if [ -n "$apps_tgz" ]; then
    tar -xzf "$apps_tgz" -C "${contents}/Resources"
    printf '%s %s\n' "$tag" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${contents}/Resources/apps/.bundle-stamp"
  fi

  if make_icns "$tag" "${contents}/Resources/YAAR.icns" 2> /dev/null; then
    icon_key='  <key>CFBundleIconFile</key><string>YAAR</string>
'
  fi
  write_info_plist "${contents}/Info.plist" "${tag#v}" "$icon_key"

  if ! codesign --force --sign - "${stage}/YAAR.app" 2> /dev/null; then
    rm -rf "$stage"
    echo "Could not sign YAAR.app (codesign failed) — nothing was installed." >&2
    exit 1
  fi

  if [ -e "$app" ]; then mv "$app" "${stage}/YAAR.app.previous"; fi
  mv "${stage}/YAAR.app" "$app"
  rm -rf "$stage"
  echo ""
  echo "Installed: $app"

  # A bare binary at $dest (not our launcher) means this machine ran the pre-bundle
  # layout, with its data in INSTALL_DIR. First bundle install: bring it along.
  mkdir -p "$INSTALL_DIR"
  if [ -f "$dest" ] && [ "$(head -c 2 "$dest")" != "#!" ]; then
    migrate_bare_install_data "$INSTALL_DIR" "$data"
  fi

  # A launcher, not a symlink: the executable has to run from its path inside the
  # bundle for macOS to find the bundle (and so its Info.plist) at all.
  printf '#!/bin/sh\nexec "%s/Contents/MacOS/%s" "$@"\n' "$app" "$BINARY_NAME" > "$dest"
  chmod +x "$dest"
  echo "Launcher: $dest"
  echo "Data:     $data"
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

  # Bundled apps — the (platform-independent) apps archive. Non-fatal on failure:
  # YAAR still runs, just with no bundled apps until they are added. A bad archive
  # is not worth aborting a good binary install over, but it must not be unpacked
  # either — extracting a corrupt tarball over apps/ is worse than leaving the
  # previous one in place. `apps_ok` empties when it is not to be used.
  local apps_url="https://github.com/${REPO}/releases/download/${version}/yaar-apps.tar.gz"
  local apps_tmp apps_ok
  apps_tmp=$(mktemp)
  apps_ok="$apps_tmp"
  if curl -fSL --progress-bar -o "$apps_tmp" "$apps_url"; then
    if ! verify_checksum "$apps_tmp" "yaar-apps.tar.gz" "$sums"; then
      echo "⚠  Skipped bundled apps — checksum did not match." >&2
      apps_ok=""
    fi
  else
    echo "⚠  Could not download bundled apps ($apps_url) — YAAR will start with no apps." >&2
    apps_ok=""
  fi

  if [[ "$platform" == macos-* ]]; then
    install_macos_app "$tmp" "$version" "$apps_ok"
  else
    # Install
    mkdir -p "$INSTALL_DIR"
    local dest="${INSTALL_DIR}/${BINARY_NAME}"
    mv "$tmp" "$dest"
    chmod +x "$dest"

    echo ""
    echo "Installed to: $dest"

    # The exe reads its apps from apps/ next to the binary.
    if [ -n "$apps_ok" ]; then
      tar -xzf "$apps_ok" -C "$INSTALL_DIR"
      echo "Installed bundled apps to: ${INSTALL_DIR}/apps"
    fi
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
