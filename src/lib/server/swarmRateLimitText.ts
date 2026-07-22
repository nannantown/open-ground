// swarmRateLimitText — the PURE rate/usage-limit WORDING detector, extracted
// verbatim from swarmOrchestrator (layer B's eyes) so the pre-launch tier probe
// (swarmTierProbe) can reuse the exact same patterns without importing the
// 7k-line engine — probe → orchestrator → probe would be an import cycle, and
// a COPY of the patterns would drift the moment the CLI rewords a notice (the
// 2026-07-09 "You've reached your Fable 5 limit" gap took days to close once;
// two copies would take it twice).
//
// Everything here is pure text → boolean/position: no clock, no globalThis, no
// engine state. swarmOrchestrator re-exports the public names, so its existing
// importers (tests included) keep working unchanged.
//
// The frame ANATOMY the position checks stand on (which rows are chrome, where
// the input box starts, how an utterance wraps) is @/lib/claudeScreen's — one
// model shared with swarmQuestions and swarmEscalations. It is a leaf too, so
// importing it keeps the probe's light import path intact.

import {
  conversationRows,
  isGenerating,
  stripAnsi,
  utteranceBlocks,
  type UtteranceBlock,
} from '@/lib/claudeScreen'
import { SWARM_MODEL_TIERS } from '../types'

/** A limit ANNOUNCEMENT qualified by what ran out — shared by all three pattern
 *  tables below so they cannot drift. The qualifier is the whole point: a bare
 *  `/limit reached/` also fires on "connection limit reached", a "buffer limit
 *  reached" log line, and `throw new Error(…)` in source. Defined once here rather
 *  than repeated per table because {@link QUOTA_REFUSAL_PATTERNS} has to recognise
 *  it in order to swap in a model-aware variant — see the note there. */
const QUALIFIED_ANNOUNCEMENT = /\b(?:\d+[\w.-]*|usage|model|session|weekly|your)\s+limit reached\b/

/** Strip ANSI/CSI escape sequences and collapse whitespace, lowercased — so the
 *  output classifier below matches against the clean text a human reads, immune
 *  to the cursor-addressing a `claude` TUI interleaves (and to a raw-buffer
 *  fallback that still carries escapes). Pure. */
export const normalizeScreen = (s: string): string =>
  // CSI / OSC / single-char escapes (@/lib/claudeScreen's stripAnsi — the same
  // grammar, defined once) then whitespace-collapse + lowercase.
  stripAnsi(s).replace(/\s+/g, ' ').toLowerCase()

/** High-precision markers that a worker's `claude` is WAITING on a rate / usage /
 *  quota / overload limit — a legitimate pause, NOT a hang. Matched against the
 *  normalized screen text. Deliberately tuned to claude's RUNTIME messages
 *  ("usage limit reached", an API overload error, a backoff "retrying in 30s"),
 *  which a worker editing source would not reproduce verbatim — so a worker
 *  literally writing rate-limit CODE is rarely misread. The residual risk is a
 *  FALSE POSITIVE (extra grace for a worker that isn't really limited), the SAFE
 *  direction: it never kills, and the runaway ceiling still backstops a worker
 *  that genuinely never progresses. A false NEGATIVE would be the dangerous one
 *  (reclaiming a real waiter) — hence the bias toward catching the limit. */
export const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit/, // "claude usage limit reached", "approaching your usage limit"
  /limit (?:will )?reset/, // "your limit will reset at 3pm", "limit resets in…"
  /\boverloaded_error\b/,
  /\brate_limit_error\b/,
  /api error[^.]{0,40}\b(?:429|500|503|529|overloaded)\b/,
  /\b(?:429|529)\b[^.]{0,40}\boverloaded\b/,
  /too many requests/,
  /retrying in \d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/,
  // The CLI's PER-MODEL exhaustion notice, verbatim off a worker's session on
  // 2026-07-09: "You've reached your Fable 5 limit. Run /usage-credits to
  // continue or switch models with /model." NONE of the patterns above see it —
  // a model-named limit is not the string "usage limit" — so the quota sensor
  // never fired, fable never cooled, and dispatch kept re-launching workers and
  // reviewers into the dry tier (stalls + empty review panels). Each of the
  // notice's three independent phrases gets its own pattern, because a TUI wraps
  // the sentence at the box edge and only one fragment may survive on screen.
  // The wording is pinned by a verbatim regression fixture in the test suite.
  /reached your .{0,40}\blimit\b/, // "You've reached your Fable 5 limit."
  // A limit ANNOUNCEMENT, qualified by what ran out. The qualifier is the whole
  // point: a bare /limit reached/ also fires on "connection limit reached", a
  // "buffer limit reached" log line, and `throw new Error(...)` in source — text
  // an ordinary worker prints — which would cool a HEALTHY tier for 20 minutes.
  // The alternation covers a numbered window (5-hour, 4.8), and the usage /
  // model / session / weekly / your qualifiers the CLI actually uses.
  QUALIFIED_ANNOUNCEMENT,
  /switch models with \/model\b/, // the notice's remedy line
  // …and its other remedy line. `run ` is load-bearing (a bare /usage-credits/
  // would fire on prose and on this file); normalizeScreen lowercases AFTER its
  // escape strip, so the CLI's capital "Run" reaches this pattern — see the
  // isolation test that drives this pattern alone.
  /\brun \/usage-credits\b/,
]

/** {@link RATE_LIMIT_PATTERNS} against ALREADY-normalized text (a classifier
 *  with one in hand must not normalize twice). */
export const matchesRateLimit = (normalized: string): boolean =>
  RATE_LIMIT_PATTERNS.some((re) => re.test(normalized))

