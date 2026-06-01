#!/bin/zsh
# DEPRECATED (Hono 移行): 旧 Next 前提の shell launcher (openground-launch.sh)
# から source される window-activation ヘルパ。通常配布は npm run dist
# (Electron) を使うこと。dogfood 安定までの legacy fallback で、いずれ削除する。
# ============================================================================
# openground-activate.sh
#
# Window-activation helpers for OPEN GROUND's launcher.
#
# Source this file from the launcher to get:
#   - raise_existing_chrome_window URL   (front the existing --app window)
#   - count_app_windows URL              (how many --app windows exist)
#   - verified_open_window URL           (idempotent open: raise OR open + verify)
#
# Standalone test:
#   ./openground-activate.sh test http://127.0.0.1:47776
#
# Design notes:
#   - We talk to Google Chrome DIRECTLY via AppleScript (`tell application
#     "Google Chrome"`), NOT through "System Events". That way macOS asks
#     for *Chrome Automation* permission only, not Accessibility — fewer
#     prompts, easier to reason about TCC failures.
#   - New windows go through `open -na "Google Chrome" --args --app=URL`
#     (LaunchServices) so they land in the user's normal Chrome instance.
#   - We never auto-increment the port; the URL we are handed is the URL.
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# raise_existing_chrome_window URL
#   stdout: nothing
#   return: 0 = raised, 1 = no matching window, 2 = TCC/permission denied
# ---------------------------------------------------------------------------
raise_existing_chrome_window() {
  local url="$1"
  local script
  # AppleScript: look for any window whose front tab URL starts with $url.
  # If found: activate Chrome, index that window to 1 (front).
  read -r -d '' script <<APPLESCRIPT || true
on run argv
  set targetURL to item 1 of argv
  try
    tell application "Google Chrome"
      if not (exists window 1) then return "notfound"
      set winList to every window
      repeat with w in winList
        try
          set tabURL to URL of active tab of w
          if tabURL starts with targetURL then
            set index of w to 1
            activate
            return "raised"
          end if
        end try
      end repeat
    end tell
    return "notfound"
  on error errMsg number errNum
    if errNum is -1743 then return "denied"
    return "error:" & errNum
  end try
end run
APPLESCRIPT

  local result
  result=$(osascript -e "$script" -- "$url" 2>&1 || true)

  case "$result" in
    raised)  return 0 ;;
    denied)  return 2 ;;
    notfound) return 1 ;;
    *)
      # Some other AppleScript / TCC failure. Surface -1743 in stderr text too.
      if [[ "$result" == *"-1743"* ]] || [[ "$result" == *"not allowed assistive"* ]] || [[ "$result" == *"Not authorized"* ]]; then
        return 2
      fi
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# count_app_windows URL
#   stdout: integer count (0+)
#   return: 0 normally, 2 if TCC denied
# ---------------------------------------------------------------------------
count_app_windows() {
  local url="$1"
  local script
  read -r -d '' script <<APPLESCRIPT || true
on run argv
  set targetURL to item 1 of argv
  set n to 0
  try
    tell application "Google Chrome"
      if not (exists window 1) then return "0"
      set winList to every window
      repeat with w in winList
        try
          set tabURL to URL of active tab of w
          if tabURL starts with targetURL then set n to n + 1
        end try
      end repeat
    end tell
    return (n as text)
  on error errMsg number errNum
    if errNum is -1743 then return "denied"
    return "0"
  end try
end run
APPLESCRIPT

  local result
  result=$(osascript -e "$script" -- "$url" 2>/dev/null || echo "0")
  if [[ "$result" == "denied" ]]; then
    echo "0"
    return 2
  fi
  # Strip anything non-numeric for safety.
  echo "${result//[^0-9]/}" | head -c 6
  return 0
}

# ---------------------------------------------------------------------------
# OPEN GROUND keeps a dedicated Chrome user-data-dir so the --app window
# never collides with the user's other Chrome workspaces (e.g. people who
# run multiple chrome-workspace projects each with their own profile).
# Pros:
#   - No "Default profile already locked by another Chrome instance" failure
#     when the user happens to have Chrome already open in a different dir.
#   - TCC, cookies, extensions, login state isolated from main browsing.
# Trade-off: first launch the user signs into nothing — that's by design;
# this is a dev cockpit, not a browser session.
# ---------------------------------------------------------------------------
OPENGROUND_CHROME_PROFILE="${HOME}/.openground/chrome-profile"

# ---------------------------------------------------------------------------
# _open_new_app_window URL
#   Internal: spawn a fresh --app window in OPEN GROUND's dedicated Chrome
#   instance. Uses `open -na` so LaunchServices treats this as a separate
#   Chrome process from the user's normal browsing, keyed by user-data-dir.
# ---------------------------------------------------------------------------
_open_new_app_window() {
  local url="$1"
  mkdir -p "$OPENGROUND_CHROME_PROFILE"
  open -na "Google Chrome" --args \
    --app="$url" \
    --user-data-dir="$OPENGROUND_CHROME_PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    >/dev/null 2>&1 || return 1
  return 0
}

