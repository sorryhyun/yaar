#!/bin/bash
# Enable WebGPU in desktop Chrome/Chromium profiles on Linux.
#
# Linux Chrome ships with WebGPU off (its Vulkan backend is soft-blocklisted),
# so yaar-ml/anima inference fails with "Failed to get GPU adapter". This is
# the scripted equivalent of flipping chrome://flags/#enable-unsafe-webgpu and
# chrome://flags/#enable-vulkan by hand: those toggles are stored in each
# profile's "Local State" JSON under browser.enabled_labs_experiments, using
# "<flag>@1" for the Enabled dropdown value.
#
# Idempotent; backs up each file it touches to "Local State.yaar-backup".
# The browser must be closed — Chrome rewrites Local State on exit, which
# would silently discard the patch — so running profiles are skipped.

set -e

if [ "$(uname -s)" != "Linux" ]; then
  echo "Nothing to do: Windows/macOS Chrome enable WebGPU by default."
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required (used to edit JSON safely)." >&2
  exit 1
fi

patched=0
skipped=0

for dir in \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/google-chrome-beta" \
  "$HOME/.config/google-chrome-unstable" \
  "$HOME/.config/chromium" \
  "$HOME/snap/chromium/common/chromium" \
  "${YAAR_CHROME_PROFILE:-$HOME/.yaar-chrome}"; do
  state="$dir/Local State"
  [ -f "$state" ] || continue

  # Chrome holds a SingletonLock symlink in the profile while running.
  if [ -e "$dir/SingletonLock" ] || [ -L "$dir/SingletonLock" ]; then
    echo "SKIP    $dir (browser is running — close it and re-run)"
    skipped=1
    continue
  fi

  result="$(STATE="$state" bun -e '
    const fs = require("fs");
    const path = process.env.STATE;
    const wanted = ["enable-unsafe-webgpu@1", "enable-vulkan@1"];
    const j = JSON.parse(fs.readFileSync(path, "utf8"));
    j.browser ??= {};
    const cur = j.browser.enabled_labs_experiments ?? [];
    // Replace any existing setting of these flags (e.g. "@2" = Disabled).
    const next = [
      ...cur.filter((e) => !wanted.some((w) => e.split("@")[0] === w.split("@")[0])),
      ...wanted,
    ];
    if (JSON.stringify([...cur].sort()) === JSON.stringify([...next].sort())) {
      console.log("already");
      process.exit(0);
    }
    fs.copyFileSync(path, path + ".yaar-backup");
    j.browser.enabled_labs_experiments = next;
    fs.writeFileSync(path, JSON.stringify(j));
    console.log("patched");
  ')"

  if [ "$result" = "patched" ]; then
    echo "PATCHED $dir"
    patched=1
  else
    echo "OK      $dir (already enabled)"
  fi
done

echo ""
if [ "$patched" = 1 ]; then
  echo "Done. Restart the browser, then verify chrome://gpu shows WebGPU: Hardware accelerated."
elif [ "$skipped" = 1 ]; then
  echo "Some profiles were skipped — close those browsers and re-run."
else
  echo "All found profiles already have WebGPU enabled (or no Chrome profiles found)."
fi

# shader-f16 on NVIDIA needs a Dawn toggle (Dawn holds it back on all NVIDIA
# Vulkan adapters — crbug.com/42251215 — even when the driver supports fp16).
# Dawn toggles have no chrome://flags entry, so we can't persist it in Local
# State like the flags above; it must be on the command line. The Chrome that
# dev/start.sh launches (LAUNCH_CHROME=1) and the headless sandbox already pass it.
if lspci 2>/dev/null | grep -qi "vga.*nvidia\|3d.*nvidia"; then
  echo ""
  echo "NVIDIA GPU detected: fp16 (shader-f16) additionally requires launching"
  echo "Chrome with --enable-dawn-features=vulkan_enable_f16_on_nvidia."
  echo "YAAR's own browsers (dev/start.sh LAUNCH_CHROME=1, headless sandbox) pass this"
  echo "automatically; add it to the launch command if you use your own Chrome."
fi
