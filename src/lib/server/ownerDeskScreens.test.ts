import { describe, it, expect } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import {
  WORKING_FOOTER_RE,
  conversationRows,
  inputBoxStart,
  isBannerRow,
  isChromeRow,
  utteranceBlocks,
} from '@/lib/claudeScreen'
import { readScreen } from './terminal'
import {
  CLI_LEAD_IN_RE,
  classifyQuotaRefusal,
  endsInQuotaRefusal,
  stripScreenChrome,
  normalizeScreen,
  OWNER_DESK_TAIL_MAX,
  OWNER_DESK_LEAD_MAX,
  QUOTA_EXHAUSTION_PATTERNS,
  RATE_LIMIT_TAIL_MAX,
} from './swarmRateLimitText'
import {
  runOwnerDeskLimitPass,
  resetOwnerDeskLimitState,
  OWNER_DESK_QUIET_MS,
  OWNER_DESK_CONFIRM_MS,
  OWNER_DESK_MERGE_QUIET_MS,
} from './ownerDeskLimit'
import { SWARM_MODEL_TIERS } from '@/lib/types'

// REAL-GEOMETRY regression for the owner-desk sensor's detection core.
//
// WHY THIS FILE EXISTS, twice over.
//
// ROUND 1 (position). The first cut measured position as a character distance
// into the RAW screen, bounded by RATE_LIMIT_TAIL_MAX (800). Its unit test passed
// — because the "quoted the wording" fixture padded 800+ characters of prose after
// the quote, a screen shape that cannot occur in a 32-row terminal. At realistic
// sizes the whole viewport fits inside the 800-char tail, so the check degenerated
// into "the wording appears somewhere on screen" and ordinary conversations about
// usage limits notified the owner.
//
// ROUND 2 (anatomy, and the OTHER side of position). Adversarial review then found
// that fix broken in BOTH directions — with this suite green, because its fixtures
// drew a TUI that does not exist:
//   • MISSES. The input box was modelled as a `│ … │` bordered box. The real CLI
//     fences it with RULES around a `❯` prompt row (`╭──╮` is the welcome banner
//     alone — compare swarmQuestions.test.ts:24 with :37, both cut from live
//     frames). So a half-typed message, the spinner line, the usage meter and the
//     status footers all counted as CONVERSATION, pushing a real notice out of
//     position: the sensor went SILENT on the exact event it exists for.
//   • FIRES. A trailing-distance check alone cannot reject an utterance that ENDS
//     in a quote ("worker-2 is stuck, here is its screen:" + the notice). That is
//     not hypothetical — it is the commander and supply desks' daily work — and
//     all four FALSE fixtures happened to put a sentence AFTER the quote, so the
//     class was never covered.
//
// So: every case is rendered through a REAL @xterm/headless terminal at production
// geometry, read back with the same row walk terminal.ts uses, and asserted at
// THREE widths. Every fixture must also PROVE it is a regression test, by showing
// which shipped version got it wrong — see the two `v1`/`v2` guards below.

const ROWS = 32
const WIDTHS = [80, 120, 200]

/** The surface the desk sensor reads — terminal.ts's OWN frame reader, unwrapped.
 *
 *  Imported, not re-implemented. This file used to carry a hand-copy of that loop,
 *  which is a fixture pretending to be a pin: it can drift away from the code it
 *  claims to verify, and a suite whose whole subject is "fixtures that drew a TUI
 *  that does not exist" is the last place that should keep one (round 3 nit).
 *  Production reaches the same function through getTerminalScreenLogical, which
 *  these synthetic frames have no PTY to go through. */
const readScreenLogical = (term: HeadlessTerminal): string => readScreen(term, true)

const render = async (lines: string[], cols: number): Promise<string> => {
  const term = new HeadlessTerminal({ cols, rows: ROWS, allowProposedApi: true, scrollback: 0 })
  await new Promise<void>((res) => term.write(lines.join('\n').replace(/\n/g, '\r\n'), () => res()))
  return readScreenLogical(term)
}

// ── The TUI, as it actually renders ─────────────────────────────────────────
// Shapes taken from the live frames captured through terminal.ts's headless-xterm
// scrape (swarmQuestions.test.ts's fixture header, 2026-07-06). The input box is a
// `❯` row FENCED BY RULES — not a bordered box.

const RULE = (cols: number): string => '─'.repeat(Math.min(110, cols - 2))

/** claude's input box + shortcut hint, at the given width. */
const box = (cols: number, typed = ''): string[] => [
  RULE(cols),
  `❯ ${typed}`,
  RULE(cols),
  '  ? for shortcuts · ← for agents',
]

/** The status footers a working session paints under the box. */
const FOOTERS = ['  ⏵⏵ accept edits on', '  Context left until auto-compact: 12%']

/** The spinner + usage-meter rows claude paints between its last message and the
 *  input box. Both counted as conversation under the invented chrome model. */
const METER = [
  '✻ Brewed for 7s',
  "                You've used 100% of your Fable 5 limit · resets 3pm (Asia/Tokyo)",
]

/** The welcome banner — the ONE place the CLI really draws a bordered box. */
const BANNER = [
  '╭──────────────────────────────────────╮',
  '│ ✻ Welcome to Claude Code!            │',
  '╰──────────────────────────────────────╯',
  ' ⚠ 2 MCP servers need authentication · run /mcp',
]

/** VERBATIM off the owner's desk on 2026-07-18. 95 characters — wider than an
 *  80-column terminal, which is exactly why the wrap case is pinned below. */
const LIMIT =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

// ── The screens ─────────────────────────────────────────────────────────────

