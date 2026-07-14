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

/** Strip ANSI/CSI escape sequences and collapse whitespace, lowercased — so the
 *  output classifier below matches against the clean text a human reads, immune
 *  to the cursor-addressing a `claude` TUI interleaves (and to a raw-buffer
 *  fallback that still carries escapes). Pure. */
export const normalizeScreen = (s: string): string =>
  s
    // CSI / OSC / single-char escapes — enough to clear the sequences claude emits.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()

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
  /\b(?:\d+[\w.-]*|usage|model|session|weekly|your)\s+limit reached\b/,
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
export const QUOTA_EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /reached your .{0,40}\blimit\b/, // "You've reached your Fable 5 limit."
  /usage limit/, // "claude usage limit reached"
  /\b(?:\d+[\w.-]*|usage|model|session|weekly|your)\s+limit reached\b/,
  /switch models with \/model\b/, // the refusal's remedy line
  /\brun \/usage-credits\b/, // …and its other remedy line
]

/** {@link QUOTA_EXHAUSTION_PATTERNS} against ALREADY-normalized text. */
export const matchesQuotaExhaustion = (normalized: string): boolean =>
  QUOTA_EXHAUSTION_PATTERNS.some((re) => re.test(normalized))

/** How much text may trail the limit wording and still count as "the session died
 *  right there" ({@link endsInRateLimit}). Sized for the CLI's chrome — the input
 *  box + hint line claude repaints under its last message — and nothing more. */
export const RATE_LIMIT_TAIL_MAX = 800

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
): boolean => {
  if (!text) return false
  const norm = normalizeScreen(text)
  if (!norm) return false
  let lastEnd = -1
  for (const re of RATE_LIMIT_PATTERNS) {
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
