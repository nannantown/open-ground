#!/bin/zsh
# DEPRECATED (Hono 移行): この launcher は旧 Next 前提。通常配布は
# `npm run dist` (Electron / electron-builder, arm64, 固定ポート 47776) を
# 使うこと。これは dogfood が安定するまで温存している legacy fallback で、
# いずれ削除される。動作はまだ維持する。
#
# OPEN GROUND launcher — started by OPEN GROUND.app.
#
# Three-block design (probe → bootstrap → watchdog) for deterministic single-
# instance startup:
#
#   1. PROBE.   Identity-check the well-known server (HTTP /api/health). If
#               OPEN GROUND is already running for THIS checkout, raise its
#               window and exit. We do not become the owner — the existing
#               launcher keeps owning the dev server.
#   2. BOOTSTRAP.  Take a filesystem lock (mkdir is atomic on APFS), spawn the
#               dev server bound to a FIXED port, wait for /api/health to
#               return our bootId, commit server.json atomically, and open
#               the Chrome --app window via openground-activate.sh.
#   3. WATCHDOG.  Stay resident. Health-poll /api/health (route, not just
#               header). Restart on hang/crash. Tear everything down on Cmd+Q.
#
# Why fixed port 47776: Next.js auto-incrementing off a busy 3000 produced
# split-brain (multiple servers, multiple windows, no single source of truth).
# A fixed port + HTTP identity probe = exactly one OPEN GROUND server, or a
# clear fatal that the user can act on.

set -euo pipefail

print -u2 "[DEPRECATED] openground-launch.sh は旧 Next 前提の legacy launcher。通常は npm run dist (Electron) を使ってください。dogfood 安定までの fallback です。"

# ============================================================================
# STEP 0: bootstrap constants + legacy cleanup
# ============================================================================
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE_DIR="$HOME/.openground"
LOCK_DIR="$STATE_DIR/bootstrap.lock"
SERVER_JSON="$STATE_DIR/server.json"
SERVER_JSON_TMP="$STATE_DIR/server.json.tmp"
LOG="/tmp/openground.log"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

FIXED_PORT=47776
HOST="127.0.0.1"
BASE_URL="http://127.0.0.1:${FIXED_PORT}"
HEALTH_URL="${BASE_URL}/api/health"

mkdir -p "$STATE_DIR"