/** The QUOTA-EXHAUSTION subset of {@link RATE_LIMIT_PATTERNS} — only the CLI's
 *  own "this quota is spent" refusal wording, NONE of the transient-fault
 *  markers (overloaded_error / rate_limit_error / api error 4xx-5xx / too many
 *  requests / retrying in Ns / 429·529).
 *
 *  WHY A SUBSET EXISTS — the polarity of a false positive FLIPS between the two
 *  consumers, so they cannot share one pattern list:
 *    • Layer B's sensor (the full RATE_LIMIT_PATTERNS) reads a LIVE worker's
 *      screen. There a false positive only grants extra grace to a worker that
 *      wasn't really limited — it never kills, so the list is deliberately
 *      broad (its own docblock says so).
 *    • The pre-launch PROBE (swarmTierProbe) turns a match into
 *      markRateLimited: 20 minutes of cooling, PERSISTED to disk, applied to
 *      every spawn path at once. There a false positive KILLS a healthy tier —
 *      measured 2026-07-13: a transient 529 during a probe would have cooled
 *      fable for 20 min across all six spawn paths. So the probe may only
 *      trust wording that names an exhausted QUOTA, and must read every
 *      transient fault as 'unknown' (fail-open).
 *  Layer B keeps the full list — do not "unify" these. */
/** The refusal's MODEL-SWITCH remedy line, named because it answers a second
 *  question besides "is this a refusal": whether switching models is a way OUT of
 *  this particular stop. `claude` prints it when another model is still available
 *  and omits it when the whole account's quota is spent — so it is the CLI's own
 *  statement of what the user can do, and {@link classifyQuotaRefusal} reads it
 *  back rather than guessing from which pattern matched. Same object as the entry
 *  in {@link QUOTA_EXHAUSTION_PATTERNS}; there is exactly one copy of it. */
export const MODEL_SWITCH_REMEDY = /switch models with \/model\b/

export const QUOTA_EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /reached your .{0,40}\blimit\b/, // "You've reached your Fable 5 limit."
  /usage limit/, // "claude usage limit reached"
  QUALIFIED_ANNOUNCEMENT,
  MODEL_SWITCH_REMEDY, // the refusal's remedy line
  /\brun \/usage-credits\b/, // …and its other remedy line
]

/** {@link QUOTA_EXHAUSTION_PATTERNS} against ALREADY-normalized text. */
export const matchesQuotaExhaustion = (normalized: string): boolean =>
  QUOTA_EXHAUSTION_PATTERNS.some((re) => re.test(normalized))

/** The CLI's REFUSAL wording proper — {@link QUOTA_EXHAUSTION_PATTERNS} minus the
 *  bare `/usage limit/`. Every pattern here names the shape of a message `claude`
 *  ITSELF emits when it declines to continue; the dropped one is an ordinary
 *  English phrase that any conversation ABOUT limits contains.
 *
 *  WHY THE THIRD LIST EXISTS (measured 2026-07-18, at the production 120-column
 *  geometry). The pre-launch probe reads a HEADLESS one-shot whose entire output
 *  is the CLI's answer, so `/usage limit/` there is safely decisive. An owner's
 *  desk is the opposite: a long-running conversation whose screen is full of
 *  prose the owner and claude wrote each other. A screen ending
 *
 *      …So when you hit the usage limit the gauge pins to red and stays there.
 *
 *  is a normal answer about the UsageHud, and it matches `/usage limit/` on the
 *  LAST content line — so no amount of position checking can separate it from a
 *  real stop. Position and wording close different holes and neither substitutes
 *  for the other: this list closes "the conversation was ABOUT limits",
 *  {@link endsInQuotaRefusal}'s position check closes "the notice was QUOTED".
 *  A genuinely exhausted quota still matches here, because the CLI always names
 *  what ran out ("…usage limit reached", "You've reached your Fable 5 limit") or
 *  offers its remedy (/model, /usage-credits). */
