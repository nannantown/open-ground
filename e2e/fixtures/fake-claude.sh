#!/bin/sh
# fake-claude.sh — deterministic stand-in for the real `claude` CLI in E2E.
#
# OPEN GROUND is subscription-only: there is no `claude` binary (and no live
# subscription) in CI, yet we want to exercise the WHOLE run flow — PTY launch,
# the observer tailing claude's session JSONL, OPENGROUND_RESULT parsing, the
# auto-/quit completion path, and the card summary surfacing. buildClaudeArgv
# (src/lib/server/claudeTerminal.ts) lets the suite point argv[0] at this script
# via OPENGROUND_CLAUDE_BIN, so the runner spawns us instead of real claude.
#
# What the runner/observer require (verified against observer.ts):
#   - Raw PTY stdout is NOT the run log — it goes to xterm.js. The run log and
#     OPENGROUND_RESULT are read ONLY from claude's session JSONL at
#     ~/.claude/projects/<hyphenated-realpath-cwd>/<session-id>.jsonl
#     (HOME is tmp-isolated in E2E, so this never touches the real ~/.claude).
#   - formatEvent() renders an `assistant` event's text blocks into the log, so
#     we emit one assistant text block carrying the OPENGROUND_RESULT marker.
#   - taskComplete:true makes the observer seed `/quit`; we've already exited, so
#     the wrapping shell's `; exit` closes the PTY and the run finalises as done.
#
# Customisable per-spec via env (all optional):
#   OPENGROUND_FAKE_SUMMARY       summary text on the result (default below)
#   OPENGROUND_FAKE_TOPIC         card hero topic
#   OPENGROUND_FAKE_TASKCOMPLETE  "false" to emit a non-complete (question) turn
#   OPENGROUND_FAKE_SLEEP_MS      delay before writing, to test the running state

set -u

# --- readiness probe: claudeConnection.ts runs `<bin> auth status` up front --
# The run route's 503 gate ("claude CLI not found") reads this before we ever
# get a --session-id, so answer with a signed-in JSON status. (--version is
# kept below as a harmless fallback for any other caller.)
if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
  printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"e2e@example.com","subscriptionType":"max"}'
  exit 0
fi
case "${1:-}" in
  --version|-v)
    echo "fake-claude 0.0.0 (e2e stub)"
    exit 0
    ;;
esac

# --- parse --session-id / --resume out of argv -----------------------------
sid=""
prev=""
for a in "$@"; do
  case "$prev" in
    --session-id|--resume) sid="$a" ;;
  esac
  prev="$a"
done
# Without a session id we can't compute the JSONL path; bail visibly.
if [ -z "$sid" ]; then
  echo "fake-claude: no --session-id/--resume in argv" >&2
  exit 2
fi

# --- locate claude's session JSONL for THIS cwd ----------------------------
# Mirror claudeDirName(): realpath the cwd (collapses /tmp -> /private/tmp on
# macOS) then replace '/', '.', and space with '-'.
cwd=$(pwd -P)
dir=$(printf '%s' "$cwd" | sed 's/[/. ]/-/g')
projdir="$HOME/.claude/projects/$dir"
mkdir -p "$projdir"
jsonl="$projdir/$sid.jsonl"

# Optional artificial latency so a spec can observe the 'running' state first.
if [ -n "${OPENGROUND_FAKE_SLEEP_MS:-}" ]; then
  # sleep takes seconds; convert ms (integer division is fine for tests).
  secs=$(( ${OPENGROUND_FAKE_SLEEP_MS} / 1000 ))
  [ "$secs" -gt 0 ] && sleep "$secs"
fi

# --- render a positional task prompt, like the real TUI shows the message ---
# The drawer's 実行 launch passes the composed task prompt as the LAST argv
# (buildClaudeArgv contract: positional prompt last, via "$(cat <file>)").
# Real claude renders it in its TUI; print it to the PTY so the e2e can assert
# the task content reached the session via the SSE replay buffer. Recognized
# by the composed header instead of re-implementing argv flag parsing
# (--add-dir is variadic — a generic "last non-flag" scan would misfire).
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *"# Task:"*) printf '%s\n' "$last" ;;
esac

# --- build the OPENGROUND_RESULT payload -----------------------------------
summary=${OPENGROUND_FAKE_SUMMARY:-"Fake run complete."}
topic=${OPENGROUND_FAKE_TOPIC:-"E2E"}
taskcomplete=${OPENGROUND_FAKE_TASKCOMPLETE:-true}

# The result marker is the assistant's literal text. It contains JSON, so when
# we embed it as a JSON string value below every double-quote must be escaped.
result='OPENGROUND_RESULT: {"topic":"'"$topic"'","completed":["did the thing"],"skipped":[],"summary":"'"$summary"'","decisions":[],"blockers":"","taskComplete":'"$taskcomplete"'}'

# Escape backslashes then double-quotes for safe embedding in the JSONL string.
esc=$(printf '%s' "$result" | sed 's/\\/\\\\/g; s/"/\\"/g')

# --- write the session JSONL the observer tails ----------------------------
{
  printf '%s\n' '{"type":"system","subtype":"init","model":"fake-claude"}'
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$esc"
} >> "$jsonl"

# --- stay interactive like the real claude TUI ------------------------------
# Board sessions stay live after launch (the 実行 path auto-starts the task;
# follow-ups arrive via paste-task → PTY stdin, unsent), so the live-session
# UI (insert button enabled, no "exited" state) needs this process to keep
# reading stdin exactly like real claude waiting at its input box. The PTY's
# canonical echo renders
# whatever is pasted, which the e2e asserts on. EOF (terminal killed / PTY
# closed) ends us; OPENGROUND_FAKE_EXIT=immediate restores the old
# fire-and-quit behaviour for any spec that wants a finished session.
if [ "${OPENGROUND_FAKE_EXIT:-stay}" = "immediate" ]; then
  exit 0
fi
cat > /dev/null

exit 0