# Generate a bootId for THIS bootstrap attempt. The dev server echoes it back
# via /api/health so we can prove the listener on port 47776 is the process we
# just spawned (and not a leftover or a foreign process).
BOOT_ID=$(uuidgen 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')

# Wipe legacy state files from earlier codenames + old launcher format. The
# new state lives in server.json (single file). Leftover *.pid / *.port files
# would never be read, so just unlink them so users don't get confused.
rm -f \
  "$HOME/.pmmap/server.pid" "$HOME/.pmmap/server.port" \
  "$HOME/.hove/server.pid" "$HOME/.hove/server.port" \
  "$STATE_DIR/server.pid" "$STATE_DIR/server.port" \
  2>/dev/null || true

cd "$PROJECT_DIR" 2>/dev/null || {
  osascript -e "display dialog \"OPEN GROUND could not find its project folder:\n${PROJECT_DIR}\" buttons {\"OK\"} default button 1 with icon stop with title \"OPEN GROUND\"" >/dev/null 2>&1 || true
  exit 1
}

# ===== STASH GUARD ==========================================================
# Stashes are invisible inside the app and have historically caused
# "where did my changes go?" panic. Warn early, non-blocking.
if git -C "$PROJECT_DIR" rev-parse --git-dir &>/dev/null; then
  stash_count=$(git -C "$PROJECT_DIR" stash list 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$stash_count" -gt 0 ]]; then
    osascript -e "display dialog \"OPEN GROUND has ${stash_count} stashed change(s) that are not visible in the app.\n\nRun: git stash pop\nin the OPEN GROUND project directory to restore them, or git stash drop to discard.\" buttons {\"OK\"} default button 1 with icon caution with title \"OPEN GROUND — Stashed Changes Found\"" >/dev/null 2>&1 &
  fi
fi

# ============================================================================
# Shared helpers
# ============================================================================

fatal() {
  echo "[openground] FATAL: $1" >>"$LOG"
  osascript -e "display dialog \"OPEN GROUND could not start — $1. See $LOG for details.\" buttons {\"OK\"} default button 1 with icon stop with title \"OPEN GROUND\"" >/dev/null 2>&1 || true
  exit 1
}

proc_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    proc_tree "$child"
  done
  echo "$pid"
}

kill_tree() {
  local pids
  pids=$(proc_tree "$1")
  [[ -n "$pids" ]] || return 0
  kill -TERM ${=pids} 2>/dev/null
  sleep 1
  kill -KILL ${=pids} 2>/dev/null
  return 0
}

# Fetch /api/health from BASE_URL, echo the body, return 0 on 2xx + non-empty
# body. Short timeout — this is on the hot path.
health_body() {
  local timeout="${1:-2}"
  curl -fsS --max-time "$timeout" "$HEALTH_URL" 2>/dev/null
}

# Pull a string field out of /api/health JSON. We avoid jq (not guaranteed on
# user machines) and use a minimal sed-based extractor. JSON is server-emitted
# and well-formed (zod-validated route), so this is safe.
json_field() {
  local body="$1" key="$2"
  printf '%s' "$body" \
    | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    | head -1
}

# Source the activation helpers (verified_open_window, raise_existing_chrome_window).
ACTIVATE_SH="$(dirname "$0")/openground-activate.sh"
if [[ ! -r "$ACTIVATE_SH" ]]; then
  fatal "missing helper script: $ACTIVATE_SH"
fi
# shellcheck disable=SC1090
source "$ACTIVATE_SH"

# ============================================================================
# STEP 1: identity probe — is OPEN GROUND already running for THIS checkout?
# ============================================================================
# We deliberately probe BEFORE taking the lock. The common case for a
# double-click is "already running" — no lock needed, just raise the window.

probe_existing() {
  local body app probed_project
  body=$(health_body 5) || return 1
  app=$(json_field "$body" "app")
  if [[ "$app" != "openground" ]]; then
    # Port 47776 is listening, but it's not us. Caller decides whether to
    # treat that as foreign-process fatal.
    return 2
  fi
  probed_project=$(json_field "$body" "projectDir")
  if [[ "$probed_project" != "$PROJECT_DIR" ]]; then
    osascript -e "display dialog \"OPEN GROUND is already running from another checkout:\n${probed_project}\n\nQuit it (Cmd+Q in its window or close OPEN GROUND.app) before launching this one:\n${PROJECT_DIR}\" buttons {\"OK\"} default button 1 with icon stop with title \"OPEN GROUND\"" >/dev/null 2>&1 || true
    exit 1
  fi
  return 0
}

if probe_existing; then
  echo "[openground] existing server detected — raising window $(date)" >>"$LOG"
  verified_open_window "$BASE_URL" || true
  exit 0
fi

# ============================================================================
# STEP 2: port conflict check — is something foreign holding 47776?
# ============================================================================
# probe_existing returned non-zero. Either:
#   - nothing is listening (curl failed) → proceed to bootstrap.
#   - port 47776 is taken but not by OPEN GROUND → fatal with a useful dialog.

LISTEN_PIDS=$(lsof -ti "tcp:${FIXED_PORT}" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$LISTEN_PIDS" ]]; then
  # Re-probe once with a longer timeout in case the existing server was just
  # slow to respond (cold compile).
  if probe_existing; then
    echo "[openground] late-detected existing server — raising window" >>"$LOG"
    verified_open_window "$BASE_URL" || true
    exit 0
  fi

  # Something foreign. Build a friendly identification of the squatter.
  first_pid=$(echo "$LISTEN_PIDS" | head -1)
  foreign_cmd=$(ps -p "$first_pid" -o comm= 2>/dev/null || echo "unknown")
  foreign_cwd=$(lsof -a -d cwd -p "$first_pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  osascript -e "display dialog \"Port ${FIXED_PORT} is held by another process.\n\nPID: ${first_pid}\nCommand: ${foreign_cmd}\nCwd: ${foreign_cwd:-unknown}\n\nFree the port (quit that process) and re-launch OPEN GROUND.\" buttons {\"OK\"} default button 1 with icon stop with title \"OPEN GROUND — Port In Use\"" >/dev/null 2>&1 || true
  echo "[openground] port ${FIXED_PORT} held by foreign pid=${first_pid} cmd=${foreign_cmd}" >>"$LOG"
  exit 1
fi

# ============================================================================
# STEP 3: bootstrap lock — single-writer guarantee while spawning the server
# ============================================================================
# `mkdir` is atomic on APFS — exactly one launcher wins the race. flock(1)
# isn't available on macOS, so this is the canonical workaround.

acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    # Lock is held. Maybe the other launcher just finished and the server is
    # now healthy → re-probe and exit.
    if probe_existing; then
      echo "[openground] another launcher won the race — raising window" >>"$LOG"
      verified_open_window "$BASE_URL" || true
      exit 0
    fi

    # 10s timeout: check if the lock's owner is dead and steal.
    if (( waited >= 50 )); then  # 50 * 0.2s = 10s
      local owner_pid
      owner_pid=$(cat "$LOCK_DIR/owner-pid" 2>/dev/null || true)
      if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
        echo "[openground] stealing stale bootstrap lock from dead pid=$owner_pid" >>"$LOG"
        rm -rf "$LOCK_DIR"
        continue
      fi
      # Owner alive but slow — give it more time. Reset counter.
      waited=0
    fi

    sleep 0.2
    waited=$((waited + 1))
  done

  echo $$ >"$LOCK_DIR/owner-pid"
}

acquire_lock

# Fresh launch from here — clear the log so users see only this attempt.
: >"$LOG"
echo "[openground] launch bootId=$BOOT_ID pid=$$ $(date)" >>"$LOG"

# Cleanup must run no matter how we exit. Set the trap AFTER acquiring the
# lock so a probe-and-exit doesn't tear down state we don't own.
cleanup() {
  trap - TERM INT EXIT
  [[ -n "${SERVER_PID:-}" ]] && kill_tree "$SERVER_PID"
  rm -f "$SERVER_JSON" "$SERVER_JSON_TMP"
  rm -rf "$LOCK_DIR"
  exit 0
}
trap cleanup TERM INT EXIT

# ============================================================================
# STEP 4: reclaim a stale leftover, if any
# ============================================================================
# A previous launcher may have died (kernel panic, force-quit) leaving:
#   - server.json with a launcherPid that's now dead
#   - port 47776 still occupied by the orphaned next-server tree
# Identify ours via /api/health (app == openground) and kill the tree.

if [[ -f "$SERVER_JSON" ]]; then
  prev_launcher_pid=$(json_field "$(cat "$SERVER_JSON" 2>/dev/null || true)" "launcherPid")
  if [[ -n "$prev_launcher_pid" ]] && ! kill -0 "$prev_launcher_pid" 2>/dev/null; then
    leftover_pids=$(lsof -ti "tcp:${FIXED_PORT}" -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "$leftover_pids" ]]; then
      # Verify it's an OPEN GROUND server before murdering it.
      body=$(health_body 2 || true)
      if [[ -n "$body" && "$(json_field "$body" "app")" == "openground" ]]; then
        echo "[openground] reclaiming orphaned server pids=$leftover_pids" >>"$LOG"
        for p in ${=leftover_pids}; do kill_tree "$p"; done
        # Wait up to 3s for the port to free.
        for i in {1..15}; do
          lsof -ti "tcp:${FIXED_PORT}" -sTCP:LISTEN >/dev/null 2>&1 || break
          sleep 0.2
        done
        if lsof -ti "tcp:${FIXED_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
          fatal "could not free port ${FIXED_PORT} after killing orphaned server"
        fi
      fi
    fi
  fi
  rm -f "$SERVER_JSON"
fi

# ============================================================================
# STEP 5: spawn the dev server
# ============================================================================
echo "[openground] starting dev server on ${HOST}:${FIXED_PORT}" >>"$LOG"
START_EPOCH=$(date +%s)
HOSTNAME="$HOST" PORT="$FIXED_PORT" \
OPENGROUND_BOOT_ID="$BOOT_ID" \
OPENGROUND_PROJECT_DIR="$PROJECT_DIR" \
  npm run dev >>"$LOG" 2>&1 &
SERVER_PID=$!

# ============================================================================
# STEP 6: readiness probe with identity check
# ============================================================================
# We require /api/health to return 200 AND bootId == $BOOT_ID. That's the
# only way to know the listener is OUR process (not a leftover or a foreign
# squatter that beat us to the port).
READY=0
for i in {1..480}; do  # 480 * 0.25s = 120s
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[openground] --- last 40 lines of $LOG ---" >>"$LOG"
    tail -n 40 "$LOG" >>"$LOG.tail" 2>/dev/null || true
    fatal "the dev server died before becoming ready"
  fi

  # Hard fail if Next reports EADDRINUSE — auto-increment is not allowed.
  # We pinned PORT=$FIXED_PORT, so this means someone grabbed the port
  # between our STEP 2 check and Next's bind. Restarting won't help.
  if grep -q "EADDRINUSE" "$LOG" 2>/dev/null; then
    fatal "port ${FIXED_PORT} was taken before the dev server could bind (EADDRINUSE)"
  fi

  body=$(health_body 2 || true)
  if [[ -n "$body" ]]; then
    if [[ "$(json_field "$body" "bootId")" == "$BOOT_ID" ]]; then
      READY=1
      break
    fi
  fi
  sleep 0.25
done

if (( READY == 0 )); then
  fatal "the dev server did not become ready within 120s"
fi
echo "[openground] dev server ready pid=$SERVER_PID port=$FIXED_PORT" >>"$LOG"

# ============================================================================
# STEP 7: atomically commit server.json
# ============================================================================
# tmp file + sync + mv — readers always see a complete file or no file.
cat >"$SERVER_JSON_TMP" <<EOF
{
  "version": 1,
  "launcherPid": $$,
  "serverPid": $SERVER_PID,
  "port": $FIXED_PORT,
  "host": "$HOST",
  "projectDir": "$PROJECT_DIR",
  "bootId": "$BOOT_ID",
  "startedAt": $START_EPOCH
}
EOF
sync
mv -f "$SERVER_JSON_TMP" "$SERVER_JSON"

# Lock has served its purpose — server.json is the new source of truth.
# Keep the trap, but readers will look at server.json from now on.

# ============================================================================
# STEP 8: open the chrome-less --app window
# ============================================================================
if ! verified_open_window "$BASE_URL"; then
  fatal "could not open the OPEN GROUND window (Chrome automation denied?)"
fi
echo "[openground] window open — entering watchdog $(date)" >>"$LOG"

# ============================================================================
# STEP 9: watchdog loop
# ============================================================================
# Restart on hang/crash, but ONLY within a bounded crash budget so a hard
# crash loop doesn't hammer forever. We reuse the same BOOT_ID across
# restarts — server.json is not rewritten, the dev server identifies itself
# by the env var we re-pass.

MAX_RESTARTS=5
RESTART_WINDOW_SEC=120
typeset -a RESTART_TIMES
RESTART_TIMES=()

HEALTH_CHECK_INTERVAL_SEC=30
HEALTH_FAIL_THRESHOLD=4   # ~2min of consecutive failures = hung
HEALTH_CHECK_TIMEOUT_SEC=5
health_fails=0
LAST_OK_EPOCH=$(date +%s)

# Did /api/health respond 2xx within timeout? Stricter than just checking
# headers — we hit a real route so a half-broken Next.js (vendor chunks gone,
# crashed middleware) shows up here as a failure.
health_ok() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time "$HEALTH_CHECK_TIMEOUT_SEC" \
    "$HEALTH_URL" 2>/dev/null)
  [[ "$code" =~ ^2 ]]
}

