#!/usr/bin/env bash
# openground-research-doctor.sh - managed-by: openground - auto-deployed on
# launch, hand edits overwritten. Canonical: scripts/openground-research-doctor.sh
# in the OPEN GROUND repo. Remove marker -> treated as user-authored, stops
# updating. (Basename is openground-prefixed so it can never collide with a
# user's own file - the swarm-lib.sh lesson, see swarmToolingInstall.ts.)
#
# LOCAL-ONLY channel diagnosis for the /research skill (multi-platform
# research routing, docs/RESEARCH_REACH_NOTES.md). Contract - pinned by
# researchSystem.test.ts, keep all three:
#   1. NEVER touches the network: binary presence (command -v), env vars and
#      a local `python3 -c import` only - so it can never hang a worker's
#      first step behind a dead proxy. (The curl/Jina STRINGS below are
#      printed hints, never executed here.)
#   2. ALWAYS exits 0 - a missing tool is a report line, not an error.
#   3. One line per channel: "[ok]|[part]|[miss] <channel> - <state>. <hint>"
#      [ok] usable / [part] partly usable / [miss] not set up. ASCII marks
#      on purpose (stable across PTY/SDK renderers and greppable).
set -u

say() { printf '%s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

say "research channels (local check only - no network; routing: ~/.claude/skills/research/SKILL.md)"

# web - the universal reader + final fallback (Jina Reader, plain fetch).
if has curl; then
  say "[ok]   web       - curl present (Jina Reader: curl https://r.jina.ai/<URL>; plain fetch as last resort)"
else
  say "[miss] web       - curl not found. macOS ships it; linux: install curl via your package manager"
fi

# websearch - Exa via mcporter.
if has mcporter; then
  say "[ok]   websearch - mcporter present (Exa: mcporter call 'exa.web_search_exa(query: \"...\", numResults: 5)')"
else
  say "[miss] websearch - mcporter not found. npm i -g mcporter (Exa runs on a free key)"
fi

# twitter/x - single posts need no auth; search/timeline needs cookie env.
if has twitter; then
  if [ -n "${TWITTER_AUTH_TOKEN:-}" ] && [ -n "${TWITTER_CT0:-}" ]; then
    say "[ok]   twitter   - twitter-cli + cookie env set (single posts AND search/timeline)"
  else
    say "[part] twitter   - twitter-cli present; single posts work, search/timeline needs cookies (export TWITTER_AUTH_TOKEN + TWITTER_CT0, browser-exported, LOCAL ONLY)"
  fi
else
  say "[miss] twitter   - twitter-cli not found (install: see Panniantong/Agent-Reach README)"
fi

# reddit - auth state is not locally verifiable, so present = [part], honest.
if has rdt; then
  say "[part] reddit    - rdt present; auth not locally verifiable (if search 403s: rdt login)"
else
  say "[miss] reddit    - rdt-cli not found (install: see Panniantong/Agent-Reach README)"
fi

# youtube (+ bilibili rides the same binary).
if has yt-dlp; then
  say "[ok]   youtube   - yt-dlp present (metadata --dump-json / subtitles --write-sub; bilibili too)"
else
  say "[miss] youtube   - yt-dlp not found. brew install yt-dlp (or pipx install yt-dlp)"
fi

# github - public reads need no auth at all.
if has gh; then
  say "[ok]   github    - gh present (public repos need no auth; gh auth login unlocks more)"
else
  say "[miss] github    - gh not found. brew install gh"
fi

# rss - python3 + feedparser. The import is a LOCAL exec of the user's own
# python (no network); worst case it fails fast and we report [part].
if has python3; then
  if python3 -c 'import feedparser' >/dev/null 2>&1; then
    say "[ok]   rss       - python3 + feedparser present"
  else
    say "[part] rss       - python3 present, feedparser missing. pip3 install feedparser"
  fi
else
  say "[miss] rss       - python3 not found"
fi

exit 0