export const QUOTA_REFUSAL_PATTERNS: readonly RegExp[] = [
  ...QUOTA_EXHAUSTION_PATTERNS.filter((re) => re.source !== /usage limit/.source).map((re) =>
    // The QUALIFIED-ANNOUNCEMENT pattern gets the MODEL NAME folded into it, for
    // this list only. "Fable 5 limit reached" qualifies via its NUMBER, so the base
    // pattern starts matching at `5` and leaves `Fable ` sitting in front of the
    // match. The other consumers only ask IS there a match (a boolean), so they
    // cannot tell — but this list feeds a POSITION check, and there the model name
    // read as a human's lead-in and silenced every per-model exhaustion: the exact
    // class of the 2026-07-09 incident, pinned in this repo two lines below the
    // wording that motivated the status-strip form (swarmOrchestrator.test.ts's
    // "…while a QUALIFIED one is a real limit"). Round 6 measured the silence.
    //
    // Bounded to SWARM_MODEL_TIERS, never "any preceding word", so the name cannot
    // act as a one-word preamble in front of someone else's quoted notice. What
    // follows it is the base pattern's own VERSION branch (`\d+[\w.-]*`), which
    // covers every shape the CLI numbers a model with: `5`, `4.8`, `4.8-preview`,
    // `5.1.2`, `4-5`.
    //
    // Round 7 narrowed that to `\d+(\.\d+)?` to stop `Fable` introducing a quoted
    // SESSION-window notice (`Fable` / `5-hour limit reached …`). Round 8 measured
    // the trade and it was a loss: the narrowing SILENCED `Opus 4.8-preview`,
    // `Fable 5.1.2` and `Sonnet 4-5` — real stops — while the screen it was aimed
    // at is already rejected by the interior-colon rule. What it still buys is the
    // colon-FREE variant of that one shape, which is the documented column-0
    // residual (nothing measurable separates it from a real notice), and this
    // feature does not trade real-stop silence for that.
    //
    // The alternation is ordered model-first so the longer, more specific match
    // wins and the span starts at the model name. The base tables stay
    // byte-identical: the worker arm and the tier probe are outside the blast
    // radius of this list.
    // Identity, not `.source` equality: the shared const is the same object, and a
    // string compare would silently stop matching if the two ever diverged. The
    // tier names are escaped — they are `[a-z]+` today, but an unescaped `(` or `+`
    // in a future tier would throw at MODULE LOAD, and swarmOrchestrator and
    // swarmTierProbe both import this file, so it would take the server down at
    // boot rather than degrade (round 7).
    re === QUALIFIED_ANNOUNCEMENT
      ? new RegExp(
          `\\b(?:(?:${SWARM_MODEL_TIERS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s+\\d+[\\w.-]*\\s+limit reached\\b)|${QUALIFIED_ANNOUNCEMENT.source}`,
          re.flags,
        )
      : re,
  ),
  // The refusal's RESET-TIME sentence ("Your limit will reset at 3pm"), which the
  // exhaustion subset omits. It is here for POSITION, not for reach: it is the
  // last sentence of the CLI's own message, so including it makes a real refusal
  // END at the match instead of trailing 31 characters of its own tail — which is
  // what lets the tail allowance below be tight enough to reject a quote followed
  // by one short sentence (measured 34). Without it the two classes sit 3
  // characters apart and no threshold separates them.
  //
  // The optional ` at <time> (<zone>)` is part of the MATCH for the same reason —
  // it is the CLI's own tail, not something that follows it. Review (2026-07-18)
  // measured what omitting it costs: `(Asia/Tokyo)` leaves 21 trailing characters
  // and squeaks under the allowance, `(Europe/Amsterdam)` leaves 27 and
  // `(America/Los_Angeles)` 30 — both over, so a REAL account-wide stop went
  // undetected for anyone not in Tokyo. The threshold was never the bug; the
  // pattern stopping short of the sentence it was quoting was. (swarmQuota.ts:315
  // already strips exactly this parenthesised zone, so the CLI is known to print
  // it.) Bounded to the shape the CLI emits rather than a loose `[^.]*`, so it
  // cannot swallow following prose.
  // The trailing ` at <time> (<zone>)` is part of the MATCH because it is the CLI's
  // own tail, not something that follows it. Round 4 tried to bound the zone to a
  // two-component IANA name; round 5 measured that this bought nothing (reverting it
  // turned ZERO tests red — QUOTA_NAMING_PATTERNS already rejects the sentences it
  // was aimed at, since a reset sentence alone never names an exhaustion) while it
  // silenced every owner in a three-component zone: America/Argentina/Buenos_Aires,
  // America/Indiana/Indianapolis, America/Kentucky/Louisville. That is the same
  // "works only where the author lives" defect round 3 opened and round 3 closed,
  // reopened for a different set of owners. So the zone is opaque again.
  /limit (?:will )?resets?(?:\s+at\s+[^\s.]+(?:\s*\([^)]{0,40}\))?)?/,
  // The STATUS-STRIP form of the same sentence: `… limit reached · resets 3pm
  // (Asia/Tokyo)`. Kept verbatim in the engine's own list of real CLI wordings
  // (swarmOrchestrator.test.ts) and NOT reachable by the pattern above, which needs
  // `limit` immediately before `reset` — here the CLI writes `reached · resets`.
  // Without it the notice trails 26 characters, two over the allowance, and a real
  // account-wide stop went unreported (round 5).
  //
  // ⚠ ANCHORED to the announcement it belongs to. Round 5 wrote it as a bare
  // `\bresets?\s+\d`, which matches mid-sentence — and because the gap check runs
  // over MERGED spans, a stray "resets 5 times" in the middle of ordinary prose
  // became a STEPPING STONE that halved an over-budget gap and re-opened the very
  // false-positive class the gap check exists to close ("Usage limit reached means
  // the window resets 5 hours later; run /usage-credits." fired). A position-only
  // pattern must not be able to appear anywhere a human might write it.
  // ⚠ The reset value may be a DURATION as readily as a clock time — "resets in 30
  // minutes", "resets in about 2 hours". swarmQuota's own PTY parser is built
  // around exactly that ("Relative first — 'resets in 5 minutes'",
  // swarmQuota.ts:332) and the engine fixtures carry the em-dash spelling. Round 5
  // wrote this to consume one token after `resets`, which stops at `in`, and to
  // accept only middle-dot separators — so the whole duration family trailed 26–36
  // characters and went unreported, while the attested clock form cleared the
  // allowance by ONE character (round 8). Everything after the anchor is therefore
  // taken up to the sentence end: `limit reached <sep> resets` is specific enough
  // that being greedy past it costs nothing.
  // ⚠ TWO separate decisions here, and round 8 got both too loose at once.
  //
  // SEPARATOR — the attested ones only (`·` U+00B7 in the account strip, `∙` U+2219
  // in the session strip, and the em-dash the engine fixtures carry). Round 8 also
  // admitted a PLAIN HYPHEN, which turns ordinary dash prose into an anchor:
  // "Usage limit reached - resets in 5 hours; until then run /usage-credits." then
  // matched, and the 48-character reach bridged all the way to the remedy line,
  // erasing the interior gap the false-positive check depends on.
  //
  // REACH — the SHAPE of a reset label, not "48 characters of anything". A
  // position-only pattern that can consume arbitrary text defeats every check that
  // inspects the text BETWEEN matches, because it moves that text inside a match.
  // The label is: an optional `in`, up to three tokens, an optional parenthesised
  // zone. A token may hold a colon only when a DIGIT follows it (`3:00pm`, `15:00`)
  // — never the hand-off colon of `worker-2 screen:`, which is exactly what round 8
  // let it swallow.
  /limit reached\s*[·∙・—–]\s*resets?\s+(?:in\s+)?(?:[^\s.,;:：]|[:：](?=\d))+(?:\s+(?:[^\s.,;:：]|[:：](?=\d))+){0,2}(?:\s*\([^)]{0,40}\))?/i,
]

