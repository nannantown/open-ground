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

# --- readiness probe: claudeCli.ts runs `<bin> --version` up front ----------
# probeClaudeCli() gates every run on this; answer it so the run route doesn't
# 503 ("claude CLI not found") before we ever get a --session-id.
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
# Board sessions launch PLAIN and get the task content injected later
# (paste-task → PTY stdin, unsent), so the live-session UI (insert button
# enabled, no "exited" state) needs this process to keep reading stdin exactly
# like real claude waiting at its input box. The PTY's canonical echo renders
# whatever is pasted, which the e2e asserts on. EOF (terminal killed / PTY
# closed) ends us; OPENGROUND_FAKE_EXIT=immediate restores the old
# fire-and-quit behaviour for any spec that wants a finished session.
if [ "${OPENGROUND_FAKE_EXIT:-stay}" = "immediate" ]; then
  exit 0
fi
cat > /dev/null

exit 0
