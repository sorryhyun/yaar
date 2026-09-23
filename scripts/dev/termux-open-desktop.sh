#!/usr/bin/env bash
# Open the YAAR desktop on the phone: the installed app if there is one, else Chrome, else
# the default browser.
#
# Two callers: start-termux.sh once the server answers (or when a second launch finds one
# running), and a tap on a native notification (features/android/), which Termux runs as
# a shell command.
#
# Usage: termux-open-desktop.sh <url>

url="$1"
[ -n "$url" ] || { echo "usage: termux-open-desktop.sh <url>" >&2; exit 2; }

case "${TERMUX__USER_ID:-}" in '' | *[!0-9]* | 0[0-9]*) user=0 ;; *) user="$TERMUX__USER_ID" ;; esac

# `am start -a VIEW` pinned to one package. termux-open-url is this same intent without the
# `-p`; a phone that lacks the package fails to resolve it, which is the cue to fall through.
view_in() {
  local out
  command -v am >/dev/null 2>&1 || return 1
  out="$(am start --user "$user" -a android.intent.action.VIEW -d "$url" -p "$1" 2>&1)" &&
    ! printf '%s' "$out" | grep -qiE 'error|exception'
}

# The installed app. "Install app" in Chrome mints a WebAPK (package org.chromium.webapk.*)
# whose intent filter claims the desktop's URL, so asking the package manager who handles
# that URL finds this desktop's app and not some other site's. Opened without the pin,
# the same URL would land in a Chrome tab. A plain "Add to Home screen" shortcut is not a
# WebAPK and is not found here; it opens in Chrome either way.
installed_app() {
  [ -x /system/bin/cmd ] || return 1
  /system/bin/cmd package query-activities --brief -a android.intent.action.VIEW -d "$url" \
    </dev/null 2>/dev/null | grep -oE 'org\.chromium\.webapk\.[A-Za-z0-9_]+' | head -1
}

app="$(installed_app)"
[ -n "$app" ] && view_in "$app" && exit 0

# Chrome when it is installed. The default browser on a Galaxy is Samsung Internet, which
# warns "can't be downloaded securely" on every plain-http download, localhost included;
# Chrome counts loopback as secure and does not. YAAR_TERMUX_BROWSER names another
# package; empty means the default browser.
browser="${YAAR_TERMUX_BROWSER-com.android.chrome}"
[ -n "$browser" ] && view_in "$browser" && exit 0

command -v termux-open-url >/dev/null 2>&1 && exec termux-open-url "$url"