/** The subset of {@link QUOTA_REFUSAL_PATTERNS} that NAMES WHAT RAN OUT, as
 *  opposed to the two that merely offer the REMEDY (`/model`, `/usage-credits`).
 *
 *  A genuine refusal always says what was exhausted — the CLI does not print a
 *  bare "switch models with /model" with nothing to explain it. A screen whose
 *  only match is a remedy line is therefore someone TALKING ABOUT the remedy, and
 *  review (2026-07-18) found the shape that does it: a tool-call row echoing a
 *  search for the string, `⏺ Bash(rg -n "switch models with /model" src/)`, which
 *  clears every positional gate (lead 12, tail 7, no interior gap) because the
 *  wording really is nearly all of that row. Position cannot separate it; only
 *  requiring the message to name its own cause can. */
export const QUOTA_NAMING_PATTERNS: readonly RegExp[] = QUOTA_REFUSAL_PATTERNS.filter(
  // Neither the two REMEDY lines…
  (re) =>
    !/\/model|usage-credits/.test(re.source) &&
    // …nor the RESET sentence, which is in the refusal list for POSITION only (it
    // is where the CLI's message ends). It names no exhaustion by itself: "Your
    // limit will reset at 3pm" is what the usage meter says with 88% still unused,
    // so admitting it here would make an ordinary statement of fact sufficient
    // evidence that the conversation had stopped (review 2026-07-18, round 4).
    !/reset/.test(re.source),
)

/** How much text may trail the limit wording and still count as "the session died
 *  right there" ({@link endsInRateLimit}). Sized for the CLI's chrome — the input
 *  box + hint line claude repaints under its last message — and nothing more. */
export const RATE_LIMIT_TAIL_MAX = 800

/** Does `text` END in a match of `patterns` — i.e. is that wording the LAST thing
 *  this `claude` said, with at most `tailMax` characters of chrome after it?
 *
 *  The shared core of {@link endsInRateLimit} and {@link endsInQuotaExhaustion};
 *  the two differ ONLY in which pattern list they measure, so the scanning logic
 *  lives here once. Distance is measured from the END of the LAST match across
 *  every pattern, on the NORMALIZED text. Pure. */
const endsInMatch = (
  text: string | null | undefined,
  patterns: readonly RegExp[],
  tailMax: number,
): boolean => {
  if (!text) return false
  const norm = normalizeScreen(text)
  if (!norm) return false
  let lastEnd = -1
  for (const re of patterns) {
    // Scan for the LAST occurrence: a fresh global clone per call, so neither the
    // shared pattern's `lastIndex` nor this scan's leaks between callers.
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    for (let m = scan.exec(norm); m; m = scan.exec(norm)) {
      lastEnd = Math.max(lastEnd, m.index + m[0].length)
      if (m[0].length === 0) scan.lastIndex++ // no pattern is zero-width; never spin if one becomes so
    }
  }
  return lastEnd >= 0 && norm.length - lastEnd <= tailMax
}

/** Does `text` END in a rate/usage-limit notice — i.e. is the limit wording the
 *  LAST thing this `claude` said, with only chrome after it?
 *
 *  The reviewer arm's quota sensor (makeAdversarialReview) needs this rather than
 *  a bare "does the transcript CONTAIN limit wording" test, because a reviewer's
 *  transcript is 64KB of whatever it read: review the rate-limit code itself (this
 *  very file, swarmQuota.ts) and the notice's verbatim wording is QUOTED in the
 *  diff and in the reviewer's own prose. Containment cannot tell a quote from the
 *  real thing; POSITION can. When `claude` actually walks into the wall the notice
 *  is its terminal utterance — it stops there, and only the input box follows. A
 *  reviewer that merely quoted the wording goes on working: hundreds to thousands
 *  more characters of reading and reasoning trail the quote (each repaint pushes
 *  the earlier one further from the tail), so the last match sits far from the end.
 *
 *  Distance is measured from the END of the LAST match across all
 *  {@link RATE_LIMIT_PATTERNS}, on the normalized text, and must be within
 *  {@link RATE_LIMIT_TAIL_MAX}. Pure.
 *
 *  Deliberately NOT used for the worker arm: a worker's PTY *screen* is a live
 *  snapshot, not a transcript, and classifyOutput rightly matches anywhere
 *  in it. And when this check misses a real notice that has scrolled away, the
 *  cost is bounded — the panel just defers, and the worker sensor (which reads the
 *  live screen, where the notice still sits) cools the tier on the next dispatch. */
export const endsInRateLimit = (
  text: string | null | undefined,
  tailMax: number = RATE_LIMIT_TAIL_MAX,
): boolean => endsInMatch(text, RATE_LIMIT_PATTERNS, tailMax)

/** Drop every CHROME row from a rendered screen, leaving the conversation.
 *
 *  The anatomy is @/lib/claudeScreen's — the SAME model swarmQuestions walks to
 *  find a worker's last utterance, not a second one. An earlier cut of this file
 *  carried its own, and it was wrong in the expensive direction: it modelled the
 *  input box as a `│ … │` bordered box, which the CLI does not draw (the box is
 *  fenced by RULES around a `❯` prompt row; `╭──╮` is the welcome banner alone).
 *  So the prompt row, a half-typed message, the spinner line, the usage meter and
 *  the status footers all counted as CONVERSATION — each of them pushing a real
 *  notice out of position until the sensor went silent on the very event it was
 *  built for. Measured through a real headless xterm at 80/120/200 columns on
 *  2026-07-18; the regression is pinned in ownerDeskScreens.test.ts.
 *
 *  Exported for the measurement tests that pin the geometry assumptions. Pure. */
export const stripScreenChrome = (screen: string): string => conversationRows(screen).join('\n')