# ---------------------------------------------------------------------------
# count_chrome_connections PORT
#   Instance-agnostic readiness signal. Returns the number of ESTABLISHED
#   TCP connections from a Chrome process to 127.0.0.1:PORT. AppleScript
#   `count windows` only sees one Chrome instance at a time, which breaks
#   when the user runs multiple Chrome instances (chrome-workspace style);
#   lsof sees them all. If Chrome has loaded the page, there will be at
#   least one ESTABLISHED socket.
# ---------------------------------------------------------------------------
count_chrome_connections() {
  local port="$1"
  # `+c 0` disables lsof's default 9-char COMMAND truncation. lsof encodes
  # spaces in COMMAND as `\x20`, so "Google Chrome" comes through as
  # "Google\x20Chrome" (and "Google\x20Chrome\x20Helper" for renderer
  # processes). Matching either flavor catches the actual TCP client.
  lsof -nP +c 0 -iTCP:"$port" -sTCP:ESTABLISHED 2>/dev/null \
    | awk '$1 ~ /^Google.x20Chrome/ { n++ } END { print n+0 }'
}

# ---------------------------------------------------------------------------
# _denied_dialog
# ---------------------------------------------------------------------------
_denied_dialog() {
  osascript -e 'display dialog "OPEN GROUND needs permission to control Google Chrome.\n\nOpen System Settings → Privacy & Security → Automation → OPEN GROUND, allow Google Chrome." buttons {"OK"} default button 1 with icon stop with title "OPEN GROUND — Permission Needed"' >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# _fatal_dialog
# ---------------------------------------------------------------------------
_fatal_dialog() {
  osascript -e 'display dialog "Could not open the OPEN GROUND window.\n\nQuit Google Chrome fully and double-click OPEN GROUND.app again." buttons {"OK"} default button 1 with icon stop with title "OPEN GROUND"' >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# verified_open_window URL
#   Idempotent window opener. Either fronts an existing --app window for
#   URL, or opens a new one and verifies it appeared. Never opens a 2nd
#   window when one already exists.
# ---------------------------------------------------------------------------
verified_open_window() {
  local url="$1"
  # Pull the host:port out of the URL for the lsof readiness probe.
  local port="${url##*:}"
  port="${port%%/*}"

  # If a Chrome process is already showing this URL (any instance,
  # any profile), short-circuit: we don't need to open a second window.
  if [[ "$(count_chrome_connections "$port")" -ge 1 ]]; then
    # Best-effort raise via AppleScript — failures here aren't fatal.
    raise_existing_chrome_window "$url" >/dev/null 2>&1 || true
    return 0
  fi

  # No connection yet → open a fresh --app window in our dedicated profile.
  if ! _open_new_app_window "$url"; then
    _fatal_dialog
    return 1
  fi

  # Poll for up to ~6s for Chrome to actually establish a TCP connection
  # to the dev server. This is instance-agnostic (works regardless of how
  # many Chrome instances the user has running for other workspaces).
  local i
  for i in {1..20}; do
    sleep 0.3
    if [[ "$(count_chrome_connections "$port")" -ge 1 ]]; then
      return 0
    fi
  done

  # One retry, in case LaunchServices race-lost the first attempt.
  _open_new_app_window "$url" || true
  for i in {1..20}; do
    sleep 0.3
    if [[ "$(count_chrome_connections "$port")" -ge 1 ]]; then
      return 0
    fi
  done

  _fatal_dialog
  return 1
}

# ---------------------------------------------------------------------------
# Standalone test entry:
#   ./openground-activate.sh test http://127.0.0.1:47776
# ---------------------------------------------------------------------------
# Standalone CLI mode: only fires when the script is invoked with a known
# subcommand. When the launcher `source`s this file with no args, nothing
# runs — avoids the zsh-source self-detect pitfall where `$0` inside a
# sourced file equals the sourced file's path (so any "am I top-level?"
# trick fires when sourced too).
case "${1:-}" in
  test)
    [[ -z "${2:-}" ]] && { echo "usage: $0 test <URL>" >&2; exit 2; }
    verified_open_window "$2"
    exit $?
    ;;
  raise)
    [[ -z "${2:-}" ]] && { echo "usage: $0 raise <URL>" >&2; exit 2; }
    raise_existing_chrome_window "$2"
    exit $?
    ;;
  count)
    [[ -z "${2:-}" ]] && { echo "usage: $0 count <URL>" >&2; exit 2; }
    count_app_windows "$2"
    exit $?
    ;;
esac