while true; do
  sleep "$HEALTH_CHECK_INTERVAL_SEC"

  NOW=$(date +%s)
  # Sleep/wake heuristic: if more than 90s of wall-clock elapsed since our
  # last success, the machine probably slept. Reset failures rather than
  # restarting on a misdiagnosed "hang."
  if (( NOW - LAST_OK_EPOCH > 90 )) && (( health_fails > 0 )); then
    echo "[watchdog] long gap since last OK (${NOW}-${LAST_OK_EPOCH}s) — assuming sleep/wake, resetting fails" >>"$LOG"
    health_fails=0
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    health_fails=0
    EXIT_CODE="dead"
  elif health_ok; then
    health_fails=0
    LAST_OK_EPOCH=$NOW
    continue
  else
    health_fails=$((health_fails + 1))
    if (( health_fails < HEALTH_FAIL_THRESHOLD )); then
      echo "[watchdog] health check failed (${health_fails}/${HEALTH_FAIL_THRESHOLD})" >>"$LOG"
      continue
    fi
    echo "[watchdog] dev server hung — killing pid=$SERVER_PID" >>"$LOG"
    kill_tree "$SERVER_PID"
    sleep 1
    health_fails=0
    EXIT_CODE="hung"
  fi

  # Budget check.
  typeset -a kept
  kept=()
  for t in "${RESTART_TIMES[@]}"; do
    (( NOW - t < RESTART_WINDOW_SEC )) && kept+=($t)
  done
  RESTART_TIMES=("${kept[@]}")
  if (( ${#RESTART_TIMES[@]} >= MAX_RESTARTS )); then
    echo "[watchdog] dev server crashed ${MAX_RESTARTS}+ times in ${RESTART_WINDOW_SEC}s — giving up. exit=$EXIT_CODE" >>"$LOG"
    fatal "dev server crashed repeatedly (see $LOG)"
  fi
  RESTART_TIMES+=($NOW)

  echo "[watchdog] restarting dev server (${#RESTART_TIMES[@]}/${MAX_RESTARTS}) exit=$EXIT_CODE $(date)" >>"$LOG"
  sleep 2

  HOSTNAME="$HOST" PORT="$FIXED_PORT" \
  OPENGROUND_BOOT_ID="$BOOT_ID" \
  OPENGROUND_PROJECT_DIR="$PROJECT_DIR" \
    npm run dev >>"$LOG" 2>&1 &
  SERVER_PID=$!

  # Wait for /api/health to confirm the restarted server matches our bootId.
  # Hard-fail on EADDRINUSE: if the port wasn't freed cleanly, restarting
  # again is pointless.
  RESTART_READY=0
  for i in {1..480}; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[watchdog] restarted server died immediately" >>"$LOG"
      break
    fi
    if grep -q "EADDRINUSE" "$LOG" 2>/dev/null; then
      fatal "port ${FIXED_PORT} not released after restart (EADDRINUSE)"
    fi
    body=$(health_body 2 || true)
    if [[ -n "$body" && "$(json_field "$body" "bootId")" == "$BOOT_ID" ]]; then
      RESTART_READY=1
      break
    fi
    sleep 0.25
  done

  if (( RESTART_READY == 1 )); then
    LAST_OK_EPOCH=$(date +%s)
    echo "[watchdog] back up pid=$SERVER_PID $(date)" >>"$LOG"
    # Note: we deliberately do NOT re-open the Chrome window. It's still
    # pointed at $BASE_URL and will reconnect on its own. Re-opening would
    # steal focus.
  else
    echo "[watchdog] restart attempt failed — will retry next cycle" >>"$LOG"
  fi
done