/** How much may TRAIL the refusal wording inside its own utterance and still mean
 *  "claude stopped right there".
 *
 *  Sized in REAL TEXT — {@link stripScreenChrome} has already removed the TUI's
 *  frame — so it is the same number at 80 columns and at 200. An absolute distance
 *  into the RAW screen is not: measured 2026-07-18, the input box alone is 184 /
 *  264 / 424 normalized characters at 80 / 120 / 200 columns, which is why the
 *  first cut of this check (raw distance, 800) degenerated into "the wording
 *  appears somewhere on screen".
 *
 *  Small ON PURPOSE. The claim being tested is that the refusal is the END of
 *  claude's output, so the allowance covers only the remainder of that same
 *  message — punctuation, a short trailing clause — never another sentence.
 *  Measured at all three widths: a real stop trails 0–8 characters; a quote
 *  followed by ONE short sentence trails 34.
 *
 *  The residual risk is a FALSE NEGATIVE if a future CLI paints some new trailing
 *  line that @/lib/claudeScreen does not recognise as chrome — detection would
 *  degrade to silence, i.e. back to the pre-2026-07-18 status quo rather than to a
 *  wrong notification. That direction is the acceptable one here: a spurious "your
 *  conversation stopped" on an ordinary chat is a nuisance the owner cannot
 *  verify, and at 800 it fired on every conversation that so much as discussed
 *  usage limits. The geometry assumption is pinned by tests at three widths. */
export const OWNER_DESK_TAIL_MAX = 24

/** How much of its own prose may PRECEDE the refusal inside that same final
 *  utterance and still mean "the CLI said this", not "someone quoted it".
 *
 *  The companion to {@link OWNER_DESK_TAIL_MAX}, and the fix for the hole review
 *  found on 2026-07-18: a trailing check alone fires on an utterance that ENDS in
 *  a quote — "worker-2 is stuck, here is what its screen says:" followed by the
 *  notice. That shape is not hypothetical, it is the commander and supply desks'
 *  DAILY WORK (both carry `ownerDesk: true`), and it was the one false-positive
 *  class the original fixtures never covered.
 *
 *  A real refusal IS the whole final utterance — the CLI emits it alone, so the
 *  match starts at offset 0 of its block. A quote is the TAIL of a longer
 *  utterance whose preamble introduces it. The allowance covers only a lead-in
 *  the CLI itself might print before the sentence, never a human-scale preamble.
 *
 *  Blocks, not lines, are what make this work: the quote sits on its own line in
 *  both cases, so a line-level check cannot tell them apart — see
 *  {@link utteranceBlocks}. */
export const OWNER_DESK_LEAD_MAX = 24

/** What the CLI's own run-up into its notice may look like: NOTHING, or a single
 *  plain word. `you've reached your … limit` leads with `you've `; `claude usage
 *  limit reached` with `claude `. That is the whole observed vocabulary.
 *
 *  The qualitative half of the lead check (see {@link endsInQuotaRefusal}), and a
 *  WHITELIST rather than a blacklist of punctuation — which is the correction from
 *  round 4 of review. Blacklisting `:` caught `引用します:` and `Screen:` but left
 *  every unpunctuated preamble open (`⏺ Screen`, `⏺ 画面はこれ`, `⏺ 結果`,
 *  `⏺ worker-2 —`), all verified firing at 80/120/200 columns. Enumerating the
 *  punctuation a human might introduce a quotation with is unbounded; enumerating
 *  what the CLI itself prints is two words long.
 *
 *  Matched against the NORMALIZED lead (lower-cased, whitespace-collapsed), and
 *  spelled as the LITERAL words rather than as "one lowercase word". Round 4 wrote
 *  the looser form; round 5 broke it with a one-word preamble in front of the OTHER
 *  attested notice — `⏺ Screen` above `5-hour limit reached ∙ resets 3pm` leads with
 *  `screen ` and fired. The canonical notice hid that hole, because its own `you've`
 *  makes any preamble the SECOND word; a notice that starts its match at offset 0
 *  does not. Enumerating what the CLI prints is three words long, so enumerate it.
 *
 *  A future CLI that prefixes its notice with anything else is silenced — the
 *  false-negative direction this feature consistently prefers. The ACCEPTED set is
 *  pinned by test (`the leads a real refusal may carry`), so extending the CLI's
 *  vocabulary shows up as a failing assertion rather than as silence. */