/** STOPPED — claude said the notice and nothing followed but the CLI's furniture. */
const REAL: Array<[string, (c: number) => string[]]> = [
  [
    'the 2026-07-18 notice, empty box',
    (c) => ['⏺ Reading terminal.ts…', '⏺ Updated 2 files', '', LIMIT, '', ...box(c)],
  ],
  [
    'the notice with a half-typed message left in the box',
    // The owner was mid-sentence when it died. What sits INSIDE the box is theirs,
    // not claude's — it must not push the notice out of position. Review repro (1).
    // The message is a real half-sentence rather than a token: anything shorter
    // than the tail allowance would fit inside it and the old model would have
    // stumbled into the right answer, making this a fixture that proves nothing.
    (c) => [
      '⏺ Updated 2 files',
      '',
      LIMIT,
      '',
      ...box(c, 'ビーコンの件だけど、あれって結局どこで出しているんだっけ'),
    ],
  ],
  [
    'the notice under a spinner and a 100% usage meter',
    // Review repro (2) — both rows read as conversation before the anatomy fix.
    (c) => ['⏺ Updated 2 files', '', LIMIT, '', ...METER, ...box(c)],
  ],
  [
    'the notice with the status footers below the box',
    // Review repro (3) — footers sit BELOW the input box, so the positional cut
    // takes them; the row patterns are belt to that braces.
    (c) => ['⏺ Updated 2 files', '', LIMIT, '', ...box(c), ...FOOTERS],
  ],
  [
    'the notice on a full frame — banner, meter, typed text and footers at once',
    (c) => [
      ...BANNER,
      '⏺ Updated 2 files',
      '',
      LIMIT,
      '',
      ...METER,
      ...box(c, 'ちょっと待って'),
      ...FOOTERS,
    ],
  ],
  [
    'the account-wide notice with its reset time',
    (c) => ['⏺ Working…', '', 'Claude usage limit reached. Your limit will reset at 3pm.', '', ...box(c)],
  ],
  // ROUND 3 (adversarial review, 2026-07-18). The reset sentence carries a
  // PARENTHESISED TIMEZONE, which the reset pattern used to stop short of — so the
  // zone counted as text trailing the notice. Tokyo left 21 trailing characters and
  // squeaked under the allowance; every zone with a longer name did not, and a real
  // account-wide stop went undetected. The threshold was never the bug, so these
  // are pinned at three zone lengths rather than by widening it.
  [
    'the account-wide notice, reset time with (Asia/Tokyo)',
    (c) => [
      '⏺ Working…',
      '',
      'Claude usage limit reached. Your limit will reset at 3pm (Asia/Tokyo).',
      '',
      ...box(c),
    ],
  ],
  [
    'the account-wide notice, reset time with (Europe/Amsterdam)',
    (c) => [
      '⏺ Working…',
      '',
      'Claude usage limit reached. Your limit will reset at 3pm (Europe/Amsterdam).',
      '',
      ...box(c),
    ],
  ],
  [
    'the account-wide notice, reset time with (America/Los_Angeles)',
    // The longest zone name in common use — 30 trailing characters under the old
    // pattern, against a 24 allowance. This fixture is the one that proves the
    // sensor no longer works only for an owner sitting in Tokyo.
    (c) => [
      '⏺ Working…',
      '',
      'Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles).',
      '',
      ...box(c),
    ],
  ],
  // ROUND 4 (adversarial review, 2026-07-18). Three ways the sensor could go SILENT
  // on a real stop — the direction that returns the owner to the pre-feature status
  // quo, and the one the round-3 rework made WORSE in two places.
  [
    'the notice HARD-WRAPPED into two column-0 rows',
    // If the CLI lays out its own wrapping (Ink does) rather than letting the
    // terminal soft-wrap, the 95-character notice arrives as two rows at 80 columns
    // and the round-3 NAMING gate saw only `switch models with /model.` — a
    // remedy-only match — and rejected the canonical event. Which way the real CLI
    // wraps could not be established from the captures, so the reader was made
    // indifferent to it instead: consecutive UNMARKED column-0 rows are one
    // utterance, because only `⏺`/`❯` can begin a turn.
    (c) => [
      '⏺ Updated 2 files',
      '',
      "You've reached your Fable 5 limit. Run /usage-credits to continue or",
      'switch models with /model.',
      '',
      ...box(c),
    ],
  ],
  [
    'a stop on a desk that had just READ the working-footer string',
    // `esc to interrupt` is ordinary text as well as a footer. Tested against the
    // whole frame, any desk displaying it — this feature's own source, the docs
    // that quote it — read as "busy" and could never report a stop again.
    (c) => [
      '⏺ Read(src/lib/claudeScreen.ts)',
      '  ⎿  65: export const WORKING_FOOTER_RE = /esc to interrupt/i',
      '',
      LIMIT,
      '',
      ...box(c),
    ],
  ],
  [
    'a stop where the owner typed the working-footer string into the box',
    // The same defect one row lower: scoping the search to the input box and below
    // still reads what the OWNER is typing. The footer strip is BELOW the box's
    // closing rule, and that is what may be searched.
    (c) => ['⏺ Updated 2 files', '', LIMIT, '', ...box(c, 'esc to interrupt って何?')],
  ],
  // ROUND 5 (adversarial review, 2026-07-18). Round 4 joined consecutive unmarked
  // column-0 rows so the reader would not care how the CLI wraps. The chrome list is
  // a CLOSED enumeration, so that turned every row it does not recognise — sitting
  // anywhere above the notice, blank rows do not separate them — into something that
  // folds into the notice and pushes it out of position. A larger class sold than
  // bought. The hard-wrap case moved to a second reading in the caller instead.
  [
    'a stop under an API error the chrome list does not know',
    // `API Error: 529 Overloaded` is attested in the engine's own fixtures.
    (c) => ['⏺ Working…', '', 'API Error: 529 Overloaded', LIMIT, '', ...box(c)],
  ],
  [
    'a stop under a retry line',
    (c) => ['⏺ Working…', '', 'Retrying in 30s… (attempt 2/5)', LIMIT, '', ...box(c)],
  ],
  [
    'a stop under a bare URL',
    (c) => ['⏺ Working…', '', 'https://claude.ai/settings/usage', LIMIT, '', ...box(c)],
  ],
  [
    'a stop whose turn marker drifted to another glyph',
    // `●` (U+25CF) instead of `⏺` (U+23FA). Under the round-4 join an unrecognised
    // marker made the row above merge into the notice; here it is simply a row.
    (c) => ['● Updated 2 files', '', LIMIT, '', ...box(c)],
  ],
  [
    'the STATUS-STRIP form of the notice, which the engine keeps verbatim',
    // `Claude usage limit reached · resets 3pm (Asia/Tokyo)` — 26 characters trail
    // the last match under the old pattern set, two over the allowance, so a real
    // account-wide stop was never reported. The CLI writes `reached · resets`, which
    // the `limit … reset` pattern cannot reach.
    (c) => ['⏺ Working…', '', 'Claude usage limit reached · resets 3pm (Asia/Tokyo)', '', ...box(c)],
  ],
  [
    'the account-wide notice in a THREE-component timezone',
    // Round 4 narrowed the zone to `region/city` and silenced every owner in
    // America/Argentina/Buenos_Aires, America/Indiana/Indianapolis and friends —
    // the same "works only where the author lives" defect, aimed at new victims.
    (c) => [
      '⏺ Working…',
      '',
      'Claude usage limit reached. Your limit will reset at 3pm (America/Argentina/Buenos_Aires).',
      '',
      ...box(c),
    ],
  ],
]