export const CLI_LEAD_IN_RE = /^(?:you've|you’ve|claude|your)?\s?$/

/** How much UNMATCHED prose may sit BETWEEN two pieces of the refusal.
 *
 *  The third position check, and the one that closes the class both endpoint
 *  checks are structurally blind to: an utterance that BEGINS with limit wording
 *  and ENDS with limit wording passes lead and tail no matter what lies between
 *  them. That is not a corner case — it is how anyone naturally reports a stop
 *  ("Usage limit reached on worker-2. Its screen says:" + the quote), and the
 *  commander desk does it daily.
 *
 *  Measured 2026-07-18 at 120 columns: the CLI's own message has interior gaps of
 *  at most 16 characters (`. run `, ` to continue or `), while the false-positive
 *  class sits at 28 / 38 / 65. 20 splits them with the boundary on the side that
 *  fails safe — a future CLI phrasing with a longer joint degrades to silence, not
 *  to a wrong notification. */
export const OWNER_DESK_GAP_MAX = 20

/** Which kind of stop a quota refusal is — i.e. what the owner can DO about it.
 *
 *  Not a taxonomy for its own sake: the two want opposite advice. A per-model stop
 *  ("You've reached your Fable 5 limit…") clears the moment another model is
 *  picked, so the owner's next move is /model. An account-wide one ("Claude usage
 *  limit reached. Your limit will reset at 3pm.") has spent the whole account, so
 *  /model opens a menu where every entry is exhausted too — the owner follows the
 *  instruction, nothing happens, and they are left with no next move at all. That
 *  is a worse failure than the silence this feature replaced, and it is what the
 *  single hard-coded "/model" message shipped (review 2026-07-18, round 3). */
export type QuotaRefusalKind = 'model-switchable' | 'account-wide'

/** Did `claude` STOP on a spent quota — the CLI's own refusal wording, standing
 *  alone as the last thing it said — and if so, WHICH kind of stop? Returns the
 *  {@link QuotaRefusalKind} the screen attests to, or null for "not a stop".
 *
 *  The kind is read off the CLI's OWN remedy line ({@link MODEL_SWITCH_REMEDY}),
 *  never inferred from which naming pattern matched: `claude` prints "switch models
 *  with /model" exactly when another model is still available. Reading it back
 *  keeps the advice correct by construction — if a future CLI offers /model on a
 *  stop we have never seen, we relay what it said rather than what we guessed.
 *  Scoped to the utterance JUDGED to be the refusal, not the whole screen, so a
 *  conversation that discussed /model earlier cannot colour a later account-wide
 *  stop (the commander desk discusses exactly this, daily).
 *
 *  The owner-desk sensor's whole precision (ownerDeskLimit.ts), built from
 *  restrictions that each close a DIFFERENT hole:
 *
 *   • WORDING ({@link QUOTA_REFUSAL_PATTERNS}) closes "the conversation was ABOUT
 *     limits". It excludes transient faults, whose remedy is to wait rather than
 *     to switch models (see QUOTA_EXHAUSTION_PATTERNS' polarity note), AND the
 *     bare `/usage limit/` phrase, which any answer explaining the usage gauge
 *     ends up containing.
 *
 *   • NOT GENERATING ({@link isGenerating}) closes "it printed the wording and
 *     carried on". A session mid-generation has not stopped, whatever is on its
 *     screen. Deliberately a pure NEGATIVE: an unrecognised future footer reads as
 *     "not busy" and falls through to the checks below, rather than silencing a
 *     real stop.
 *
 *   • POSITION closes "the notice was QUOTED", from BOTH sides. An owner desk has
 *     none of the worker arm's corroborating signals (no spawn-onset window, no
 *     commit count, no heartbeat — swarmOrchestrator's `earlyLimitConfirmed` ANDs
 *     all three onto its hold window), so the desk substitutes a stricter reading
 *     of the screen for them:
 *       – TRAILING ({@link OWNER_DESK_TAIL_MAX}): nothing follows the notice, so a
 *         session that quoted it and went on working is rejected;
 *       – LEADING ({@link OWNER_DESK_LEAD_MAX}): nothing PRECEDES it inside the
 *         same utterance, so a report that ends by quoting it is rejected too.
 *
 *  Measured on the CONVERSATION ({@link stripScreenChrome}), never on raw screen
 *  characters: at 120 columns a real stop trails 266–307 characters of frame while
 *  a false positive trails 304 — the classes overlap, so no threshold separates
 *  them, and one tight enough to reject the quote silently rejects the real thing
 *  too.
 *
 *  KNOWN RESIDUAL, deliberately not closed: a quote sitting at COLUMN 0 with no
 *  turn marker of its own —
 *
 *      ⏺ worker-2 is stuck. Here is what its screen shows:
 *      You've reached your Fable 5 limit. …
 *
 *  — is a separate block whose text is byte-identical to a real notice, so nothing
 *  measured ON THE BLOCK can tell them apart. (Round 5 reached the same residual by
 *  another route — an unmarked one-word row above an unmarked status-strip notice —
 *  which is the same shape, not a second hole.) Rejecting it would mean judging an
 *  utterance by the one before it ("the previous block ended in a colon"), which
 *  buys this narrow case at the cost of silencing a real stop whenever claude's
 *  previous message happened to end in one — a worse trade in the direction that
 *  matters, and the round-4/5 lesson is precisely that a rule keyed on the rows
 *  AROUND the notice costs more than it collects.
 *
 *  It is also not a shape the TUI produces for assistant prose: claude's own
 *  continuation rows are INDENTED (see @/lib/claudeScreen's frame map), which is why
 *  the quoted fixtures here are, and the other routes for an un-indented capture are
 *  closed — pasted-and-sent lands in a `❯` block (speaker), tool output in a `⎿`
 *  gutter (chrome), and a capture whose header has scrolled off is `orphan`. Pure. */
export const classifyQuotaRefusal = (
  screen: string | null | undefined,
  tailMax: number = OWNER_DESK_TAIL_MAX,
  leadMax: number = OWNER_DESK_LEAD_MAX,
  gapMax: number = OWNER_DESK_GAP_MAX,
): QuotaRefusalKind | null => {
  if (!screen) return null
  if (isGenerating(screen)) return null
  const blocks = utteranceBlocks(conversationRows(screen))
  const last = blocks[blocks.length - 1]
  if (!last) return null
  if (judgeRefusalBlock(last, tailMax, leadMax, gapMax)) return refusalKind(last.text)

  // SECOND READING — the notice HARD-WRAPPED. If the CLI lays out its own wrapping
  // (Ink does) rather than letting the terminal soft-wrap, the 95-character notice
  // arrives at 80 columns as two column-0 rows, and the final one carries only the
  // remedy sentence — which rightly fails on its own. Which way the real CLI wraps
  // could not be established from the captures, so BOTH readings are tried rather
  // than betting on one.
  //
  // Retried as a second reading rather than by joining the rows up front (round 4's
  // approach) because joining is unconditional: it also folds in any unrecognised
  // column-0 row that happens to sit above the notice, pushing a REAL stop out of
  // position. Here the joined text only ever gets a chance to say YES after the
  // plain reading has said no, so an extra row above the notice costs nothing —
  // the plain reading already fired.
  //
  // Exactly ONE block is prepended, and only an unmarked one: a marked (`⏺`/`❯`)
  // block is a different turn, and reaching further would rebuild the very
  // "quote plus preamble" utterance the lead check exists to reject.
  //
  // And ONLY when the final block is a REMEDY-ONLY fragment — which is the whole
  // signature of a wrapped notice: the half that names the exhaustion is above, the
  // half left below carries just "switch models with /model." Without that
  // condition the retry becomes a way to BYPASS the lead gate, since the joined
  // text's lead is whatever precedes the FIRST match: a short introducer above a
  // complete notice ("Usage limit reached." / "Screen: You've reached your…") is
  // rejected on its own and was then accepted joined (round 6).
  // The condition is ONLY "the final block does not name an exhaustion". Round 6
  // also required it to match SOME refusal pattern, on the theory that the leftover
  // half always carries the remedy sentence. It does not: a wrap lands wherever the
  // container width puts it, and the fragment left below is as often `models with
  // /model.`, `/model.`, `(Asia/Tokyo).` or `3pm` — matching nothing at all. That
  // extra conjunct silenced 28 of 34 real wrap layouts, the canonical notice at 80
  // columns among them (measured round 7). It bought nothing the first conjunct
  // does not already buy: a fragment matching no pattern cannot fire on its own, so
  // letting the retry look at it costs only the retry.
  //
  // The walk goes back as FAR as the wrap needs, not one block: a narrow pane
  // splits the 95-character notice into three or four rows, and round 7's
  // single-step retry left every one of those silent (terminal.ts clamps columns to
  // [20,500], and the Terminal tab tiles panes, so narrow is ordinary). Bounded, and
  // it stops at the first MARKED block — a `⏺`/`❯` row is a different turn, and
  // walking through one would rebuild the "preamble plus quote" utterance the lead
  // check exists to reject.
  if (QUOTA_NAMING_PATTERNS.some((re) => re.test(normalizeScreen(last.text)))) return null
  if (last.speaker !== 'unknown') return null
  let joined = last.text
  for (let i = blocks.length - 2; i >= 0 && blocks.length - 1 - i <= MAX_WRAP_BLOCKS; i--) {
    const above = blocks[i]
    if (above.speaker !== 'unknown') return null
    joined = `${above.text} ${joined}`
    if (judgeRefusalBlock({ text: joined, speaker: 'unknown' }, tailMax, leadMax, gapMax)) {
      // The REASSEMBLED notice, so a wrap that split the remedy line off from the
      // half naming the exhaustion is still classified on the whole message.
      return refusalKind(joined)
    }
  }
  return null
}

/** Which kind of stop a text ALREADY judged to be a refusal is. Split from
 *  {@link judgeRefusalBlock} rather than folded into it: that function's nine
 *  rejections are the product of nine rounds of measurement, and classification is
 *  a separate question asked only of text that has already passed all of them. */
const refusalKind = (text: string): QuotaRefusalKind =>
  MODEL_SWITCH_REMEDY.test(normalizeScreen(text)) ? 'model-switchable' : 'account-wide'

/** Did `claude` STOP on a spent quota? The boolean face of
 *  {@link classifyQuotaRefusal}, for callers that only gate on the fact of a stop.
 *  One implementation, so the two can never disagree about what a stop is. */
export const endsInQuotaRefusal = (
  screen: string | null | undefined,
  tailMax: number = OWNER_DESK_TAIL_MAX,
  leadMax: number = OWNER_DESK_LEAD_MAX,
  gapMax: number = OWNER_DESK_GAP_MAX,
): boolean => classifyQuotaRefusal(screen, tailMax, leadMax, gapMax) !== null

/** How many rows above the last one a wrapped notice may be reassembled from.
 *
 *  How many rows may be PREPENDED, so a notice may span this many rows plus one.
 *
 *  Measured against EVERY attested notice wrapped at every width down to the
 *  20-column floor terminal.ts clamps to. ⚠ An earlier value of 4 was justified as
 *  "the widest occupies five rows" — true of the wrap suite's five-notice corpus,
 *  NOT of the attested set, whose longest wording ("You've reached your Opus 4.8
 *  limit. Resets at 3:00pm. Run …", 114 characters) occupies SEVEN rows at 20
 *  columns. That bound silenced it on panes 21–25 wide. Measured across the full
 *  attested corpus: 4 → 6 layouts undetected, 5 → 1, 6 → 0.
 *
 *  ⚠ This bound is load-bearing, and an earlier version of this comment claimed
 *  otherwise ("each step only adds lead and gap, so a wrong join fails on its own
 *  merits"). That is false: the lead is measured from the FIRST matched span, so
 *  prepending a row that itself opens on limit wording drops the lead to ZERO
 *  rather than raising it — measured across one walk as 6 → 12 → 18 → 0 (round 9).
 *  A run of unmarked column-0 rows that each mention a limit can therefore assemble
 *  into something that passes, so the number of rows a notice can occupy is a real
 *  ceiling and not a formality. Pinned from BOTH directions by test. */
const MAX_WRAP_BLOCKS = 6

/** Does ONE utterance read as the CLI's refusal standing alone? The layered test
 *  described on {@link endsInQuotaRefusal}; split out so the caller can apply it to
 *  more than one reading of the same screen. Pure. */
const judgeRefusalBlock = (
  last: UtteranceBlock,
  tailMax: number,
  leadMax: number,
  gapMax: number,
): boolean => {
  // SPEAKER. A refusal is something `claude` said. `❯` opens a turn the OWNER
  // submitted, so a notice they pasted in and sent — reporting it, asking about
  // it — is theirs, not the CLI's. An `orphan` block is an indented continuation
  // whose parent scrolled off, so we cannot tell a notice from a captured screen
  // being read back — missing evidence, not evidence. Only a real notice's own
  // shape ('unknown', painted at column 0) and `claude`'s own turns get through.
  if (last.speaker === 'owner' || last.speaker === 'orphan') return false

  const norm = normalizeScreen(last.text)
  if (!norm) return false

  // NAMES ITS OWN CAUSE. A remedy line by itself is a conversation about the
  // remedy — see QUOTA_NAMING_PATTERNS.
  if (!QUOTA_NAMING_PATTERNS.some((re) => re.test(norm))) return false

  // Every matched span, merged, so the checks below reason about the refusal as
  // one region rather than about whichever pattern happened to match last.
  const spans: Array<[number, number]> = []
  for (const re of QUOTA_REFUSAL_PATTERNS) {
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    for (let m = scan.exec(norm); m; m = scan.exec(norm)) {
      spans.push([m.index, m.index + m[0].length])
      if (m[0].length === 0) scan.lastIndex++ // no pattern is zero-width; never spin if one becomes so
    }
  }
  if (!spans.length) return false
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [spans[0]]
  for (const [s, e] of spans.slice(1)) {
    const tip = merged[merged.length - 1]
    if (s <= tip[1]) tip[1] = Math.max(tip[1], e)
    else merged.push([s, e])
  }
  const lead = merged[0][0]
  const lastEnd = merged[merged.length - 1][1]

  // TRAILING — nothing said after the notice.
  if (norm.length - lastEnd > tailMax) return false
  // …and what little IS allowed after it must be the CLI FINISHING ITS OWN
  // SENTENCE, never starting a new one. The mirror of the lead's qualitative rule
  // (CLI_LEAD_IN_RE), and it closes the same hole from the other side: an
  // utterance that OPENS on limit wording has lead 0, so the lead whitelist never
  // engages, and a character budget alone then admits any short continuation.
  //
  // Measured 2026-07-18 (round 3 adversarial review), post-strip and normalized:
  //   REAL tails      ""  "."  " to continue."          — 0–13 chars, no new sentence
  //   REPORTING tails "。opus に切り替えます。" ". switching."  — 8–24 chars, all NEW sentences
  // A desk writing `⏺ Fable 5 limit reached。opus に切り替えます。` finished its turn
  // normally and was being told its own conversation had stopped.
  //
  // ⚠ NOT a "no letters in the tail" rule, which is the obvious version and is
  // WRONG: the attested `You've reached your Opus 4.8 limit. Resets at 3:00pm. Run
  // /usage-credits to continue.` leaves ` to continue.` — words and all — so that
  // rule silences a real stop. What separates the classes is not letters but a
  // TERMINATOR WITH CONTENT AFTER IT: the CLI's tail ends its sentence, a human's
  // tail ends the quote and then says something.
  if (/[.。][^\s]|[.。]\s+\S/.test(norm.slice(lastEnd))) return false
  // LEADING — nothing said before it inside the same utterance.
  if (lead > leadMax) return false
  // …and what little IS allowed in front must be the CLI's own run-up — see
  // CLI_LEAD_IN_RE. Review (2026-07-18) measured why a character budget alone
  // cannot do this: a real notice leads with 7 characters, and `引用します:` — a
  // complete quote-introducer — leads with 7 too. Japanese is ~2.5× denser than
  // English, so ANY budget wide enough for an English lead-in swallows a whole
  // Japanese preamble.
  if (!CLI_LEAD_IN_RE.test(norm.slice(0, lead))) return false
  // INTERIOR — the gaps inside the refusal are its own connective tissue (". run ",
  // " to continue or "), never a sentence. This is what rejects an utterance that
  // both OPENS and CLOSES with limit wording, which the two endpoint checks above
  // are blind to by construction: "Usage limit reached on worker-2. Its screen
  // says:" + the quote has lead 0 and tail 1 and is a false positive (review
  // 2026-07-18 — the shipped fixtures missed it only because their preambles
  // happened not to mention limits).
  // INTRODUCER, over the WHOLE covered region — not merely the gaps between spans.
  // Checking only the complement of the matches lets any pattern that swallows a
  // colon smuggle a hand-off past this rule, and a position-only pattern's reach is
  // exactly the kind of thing that gets widened to fix a missed detection. Rounds
  // 6, 8 and 9 each produced one such bypass. The region is the right scope because
  // the question — "did this utterance turn into a quotation?" — is about the
  // utterance, not about which parts of it a regex happened to cover.
  //
  // Introducer-SHAPED only (`:` before whitespace or end): a colon inside a token is
  // punctuation, so `3:00pm`, `15:00` and `https://…` are untouched.
  if (/[:：](?:\s|$)/.test(norm.slice(lead, lastEnd))) return false
  for (let i = 1; i < merged.length; i++) {
    const gap = norm.slice(merged[i - 1][1], merged[i][0])
    if (gap.length > gapMax) return false
    // …and a gap may not contain a QUOTE INTRODUCER. The lead check rejects a
    // preamble in front of the notice; this rejects one that has slipped INSIDE the
    // covered region, which happens when the preamble is itself a limit
    // announcement and so starts the match at offset 0:
    //
    //     ⏺ Fable 5 limit reached. Screen:
    //         You've reached your Fable 5 limit. Run …
    //
    // Every span is matched, every gap is short, and the lead is nothing — the
    // arithmetic says "the wording covers this utterance" while a human reads two
    // statements, the second quoted. Reporting a per-model stop this way is the
    // commander and supply desks' daily work (round 7).
    //
    // ONLY the colon: the CLI's own joints include `. ` ("…limit. Run /usage-…"),
    // so rejecting sentence enders here would reject the canonical notice itself.
    // That leaves a colon-free preamble open — see the residual note above; it is
    // the same "no signal distinguishes them" class, not a threshold to tighten.
  }
  return true
}