/** NOT stopped — the wording is on screen, but this session did not stop on it. */
const FALSE: Array<[string, (c: number) => string[]]> = [
  [
    'an answer that explains the usage gauge',
    // Matches the bare phrase "usage limit" on the LAST content line, so no amount
    // of position checking can reject it — the WORDING restriction has to.
    (c) => [
      '⏺ The UsageHud polls /api/usage every 30s and paints a gauge.',
      '  Thresholds live in usageThresholds.ts (80% amber / 100% red).',
      '  So when you hit the usage limit the gauge pins to red and stays there.',
      '',
      ...box(c),
    ],
  ],
  [
    'a summary that quotes the notice, then two lines of its own',
    (c) => [
      '⏺ The wording this branch pins is:',
      `    ${LIMIT}`,
      '  That string is matched by three independent patterns.',
      '  I kept them separate because the TUI wraps at the box edge.',
      '',
      ...box(c),
    ],
  ],
  [
    'a summary that quotes the notice, then ONE short sentence',
    // The tightest trailing false positive found: 34 characters follow the quote.
    (c) => ['⏺ The pinned wording is:', `    ${LIMIT}`, '  That is matched by three patterns.', '', ...box(c)],
  ],
  [
    'a plan that mentions the /model remedy',
    (c) => [
      '⏺ Plan: detect the stop and tell the owner to switch models with /model.',
      '  Step 1 — reuse the scrape. Step 2 — notify once. Step 3 — docs.',
      '',
      ...box(c),
    ],
  ],
  [
    'a commander report that ENDS by quoting a worker screen (JA)',
    // THE class review found uncovered, and the commander desk's daily work: the
    // quote is the last thing on screen, so the trailing check alone passes it.
    // Only the LEADING check — the preamble sits in the same utterance — rejects it.
    (c) => ['⏺ worker-2 が止まっています。画面に出ているのはこれです:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'a commander report that ENDS by quoting a worker screen (EN)',
    (c) => ['⏺ worker-2 is stuck. Here is what its screen shows:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'a report ending in the quote, with the meter and footers around it',
    (c) => ['⏺ 補給官の卓も同じ画面です。引用します:', `    ${LIMIT}`, '', ...METER, ...box(c), ...FOOTERS],
  ],
  [
    'a report ending in the quote WHILE the owner types their reply',
    // The two fixed defects crossed, and the commander's actual next move: the
    // report ends in the quote (MF-1's shape) and the owner has already started
    // answering, so the box is non-empty (MF-2's shape). Neither fix may lean on
    // the other being absent — the LEADING check must reject this on its own,
    // with the typed text correctly excluded from the conversation.
    (c) => [
      '⏺ worker-2 が止まっています。画面に出ているのはこれです:',
      `    ${LIMIT}`,
      '',
      ...box(c, 'じゃあ tier を落として再開して'),
      ...FOOTERS,
    ],
  ],
  [
    'the notice sitting in a tool-result gutter (⎿)',
    // `cat`-ing a captured worker screen, or any tool whose OUTPUT contains the
    // wording. The gutter is chrome, so the quote never enters the conversation
    // at all — a second, independent reason this cannot fire. Pinned because a
    // future chrome model that drops `⎿` would turn tool output into "what claude
    // said", and reading screens back is exactly what the commander desk does.
    (c) => ['⏺ Bash(cat /tmp/worker-2-screen.txt)', `  ⎿ ${LIMIT}`, '', ...box(c)],
  ],
  [
    'a session still GENERATING while the wording sits on screen',
    // esc-to-interrupt ⇒ claude is producing output; it has not stopped, whatever
    // its screen says. A pure negative — see isGenerating.
    (c) => [
      '⏺ Quoting the notice so we can pin it:',
      LIMIT,
      '',
      RULE(c),
      '❯ ',
      RULE(c),
      '  esc to interrupt · ← for agents',
    ],
  ],
  // ── ROUND 3 (adversarial review, 2026-07-18) ──────────────────────────────
  // All six defeated the LEAD+TAIL check that shipped in round 2, and all six are
  // the same structural hole: it bounded the two ENDPOINTS of the match and never
  // asked whether the wording COVERED the utterance. See v3EndpointsOnly.
  [
    'a report whose PREAMBLE itself names a limit, ending in the quote (EN)',
    // The lead check reads 0 here — not because there is no preamble, but because
    // the preamble's own first words match a pattern. Anyone reporting a quota stop
    // writes this sentence; the shipped fixtures escaped it only by happening to
    // phrase their preambles without the word "limit".
    (c) => ['⏺ Usage limit reached on worker-2. Its screen says:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'the same, in Japanese',
    (c) => ['⏺ Fable 5 limit reached です。worker-2 の画面はこれ:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'a report with a SHORT quote-introducer (引用します:)',
    // 7 characters of lead — exactly what a real notice leads with ("you've "). No
    // character budget can separate these two; only the colon can.
    (c) => ['⏺ 引用します:', `    ${LIMIT}`, '', ...box(c)],
  ],
  ['a report introduced by a bare "Screen:"', (c) => ['⏺ Screen:', `    ${LIMIT}`, '', ...box(c)]],
  [
    'a desk reading THIS feature’s own source',
    // The card asks for this class by name. The pattern list is quoted verbatim in
    // the source, so the utterance both opens and closes on limit wording.
    (c) => [
      '⏺ The refusal list is: reached your … limit, <qualifier> limit reached,',
      '  switch models with /model.',
      '',
      ...box(c),
    ],
  ],
  [
    'a tool-call row searching the source for the remedy line',
    // Clears every POSITIONAL gate — lead 12, tail 7, no interior gap — because the
    // wording genuinely is nearly all of that row. Only "the message must name what
    // ran out" rejects it: a remedy line alone is a conversation about the remedy.
    (c) => ['⏺ Bash(rg -n "switch models with /model" src/)', '  ⎿  70:  /switch models with \\/model\\b/,', '', ...box(c)],
  ],
  [
    'an ordinary answer that opens AND closes on limit wording',
    // Opens with "Usage limit reached…", closes with "…run /usage-credits": lead 0,
    // tail 1, and 65 characters of ordinary prose in between. The endpoint checks
    // are blind to it by construction; the interior-gap check is what sees it.
    (c) => [
      '⏺ Usage limit reached means the plan window is spent. The only thing that',
      '  helps is to run /usage-credits.',
      '',
      ...box(c),
    ],
  ],
  [
    'the owner PASTED the notice into the box and sent it',
    // Byte-identical to a real stop once the turn marker is stripped — no measure of
    // the text can separate them. Only remembering WHO said it can: `❯` opens the
    // owner's own turn.
    (c) => [`❯ ${LIMIT}`, '', ...box(c)],
  ],
  // ── ROUND 4 (adversarial review, 2026-07-18) ──────────────────────────────
  // (a) Preambles with NO punctuation. Round 3 rejected a quote-introducer by
  // blacklisting `:`, which left every unpunctuated lead-in open. Enumerating the
  // marks a human might introduce a quotation with is unbounded; the CLI's own
  // run-up is two words long, so the lead is a WHITELIST now.
  ['a report introduced by an unpunctuated "Screen"', (c) => ['⏺ Screen', `    ${LIMIT}`, '', ...box(c)]],
  ['…by an unpunctuated 画面はこれ', (c) => ['⏺ 画面はこれ', `    ${LIMIT}`, '', ...box(c)]],
  ['…by an unpunctuated 結果', (c) => ['⏺ 結果', `    ${LIMIT}`, '', ...box(c)]],
  ['…by an em-dash, which no punctuation blacklist covered', (c) => ['⏺ worker-2 —', `    ${LIMIT}`, '', ...box(c)]],
  // (b) Sentences that merely MENTION a reset time. Round 3 widened the reset
  // pattern to swallow a trailing timezone and widened it too far: `[^\s.]+` plus
  // `[^)]{0,40}` ate whole clauses, so these ended flush against the match.
  [
    'a sentence quoting what the usage meter prints',
    (c) => ['⏺ メータは your limit will reset at 3pm (Asia/Tokyo) を出す。', '', ...box(c)],
  ],
  [
    'a reset time with a prose parenthetical',
    (c) => ['⏺ The limit will reset at midnight (about 6 hours from now).', '', ...box(c)],
  ],
  [
    'a bare statement of when the limit resets',
    // Says nothing about anything being exhausted — it is what the meter shows with
    // 88% still unused. The reset sentence is in the refusal list for POSITION only,
    // so it must not count as the message naming its own cause.
    (c) => ['⏺ Your limit will reset at 3pm (Asia/Tokyo).', '', ...box(c)],
  ],
  // (c) MULTI-LINE tool output. Only a result's FIRST row carries `⎿`; its
  // continuation rows are plain indented rows that merged into the `⏺ Bash(…)`
  // header block. Reading back a worker's captured screen is the commander desk's
  // daily work — and the round-3 gutter fixture passed only because its header
  // happened to be long enough to blow the lead budget, i.e. for the wrong reason.
  // ROUND 5. The lead whitelist was written as "one lowercase word", which the
  // canonical notice hid: its own `you've` makes any preamble the SECOND word. The
  // STATUS-STRIP notice starts its match at offset 0, so a one-word preamble sits
  // alone in the lead and passed. The whitelist is the literal CLI vocabulary now.
  [
    'a one-word preamble above the status-strip notice',
    (c) => ['⏺ Screen', '    5-hour limit reached ∙ resets 3pm', '', ...box(c)],
  ],
  // ROUND 6. The status-strip pattern round 5 added was written as a bare
  // `\bresets?\s+\d`, which matches mid-sentence. Because the gap check runs over
  // MERGED spans, a stray "resets N" became a STEPPING STONE that halved an
  // over-budget gap and re-opened the class the gap check exists to close.
  [
    'an answer whose middle happens to mention a reset time',
    (c) => ['⏺ Usage limit reached means the window resets 5 hours later; run /usage-credits.', '', ...box(c)],
  ],
  [
    'the same with an em-dash and a nearer reset',
    (c) => ['⏺ Weekly limit reached — it resets 3pm, so just run /usage-credits.', '', ...box(c)],
  ],
  [
    'the same in Japanese, wrapped over two rows',
    (c) => ['⏺ Weekly limit reached は週枠。resets 3pm に戻るので、', '  それまで待つか run /usage-credits。', '', ...box(c)],
  ],
  // ROUND 8 — the interior-colon rule's own fixtures. The two above are rejected by
  // gap LENGTH, so they pin nothing about the colon; these keep the gap SHORT so the
  // colon is the only thing standing between them and a spurious bell. This is the
  // shape a desk produces when it reports a per-model stop it is looking at.
  // ROUND 9 — the status-strip pattern's REACH became a bypass. Round 8 let it take
  // 48 characters of anything after the anchor, so a hand-off colon landed INSIDE a
  // matched span where the introducer check (which only inspected the gaps between
  // spans) could not see it. Both the reach and the introducer check were fixed:
  // the reach now takes only a reset LABEL, and the check now runs over the whole
  // covered region. These pin the bypass from the outside.
  [
    'a preamble whose RESET SENTENCE swallows the hand-off colon',
    // ⚠ The fixture that isolates the covered-region introducer check. Every other
    // colon case here is also rejected by the reach bound or by gap length, so
    // mutating that check alone left the whole suite green — a guard nothing pins
    // (round 5's own lesson, and what produced rounds 6, 8 and 9). Here the colon is
    // swallowed by the RESET pattern's `\s+at\s+[^\s.]+`, which is outside the
    // strip's reach bound, so only the covered-region check can see it. The hand-off
    // is Japanese because the English form runs 24 characters and gap LENGTH catches
    // that one first.
    (c) => ['⏺ Usage limit reached. Your limit will reset at 3pm: 画面', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'a report whose preamble carries a reset time before handing off',
    (c) => ['⏺ Usage limit reached · resets 3pm, worker-2 screen:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'the same in Japanese',
    (c) => ['⏺ Usage limit reached · resets 3pm、worker-2 の画面:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'the same with an em-dash separator',
    (c) => ['⏺ Usage limit reached — resets 3pm, screen:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'an answer that joins two clauses with a plain hyphen',
    // The separator class briefly admitted a plain `-`, which turns ordinary dash
    // prose into an anchor; the reach then bridged to the remedy line and erased the
    // interior gap entirely. Separator and reach are two decisions, and this pins
    // the separator one.
    (c) => ['⏺ Usage limit reached - resets in 5 hours; until then run /usage-credits.', '', ...box(c)],
  ],
  [
    'a per-model report that hands off to a quote with a colon',
    (c) => ['⏺ Fable 5 limit reached. Screen:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'the same in Japanese',
    (c) => ['⏺ Fable 5 limit reached。画面:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'the same with an account-wide preamble',
    // Pre-existing since round 5, not a round-7 regression: the preamble is itself a
    // limit announcement, so the match starts at offset 0 and the LEAD gate never
    // engages. Only the interior colon sees it.
    (c) => ['⏺ Usage limit reached. Screen:', `    ${LIMIT}`, '', ...box(c)],
  ],
  [
    'a short introducer above a complete notice, both unmarked',
    // The second reading (added in round 5 for hard wrap) re-judges the last block
    // joined with the one above it. Unconditioned, that BYPASSES the lead gate: the
    // joined text's lead is whatever precedes the FIRST match, so an introducer that
    // itself opens on limit wording zeroes it. The retry is now restricted to the
    // shape it was built for — a final block carrying ONLY the remedy sentence.
    (c) => ['⏺ Working…', '', 'Usage limit reached.', `Screen: ${LIMIT}`, '', ...box(c)],
  ],
  [
    'an indented notice whose header has scrolled off the frame',
    // Nothing above it to continue: equally the tail of something claude said and
    // the tail of a captured screen being read back. Missing evidence, not evidence
    // — see the `orphan` speaker.
    (c) => [`     ${LIMIT}`, '', ...box(c)],
  ],
  [
    'a captured worker screen printed by a tool, under a SHORT header',
    // The header is short enough that round 3's lead BUDGET did not reject it (22 of
    // 24), so this one is a genuine round-3 false positive. Its longer-header
    // sibling was dropped in round 5: with faithful round-3 anatomy that one
    // measured lead 31 and round 3 rejected it too, so it demonstrated no defect —
    // it passed because a path happened to be long, the very "wrong reason" this
    // suite exists to catch.
    (c) => ['⏺ Read(w2.txt)', '  ⎿  ⏺ Working…', `     ${LIMIT}`, '', ...box(c)],
  ],
]

// ── Guard the guards ────────────────────────────────────────────────────────
// A fixture that drifts into a shape the previous version ALREADY handled would
// pass for the wrong reason — the exact mistake this suite exists to prevent
// (twice over: the first shipped test padded 800 characters of prose, the second
// drew an input box the CLI does not render). So each fixture asserts WHICH
// shipped version it catches.

/** Distance from the end of the LAST pattern match to the end of `text`, or -1. */
const tailAfterLastMatch = (text: string, patterns: readonly RegExp[]): number => {
  const norm = normalizeScreen(text)
  let lastEnd = -1
  for (const re of patterns) {
    const scan = new RegExp(re.source, `${re.flags.replace('g', '')}g`)
    for (let m = scan.exec(norm); m; m = scan.exec(norm)) lastEnd = Math.max(lastEnd, m.index + m[0].length)
  }
  return lastEnd < 0 ? -1 : norm.length - lastEnd
}

/** VERSION 1 — quota wording anywhere within 800 RAW characters of the screen's
 *  end. What shipped before the position fix. */
const v1RawTail = (screen: string): boolean => {
  const d = tailAfterLastMatch(screen, QUOTA_EXHAUSTION_PATTERNS)
  return d >= 0 && d <= RATE_LIMIT_TAIL_MAX
}

/** VERSION 2 — the refusal wording at the end of the conversation, where
 *  "conversation" came from the INVENTED chrome model (blank / box-glyph rules / a
 *  row delimited by box glyphs at both ends / a short `?` hint). Reproduced here so
 *  the fixtures can prove what it got wrong, in both directions. */
const v2InventedChrome = (screen: string): boolean => {
  const BOX_DRAWING = /[─-╿]/
  const isChromeLine = (line: string): boolean => {
    const t = line.trim()
    if (!t) return true
    if (!/[^\s─-╿]/.test(t)) return true
    if (BOX_DRAWING.test(t[0]) && BOX_DRAWING.test(t[t.length - 1])) return true
    if (t.startsWith('?') && t.length <= 40) return true
    return false
  }
  const stripped = screen
    .split('\n')
    .filter((l) => !isChromeLine(l))
    .join('\n')
  const d = tailAfterLastMatch(stripped, V3_PATTERNS)
  return d >= 0 && d <= OWNER_DESK_TAIL_MAX
}

// ── The historical versions, pinned ─────────────────────────────────────────
// These must NOT derive from today's exports. Round 5 caught the reason: the
// reproductions were reading today's `QUOTA_REFUSAL_PATTERNS` and today's anatomy
// functions, so every later change silently rewrote what "the old version did" —
// and the suite then mis-attributed which version had been broken (it reported that
// round 3 stayed quiet on a screen round 3 actually fired on). A historical
// reproduction that tracks HEAD proves nothing. Everything below is a literal.

/** The refusal patterns as of rounds 2–3: the four base ones the owner-desk arm has
 *  always used, plus a reset sentence that stopped at the word "reset" (leaving
 *  ` at 3pm (Europe/Amsterdam).` to read as text trailing the notice) and WITHOUT
 *  the status-strip form (`… reached · resets 3pm`) added in round 5. */
const V3_PATTERNS: readonly RegExp[] = [
  /reached your .{0,40}\blimit\b/,
  /\b(?:\d+[\w.-]*|usage|model|session|weekly|your)\s+limit reached\b/,
  /switch models with \/model\b/,
  /\brun \/usage-credits\b/,
  /limit (?:will )?reset/,
]

/** The frame anatomy as of round 3 — before the footer-strip scoping of
 *  `isGenerating`, the `⎿` tool-result run in `conversationRows`, and the `orphan`
 *  speaker. `inputBoxStart` / `isChromeRow` / `isBannerRow` are unchanged since, so
 *  they are imported rather than copied. */
const v3IsGenerating = (screen: string): boolean => WORKING_FOOTER_RE.test(screen)

const v3ConversationRows = (screen: string): string[] => {
  const rows = screen.split('\n')
  return rows.slice(0, inputBoxStart(rows)).filter((r) => !isChromeRow(r) && !isBannerRow(r))
}

const v3UtteranceBlocks = (rows: readonly string[]): Array<{ text: string; speaker: string }> => {
  const blocks: Array<{ text: string; speaker: string }> = []
  for (const row of rows) {
    if (!row.trim()) continue
    const indented = /^\s/.test(row)
    const trimmed = row.trim()
    const marker = trimmed[0]
    const text = trimmed.replace(/^[⏺❯]\s*/, '')
    if (indented && blocks.length > 0) blocks[blocks.length - 1].text += ` ${text}`
    else blocks.push({ text, speaker: marker === '❯' ? 'owner' : marker === '⏺' ? 'claude' : 'unknown' })
  }
  return blocks
}

/** VERSION 3 — the shared chrome model (correct) plus a position check that bounded
 *  only the two ENDPOINTS of the match: `lead <= 24 && tail <= 24`, measured on the
 *  last utterance block. What shipped after round 2, and what round 3's fixtures
 *  defeat. Reproduced faithfully so each new fixture proves it is a regression
 *  rather than a hypothetical. */
const endpointsOnly = (screen: string, patterns: readonly RegExp[]): boolean => {
  if (v3IsGenerating(screen)) return false
  const blocks = v3UtteranceBlocks(v3ConversationRows(screen))
  const last = blocks[blocks.length - 1]
  if (!last) return false
  const norm = normalizeScreen(last.text)
  if (!norm) return false
  let lastEnd = -1
  let firstStart = Number.POSITIVE_INFINITY
  for (const re of patterns) {
    const scan = new RegExp(re.source, `${re.flags.replace('g', '')}g`)
    for (let m = scan.exec(norm); m; m = scan.exec(norm)) {
      lastEnd = Math.max(lastEnd, m.index + m[0].length)
      firstStart = Math.min(firstStart, m.index)
    }
  }
  if (lastEnd < 0) return false
  return norm.length - lastEnd <= OWNER_DESK_TAIL_MAX && firstStart <= OWNER_DESK_LEAD_MAX
}

const v3EndpointsOnly = (screen: string): boolean => endpointsOnly(screen, V3_PATTERNS)

/** The round-3 reset pattern, before round 4 bounded it to a clock time and an
 *  IANA-shaped zone: `[^\s.]+` plus `[^)]{0,40}` swallowed ANY token and ANY
 *  parenthetical, so a sentence that merely MENTIONED a reset ended flush against
 *  the match and fired.
 *
 *  This version reached `main` in no release — it existed in this branch between
 *  d2dc121 and 51e1eb7 — but a fixture still owes proof that it catches something
 *  real rather than a shape nothing ever got wrong. Round 3's other gates (naming,
 *  which then still admitted the reset sentence; the punctuation-blacklist lead)
 *  all pass this sentence, so endpoint behaviour under the loose pattern is what
 *  decided it. */
const V3_LOOSE_RESET_PATTERNS: readonly RegExp[] = [
  ...V3_PATTERNS.filter((re) => !/reset/.test(re.source)),
  /limit (?:will )?resets?(?:\s+at\s+[^\s.]+(?:\s*\([^)]{0,40}\))?)?/,
]
const v3LooseReset = (screen: string): boolean => endpointsOnly(screen, V3_LOOSE_RESET_PATTERNS)

/** Select fixtures BY NAME for the version-specific assertions below.
 *
 *  Positional slices were how this was written, and appending round 4's fixtures
 *  silently re-pointed `FALSE.slice(-8)` and `REAL.slice(-2)` at the new entries —
 *  the assertions would then have claimed round-3 provenance for round-4 shapes and
 *  still passed. Names are stable where indices are not, and an unmatched name
 *  THROWS: a renamed fixture must fail loudly rather than quietly drop out of the
 *  regression proof it was carrying. */
const pick = <T extends readonly [string, (c: number) => string[]]>(
  from: readonly T[],
  ...needles: string[]
): T[] =>
  needles.map((needle) => {
    const hits = from.filter(([name]) => name.includes(needle))
    if (hits.length !== 1) {
      throw new Error(`fixture selector "${needle}" matched ${hits.length} fixtures, expected exactly 1`)
    }
    return hits[0]
  })

// ── The assertions ──────────────────────────────────────────────────────────

describe.each(WIDTHS)('owner-desk screen sensor @ %i columns', (cols) => {
  it.each(REAL)('FIRES on a real stop: %s', async (_name, build) => {
    expect(endsInQuotaRefusal(await render(build(cols), cols))).toBe(true)
  })

  it.each(FALSE)('stays QUIET on: %s', async (_name, build) => {
    expect(endsInQuotaRefusal(await render(build(cols), cols))).toBe(false)
  })

  // ROUND 3 (the ADVICE). Detecting the stop is half the job: the message has to
  // tell the owner something that works. A per-model stop clears on /model; an
  // account-wide one does not, and the shipped message sent both to /model — so
  // the owner followed the instruction, nothing happened, and they were left with
  // no next move. The kind is read off the CLI's own remedy line, and this pins
  // that rule across EVERY attested notice at EVERY width rather than tagging
  // fixtures by hand: a future notice whose wording disagrees fails here.
  it.each(REAL)('names WHICH stop it is, from the CLI wording: %s', async (_name, build) => {
    const screen = await render(build(cols), cols)
    // ⚠ The oracle reads the LAST utterance, not the whole screen, because that is
    // the rule the implementation states and the earlier version of this test got
    // it wrong in the direction that matters. A whole-screen probe demands
    // 'model-switchable' for any screen that mentions /model ANYWHERE — including
    // the documented case of an earlier per-model notice above a later
    // account-wide stop, which the implementation deliberately reads as
    // account-wide (swarmRateLimitText's docblock: "a conversation that discussed
    // /model earlier cannot colour a later account-wide stop — the commander desk
    // discusses exactly this, daily"). So the oracle would have FAILED the correct
    // answer, inviting a future "fix" to the implementation. Scoped the same way
    // the rule is.
    const conversation = stripScreenChrome(screen)
    const lastUtterance = conversation.slice(conversation.lastIndexOf('\n') + 1)
    const offersModelSwitch = /switch models with \/model/i.test(lastUtterance)
    expect(classifyQuotaRefusal(screen)).toBe(
      offersModelSwitch ? 'model-switchable' : 'account-wide',
    )
  })

  it('reads a later ACCOUNT-WIDE stop as account-wide even after a /model notice above it', async () => {
    // The scenario the implementation's docblock calls out and the shipped oracle
    // would have mis-asserted: the desk hit a per-model limit earlier, the owner
    // switched, and now the whole account is spent. Advising /model here would be
    // the round-3 defect — every model is exhausted.
    const screen = await render(
      [
        `⏺ ${'You\'ve reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.'}`,
        '❯ /model opus',
        '⏺ Switched to opus.',
        '',
        'Claude usage limit reached. Your limit will reset at 3pm.',
        ...box(cols),
      ],
      cols,
    )
    expect(classifyQuotaRefusal(screen)).toBe('account-wide')
  })

  it.each(FALSE)('names no stop at all when it stays quiet: %s', async (_name, build) => {
    expect(classifyQuotaRefusal(await render(build(cols), cols))).toBeNull()
  })
})

describe.each(WIDTHS)('…and each fixture is a real regression @ %i columns', (cols) => {
  it.each(FALSE)('was reachable by a shipped version: %s', async (_name, build) => {
    const screen = await render(build(cols), cols)
    // Every false positive was reachable by SOME earlier version — v1 for the ones
    // about limits generally, v2 for the ones that end in a quote, and the
    // loose-reset cut of v3 for the ones that merely mention a reset time.
    expect(v1RawTail(screen) || v2InventedChrome(screen) || v3LooseReset(screen)).toBe(true)
  })

  // The two CLEAN quote-ending reports — MF-1's class exactly. (The third, which
  // has the meter and footers around it, is a v1-only regression: those rows read
  // as conversation under the invented chrome model, so its tail overran and v2
  // missed it. It stays in the suite as a FALSE case; it just isn't evidence
  // about the position check.)
  it.each(
    pick(
      FALSE,
      'a commander report that ENDS by quoting a worker screen (JA)',
      'a commander report that ENDS by quoting a worker screen (EN)',
    ),
  )(
    'specifically defeated the shipped position check: %s',
    async (_n, build) => {
      const screen = await render(build(cols), cols)
      expect(v2InventedChrome(screen)).toBe(true) // the branch under review fired…
      expect(endsInQuotaRefusal(screen)).toBe(false) // …and no longer does
    },
  )

  it.each(
    pick(
      REAL,
      'the notice with a half-typed message left in the box',
      'the notice under a spinner and a 100% usage meter',
      'the notice with the status footers below the box',
      'the notice on a full frame — banner, meter, typed text and footers at once',
    ),
  )('was silently MISSED by the invented chrome model: %s', async (_n, build) => {
    const screen = await render(build(cols), cols)
    expect(v2InventedChrome(screen)).toBe(false) // the branch under review went quiet…
    expect(endsInQuotaRefusal(screen)).toBe(true) // …and now reports the stop
  })

  // ROUND 3. The fixtures the ENDPOINT-ONLY check got wrong — the same discipline
  // applied to the version that round replaced.
  it.each(
    pick(
      FALSE,
      'a report whose PREAMBLE itself names a limit',
      'the same, in Japanese',
      'a report with a SHORT quote-introducer',
      'a report introduced by a bare "Screen:"',
      'a desk reading THIS feature',
      'a tool-call row searching the source for the remedy line',
      'an ordinary answer that opens AND closes on limit wording',
      'the owner PASTED the notice into the box and sent it',
    ),
  )('specifically defeated the endpoint-only check: %s', async (_n, build) => {
    const screen = await render(build(cols), cols)
    expect(v3EndpointsOnly(screen)).toBe(true) // lead and tail both inside budget…
    expect(endsInQuotaRefusal(screen)).toBe(false) // …but the utterance is not a refusal
  })

  it.each(pick(REAL, 'reset time with (Europe/Amsterdam)', 'reset time with (America/Los_Angeles)'))(
    'was silently MISSED by the endpoint-only check: %s',
    async (_n, build) => {
      // The two long-timezone stops: the reset pattern stopped short of the zone, so
      // the zone read as text trailing the notice and overran the tail allowance.
      const screen = await render(build(cols), cols)
      expect(v3EndpointsOnly(screen)).toBe(false) // went quiet on a REAL stop…
      expect(endsInQuotaRefusal(screen)).toBe(true) // …and now reports it
    },
  )
})

describe('owner-desk WATCH driven by real rendered screens (end to end)', () => {
  // Closes the seam between the two suites: ownerDeskLimit.test.ts drives the pass
  // with hand-written fixtures, this file renders real screens — neither alone
  // proves the pass NOTIFIES on a screen a real terminal produced.
  const T0 = 1_700_000_000_000

  const runAgainst = async (lines: string[], cols: number) => {
    resetOwnerDeskLimitState()
    const screen = await render(lines, cols)
    const sent: unknown[] = []
    const deps = {
      listDesks: () => [{ id: 'desk', cwd: '/p/desk', startedAtMs: T0, lastOutputAt: T0 }],
      screen: () => screen,
      notify: async (n: unknown) => void sent.push(n),
      project: async () => ({ label: 'Demo', path: '/p/desk' }),
    }
    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps })
    // …and the pass that flushes the merge window, which is where a confirmed stop
    // is actually told once nothing else has joined the event (ownerDeskLimit's
    // OWNER_DESK_MERGE_QUIET_MS — desks stopped by one account-wide exhaustion
    // arrive over a span, not at an instant).
    await runOwnerDeskLimitPass({ now: confirmed + OWNER_DESK_MERGE_QUIET_MS, deps })
    return sent
  }

  it.each(WIDTHS)('raises exactly one notification for a real stop @ %i columns', async (cols) => {
    expect(await runAgainst(REAL[0][1](cols), cols)).toHaveLength(1)
  })

  it.each(WIDTHS)('raises none for a conversation about usage limits @ %i columns', async (cols) => {
    expect(await runAgainst(FALSE[0][1](cols), cols)).toEqual([])
  })

  it.each(WIDTHS)('raises none for a commander report quoting a worker @ %i columns', async (cols) => {
    const quoteReport = FALSE.find(([n]) => n.includes('(JA)'))![1]
    expect(await runAgainst(quoteReport(cols), cols)).toEqual([])
  })
})

describe('a desk REPORTING a limit in one short sentence (round 3)', () => {
  // The tail was the one position check that never got the LEAD's qualitative
  // treatment — it stayed a bare character budget. An utterance that OPENS on
  // limit wording has lead 0, so the lead whitelist never engages, and any
  // continuation short enough then passed. Measured across the boundary: EVERY
  // continuation of ≤24 normalized characters fired, on a desk that had finished
  // its turn normally and was waiting for the owner. Reporting a limit this way is
  // the commander and supply desks' daily work.
  const REPORTS = [
    '。opus に切り替えます。',
    '。少し待ちます。',
    '。tier を落とします。',
    '。確認してください。',
    '. Switching.',
    '. Retrying later.',
    '. Switching to opus now.',
  ]

  it.each(WIDTHS)('stays QUIET @ %i columns', async (cols) => {
    for (const cont of REPORTS) {
      const screen = await render(
        [
          '⏺ 使用量を見てきました。',
          '  worker-3 と worker-5 は opus で動いています。',
          `⏺ Fable 5 limit reached${cont}`,
          ...box(cols),
        ],
        cols,
      )
      expect(endsInQuotaRefusal(screen), `${cont} @ ${cols}`).toBe(false)
    }
  })

  it.each(WIDTHS)('…and the CLI finishing its OWN sentence still FIRES @ %i columns', async (cols) => {
    // The other direction, and the reason the rule is not "no words after the
    // notice": this attested wording leaves ` to continue.` trailing — words and
    // all — and is a REAL stop. A letters-based rule would silence it.
    const screen = await render(
      [
        '⏺ Working…',
        '',
        "You've reached your Opus 4.8 limit. Resets at 3:00pm. Run /usage-credits to continue.",
        ...box(cols),
      ],
      cols,
    )
    expect(endsInQuotaRefusal(screen)).toBe(true)
  })
})

describe('owner-desk screen sensor — the geometry assumptions it rests on', () => {
  it('removes the whole TUI frame, at every width', async () => {
    for (const cols of WIDTHS) {
      const chromeOnly = await render([...box(cols, 'half-typed message'), ...FOOTERS], cols)
      // The frame is a couple of hundred normalized characters raw — and nothing at
      // all once stripped. That difference IS why position is measured post-strip.
      expect(normalizeScreen(chromeOnly).length).toBeGreaterThan(60)
      expect(normalizeScreen(stripScreenChrome(chromeOnly))).toBe('')
    }
  })

  it('drops the welcome banner and the spinner/meter rows too', async () => {
    for (const cols of WIDTHS) {
      const screen = await render([...BANNER, ...METER, ...box(cols)], cols)
      expect(normalizeScreen(stripScreenChrome(screen))).toBe('')
    }
  })

  it('leaves the real stop ending AT the refusal, with room to spare', async () => {
    for (const cols of WIDTHS) {
      const screen = await render(REAL[0][1](cols), cols)
      const content = normalizeScreen(stripScreenChrome(screen))
      // The notice is the last thing said: what trails it is punctuation, not prose.
      expect(content.endsWith('/model.')).toBe(true)
      expect(OWNER_DESK_TAIL_MAX).toBeLessThan(34) // under the tightest trailing FP
    }
  })

  it('keeps the lead allowance under the shortest real preamble', async () => {
    // The commander report's preamble is what the leading check has to clear.
    // Pinned so a later widening of OWNER_DESK_LEAD_MAX cannot silently re-open
    // the hole review found.
    for (const cols of WIDTHS) {
      const build = FALSE.find(([n]) => n.includes('(EN)'))![1]
      const content = normalizeScreen(stripScreenChrome(await render(build(cols), cols)))
      expect(content.indexOf("you've reached")).toBeGreaterThan(OWNER_DESK_LEAD_MAX)
    }
  })

  it('survives the soft wrap that broke detection at 80 columns', async () => {
    // The notice is 95 chars, so at 80 columns xterm splits it mid-word. Rejoining
    // continuation rows is what keeps the final phrase intact; without it the last
    // match moves ~40 characters back up the message and the stop reads as quiet.
    const screen = await render(['⏺ Updated 2 files', '', LIMIT, '', ...box(80)], 80)
    expect(normalizeScreen(screen)).toContain('switch models with /model')
    expect(endsInQuotaRefusal(screen)).toBe(true)
  })
})

// ── The anatomy's own contracts ─────────────────────────────────────────────
// Round 5 mutation-tested each round-4 guard and found two with ZERO coverage: the
// `⎿` tool-result run and the reset pattern's zone tail. Both were invisible
// end-to-end because another layer (the lead whitelist) rejected the same screens
// first — defence in depth is good, but a guard nothing pins is a guard the next
// refactor deletes silently. These pin them where they are actually load-bearing:
// at the contract of the function that implements them.
describe('every hard-wrap layout of every attested notice', () => {
  // ⚠ A fixture that HARDCODES one split proves almost nothing. The round-4 wrap
  // fixture pinned a 68-character first row — one of the four container widths that
  // happened to survive — and asserting it at 80/120/200 added ZERO coverage, since
  // 68- and 26-character rows never soft-wrap. Round 6 then silenced 28 of 34 real
  // layouts and the suite stayed green, because the fragment left below the break
  // is only sometimes the remedy sentence: it is as often `models with /model.`,
  // `/model.` or `(Asia/Tokyo).`, matching no pattern at all.
  //
  // So the splits are GENERATED — every two-row greedy wrap of every attested
  // notice, which is what Ink produces when it lays out its own rows.
  const hardWrap = (text: string, width: number): string[] => {
    const out: string[] = []
    let line = ''
    for (const w of text.split(' ')) {
      if (line && `${line} ${w}`.length > width) {
        out.push(line)
        line = w
      } else line = line ? `${line} ${w}` : w
    }
    if (line) out.push(line)
    return out
  }

  // ⚠ EVERY row count, not just two. Round 7's generator computed the three- and
  // four-row wraps and then discarded them (`if (rows.length === 2)`) — and those
  // were exactly the silent ones, because the retry prepended a single block. A
  // generator that filters out the cases it does not handle is a hardcoded fixture
  // with extra steps. The floor is 20 columns because that is what terminal.ts
  // clamps to, and the Terminal tab tiles panes.
  const WRAPPED: Array<[string, string[]]> = []
  for (const notice of [
    LIMIT,
    'Claude usage limit reached. Your limit will reset at 3pm (Asia/Tokyo).',
    'Claude usage limit reached. Your limit will reset at 3pm (Europe/Amsterdam).',
    'Claude usage limit reached. Your limit will reset at 3pm (America/Argentina/Buenos_Aires).',
    'Claude usage limit reached · resets in 30 minutes (Europe/Amsterdam)',
    // The LONGEST attested wording — 114 characters, seven rows at the 20-column
    // floor. Its absence is how MAX_WRAP_BLOCKS came to be justified by "the widest
    // occupies five rows": true of this corpus before this line, false of the
    // attested set, and the bound derived from it silenced this wording on panes
    // 21–25 wide. A bound measured against a corpus must be measured against the
    // corpus it claims.
    "You've reached your Opus 4.8 limit. Resets at 3:00pm. Run /usage-credits to continue or switch models with /model.",
  ]) {
    for (let w = 20; w <= notice.length; w++) {
      const rows = hardWrap(notice, w)
      if (rows.length >= 2) WRAPPED.push([`${rows.length} rows, «${rows[rows.length - 1]}» below`, rows])
    }
  }

  it('generates layouts of every row count across the whole width range', () => {
    // Guards the generator itself — a bug that yielded a handful of cases, or only
    // two-row ones, would make every assertion below vacuously pass. Round 8 showed
    // a bare count is a weak guard (152 layouts shared only 21 distinct tails), so
    // this asserts the SHAPE of the population too.
    // Measured population: 299 layouts, 26 distinct tails, row counts 2–5. The
    // thresholds sit just under those, so a collapse is caught while ordinary
    // wording edits are not fought.
    expect(WRAPPED.length).toBeGreaterThan(200)
    const rowCounts = new Set(WRAPPED.map(([, r]) => r.length))
    for (const n of [2, 3, 4, 5]) expect(rowCounts.has(n), `${n}-row layouts`).toBe(true)
    const tails = new Set(WRAPPED.map(([, r]) => r[r.length - 1]))
    expect(tails.size).toBeGreaterThan(20)
    // …and the CORPUS itself, not just its shape. Round 9 found that deleting a
    // whole notice family from the corpus left every assertion above passing — the
    // guard pinned the population's shape while the content it was added to protect
    // could silently fall out.
    const corpus = WRAPPED.map(([, r]) => r.join(' ')).join('\n')
    for (const family of ['reset at 3pm', 'resets in 30 minutes', 'usage-credits', 'Argentina']) {
      expect(corpus.includes(family), `corpus covers "${family}"`).toBe(true)
    }
  })

  // Rendered at THREE widths like the rest of the suite: the rows are already laid
  // out, so the terminal must not re-wrap them, and 200 alone would not show that.
  it.each(WRAPPED)('reports the stop with %s', async (_name, rows) => {
    for (const cols of WIDTHS) {
      const screen = await render(['⏺ Updated 2 files', '', ...rows, '', ...box(cols)], cols)
      expect(endsInQuotaRefusal(screen), `@ ${cols}`).toBe(true)
    }
  })
})

describe('the wrap walk is bounded in both directions', () => {
  // Round 9: raising MAX_WRAP_BLOCKS from 5 to 99 left the whole suite green, so the
  // bound was pinned only from BELOW (by the 5-row layouts that must be assembled).
  // The loosening direction matters because the walk's lead is measured from the
  // FIRST matched span, so each prepended row can DROP the lead rather than raise
  // it — a long run of unmarked rows that each mention a limit would otherwise
  // assemble into something that passes.
  it('assembles a notice spread over five rows', async () => {
    const rows = ["You've reached your", 'Fable 5 limit. Run', '/usage-credits to', 'continue or switch', 'models with /model.']
    const screen = await render(['⏺ Updated 2 files', '', ...rows, '', ...box(200)], 200)
    expect(endsInQuotaRefusal(screen)).toBe(true)
  })

  it('stops reaching once the run is longer than a notice can wrap', async () => {
    // The same notice split one row FURTHER than any real width produces. The row
    // naming the cause is now out of reach, so what the walk can assemble names
    // nothing and is rejected. This is what the bound actually buys, and it is the
    // direction round 9 found unpinned — raising the limit to 99 left the suite green.
    const rows = [
      "You've reached your",
      'Fable 5 limit.',
      'Run',
      '/usage-credits',
      'to continue',
      'or switch',
      'models',
      'with /model.',
    ]
    const screen = await render(['⏺ Working…', '', ...rows, '', ...box(200)], 200)
    expect(endsInQuotaRefusal(screen)).toBe(false)
  })

  // ⚠ WHAT THE BOUND DOES NOT BUY. A run of unmarked column-0 rows that EACH name a
  // limit still assembles into something that passes — the walk's lead comes from
  // the FIRST matched span, so prepending such a row drops the lead to zero instead
  // of raising it. Lowering the bound only changes how many rows it takes.
  //
  // Left open deliberately. It is the column-0 residual documented on
  // endsInQuotaRefusal, reached along another path: an unmarked column-0 row is
  // byte-identical to a system notice, and rows 1..n of a wrapped notice are exactly
  // what the walk exists to reassemble. Separating "a board someone printed" from
  // "a notice the CLI wrapped" would need a rule keyed on the rows AROUND the
  // notice, and rounds 4 and 5 measured what those cost: round 4's version of that
  // idea silenced every real stop with an unrecognised row above it.
})

describe('claudeScreen anatomy contracts', () => {
  const conv = (rows: string[]): string[] => conversationRows(rows.join('\n'))

  it('drops a tool RESULT for its whole height, not just its ⎿ row', () => {
    // Only the opening row carries the glyph; continuations are plain indented rows.
    // A `cat` of a captured worker screen must not become "what claude said".
    expect(
      conv(['⏺ Bash(cat w2.txt)', '  ⎿  ⏺ Working…', '     the captured words', '', ...box(120)]),
    ).toEqual(['⏺ Bash(cat w2.txt)'])
  })

  it('ends the tool-result run at the first non-indented row', () => {
    // …so a result does not swallow the rest of the conversation below it.
    expect(
      conv(['⏺ Bash(ls)', '  ⎿  a.ts', '     b.ts', 'back to the conversation', '', ...box(120)]),
    ).toEqual(['⏺ Bash(ls)', 'back to the conversation'])
  })

  it('does NOT join consecutive unmarked column-0 rows', () => {
    // Round 4 joined them (to be indifferent to hard wrap) and round 5 measured the
    // cost: any column-0 row the chrome list does not know — `API Error: 529
    // Overloaded` is attested — folded into the notice below it and pushed a REAL
    // stop out of position. The hard-wrap case is handled by the caller's second
    // reading instead; see endsInQuotaRefusal.
    const blocks = utteranceBlocks(['API Error: 529 Overloaded', "You've reached your Fable 5 limit."])
    expect(blocks.map((b) => b.text)).toEqual([
      'API Error: 529 Overloaded',
      "You've reached your Fable 5 limit.",
    ])
  })

  it('marks an indented row with nothing above it as orphan', () => {
    // Its parent has scrolled off, so we cannot tell a notice from a captured screen
    // being read back. Missing evidence, not evidence.
    expect(utteranceBlocks([`     ${LIMIT}`])[0].speaker).toBe('orphan')
    // …while the same row under a header is an ordinary continuation.
    expect(utteranceBlocks(['⏺ Working…', `     ${LIMIT}`]).map((b) => b.speaker)).toEqual(['claude'])
  })

  it('remembers who spoke', () => {
    expect(utteranceBlocks(['❯ a turn the owner sent']).map((b) => b.speaker)).toEqual(['owner'])
    expect(utteranceBlocks(['⏺ a turn claude produced']).map((b) => b.speaker)).toEqual(['claude'])
    expect(utteranceBlocks(['a bare system notice']).map((b) => b.speaker)).toEqual(['unknown'])
  })
})

describe('the leads a real refusal may carry', () => {
  // ⚠ A hand-written list of accepted leads is VACUOUS — it asserts that the regex
  // accepts what the regex was written to accept, and round 6 proved the cost: the
  // whitelist had been tightened to three words while the CLI's per-model wordings
  // ("Fable 5 limit reached", "Opus 4.8 limit reached") lead with a MODEL NAME, so
  // every per-model exhaustion went silent and this block stayed green. So the real
  // assertion drives whole ATTESTED WORDINGS end to end, below; this one only
  // documents the vocabulary.
  it('accepts the run-ups the CLI actually prints', () => {
    for (const lead of ['', "you've ", 'claude ', 'your ']) {
      expect(CLI_LEAD_IN_RE.test(lead), lead || '(nothing)').toBe(true)
    }
  })

  // The wordings the ENGINE pins as real CLI output — swarmOrchestrator.test.ts's
  // "…while a QUALIFIED one is a real limit". Kept in sync by hand, but asserted
  // through the whole sensor rather than against a regex, so a wording that loses
  // its lead (or its pattern, or its position) fails HERE instead of going quiet in
  // production. Every model tier the ladder knows is covered, so adding one to
  // SWARM_MODEL_TIERS without teaching the pattern also fails here.
  const cap = (t: string): string => `${t[0].toUpperCase()}${t.slice(1)}`
  const ATTESTED = [
    '5-hour limit reached ∙ resets 3pm',
    'Weekly limit reached',
    'Session limit reached',
    'Claude usage limit reached · resets 3pm (Asia/Tokyo)',
    ...SWARM_MODEL_TIERS.map((t) => `${cap(t)} 5 limit reached`),
    ...SWARM_MODEL_TIERS.map((t) => `${cap(t)} 4.8 limit reached · resets 3pm (Asia/Tokyo)`),
    // ROUND 8 — the reset value is as often a DURATION as a clock time.
    // swarmQuota's PTY parser is built around exactly this ("Relative first —
    // 'resets in 5 minutes'", swarmQuota.ts) and the engine fixtures carry the
    // em-dash spelling. The whole family trailed 26–36 characters and was silent,
    // while the clock form cleared the allowance by ONE character.
    'Claude usage limit reached · resets in 30 minutes (Europe/Amsterdam)',
    'Claude usage limit reached · resets in 30 minutes (America/Los_Angeles)',
    'Claude usage limit reached — resets in 30 minutes (Asia/Tokyo)',
    'Claude usage limit reached — resets in about 2 hours',
    'Claude usage limit reached — resets in 30 minutes',
    // …and every shape the CLI numbers a model with. Round 7 bounded the version to
    // `\d+(\.\d+)?` and silenced these three real stops for one contrived screen.
    ...SWARM_MODEL_TIERS.map((t) => `${cap(t)} 4.8-preview limit reached`),
    ...SWARM_MODEL_TIERS.map((t) => `${cap(t)} 5.1.2 limit reached`),
    ...SWARM_MODEL_TIERS.map((t) => `${cap(t)} 4-5 limit reached`),
    // A colon INSIDE a token is punctuation, not a hand-off — detection must not
    // depend on which clock format the CLI happens to print.
    'Claude usage limit reached. Your limit will reset at 3:00pm (Asia/Tokyo).',
    'Claude usage limit reached. Your limit will reset at 15:00 (Asia/Tokyo).',
    "You've reached your Opus 4.8 limit. Resets at 3:00pm. Run /usage-credits to continue or switch models with /model.",
  ]

  it.each(ATTESTED)('reports a stop on the attested wording: %s', async (wording) => {
    for (const cols of WIDTHS) {
      const screen = await render(['⏺ Working…', '', wording, '', ...box(cols)], cols)
      expect(endsInQuotaRefusal(screen), `${wording} @ ${cols}`).toBe(true)
    }
  })

  it.each([
    // …and the UNQUALIFIED ones the engine pins as ordinary output stay quiet.
    'connection limit reached',
    'buffer limit reached',
    "throw new Error('limit reached')",
  ])('stays quiet on ordinary output: %s', async (wording) => {
    for (const cols of WIDTHS) {
      const screen = await render(['⏺ Working…', '', wording, '', ...box(cols)], cols)
      expect(endsInQuotaRefusal(screen), `${wording} @ ${cols}`).toBe(false)
    }
  })

  it('rejects anything a human would introduce a quotation with', () => {
    // Including the unpunctuated ones a blacklist of `:` could never catch, and the
    // one-word case that defeated round 4's "any single lowercase word" form.
    for (const lead of ['screen ', '引用します: ', '画面はこれ ', '結果 ', 'worker-2 — ', 'note ', 'the pinned wording is: ']) {
      expect(CLI_LEAD_IN_RE.test(lead), lead).toBe(false)
    }
  })
})
