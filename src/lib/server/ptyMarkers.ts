// ptyMarkers — read a MARKER SPAN out of a raw claude PTY output stream.
//
// This is the extraction generateDescription.ts paid for IN PRODUCTION, lifted
// out verbatim so the second and third consumers (the persona conversation and
// the export distiller) share ONE implementation rather than each carrying a
// private copy that drifts. Nothing here spawns, reads or writes anything — it
// is a string function, so every rule below is measurable without a PTY.
//
// WHY THE STRIP IS SPLIT IN THREE, because a naive "delete all escapes" is
// wrong in a way that only shows up against a real TUI:
//   • SGR (CSI…m) is pure STYLE and can sit MID-WORD (`re␛[1md␛[0m apple`), so
//     it deletes silently.
//   • every OTHER CSI is a POSITIONING / erase op. The claude TUI does not just
//     colour text, it PLACES it: a word gap frequently arrives as a cursor move
//     rather than a literal space. Deleting those fuses words —
//     "ClaudeCodemissioncontrol" was observed live — so each becomes a SPACE and
//     the `\s+` collapse below de-dupes the run.
//   • OSC (`]0;…BEL`) is a window-title write with its own terminator.
//
// WHY '<' IS REJECTED OUTRIGHT. The prompt itself is echoed back through the
// PTY, placeholders included, so `MARKER: <one short sentence> END` appears in
// the buffer before the model has answered anything. Rejecting any candidate
// containing '<' discards the echo. The matching half of that contract lives in
// the PROMPT, which must forbid angle brackets in the answer — without that
// half, a legitimate sentence ("a <canvas> rendering library") is silently
// dropped and the run burns its whole budget. The reject is blanket rather than
// a `^<…>$` shape test because the TUI may elide the echoed placeholder
// mid-string, leaving no closing '>'.
//
// WHY THE SCAN RUNS BACKWARD. The TUI repaints: the same marker line can appear
// several times, and only the last paint is complete. A rejected candidate does
// not end the scan — it keeps walking back — so a buffer holding only the
// echoed placeholder resolves to null rather than to the placeholder.

// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/g
// eslint-disable-next-line no-control-regex
const CSI_OTHER_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** Strip the TUI's escape sequences from a raw PTY buffer, turning positioning
 *  ops into word gaps (see the header). Control characters INSIDE a span are
 *  handled by the span cleaner below, not here — this pass only has to make the
 *  marker/end tokens findable. */
export const stripPtyAnsi = (raw: string): string =>
  raw.replace(OSC_RE, '').replace(SGR_RE, '').replace(CSI_OTHER_RE, ' ')

/** Clean one candidate body, or null when it is not a usable answer.
 *
 *  A PTY line wrap can split the sentence, so ALL whitespace runs (the injected
 *  newline included) collapse to one space. That is also why every consumer's
 *  output contract has to be short enough to survive losing its paragraph
 *  structure — there is no way back from this collapse. */
const cleanSpan = (body: string, maxLen: number): string | null => {
  const candidate = body
    .replace(CTRL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!candidate || candidate.includes('<')) return null
  return candidate.slice(0, maxLen)
}

/** The LAST usable `<marker> … <end>` span in a raw PTY buffer, or null.
 *
 *  Marker-pair only — no prose fallback anywhere in this module. A wrong answer
 *  scraped out of the conversational text around the marker is worse than no
 *  answer: the caller can retry a null, and cannot un-write a lie. */
export const extractMarkerSpan = (
  raw: string,
  marker: string,
  end: string,
  opts: { maxLen: number },
): string | null => {
  const text = stripPtyAnsi(raw)
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(marker, from - 1)
    if (start < 0) return null
    const stop = text.indexOf(end, start + marker.length)
    if (stop >= 0) {
      const candidate = cleanSpan(text.slice(start + marker.length, stop), opts.maxLen)
      if (candidate) return candidate
    }
    from = start
    if (from <= 0) return null
  }
}

/** Up to `maxCount` DISTINCT usable spans, IN THE ORDER THEY WERE EMITTED.
 *
 *  Collected backward (newest first, same repaint reasoning as the single-span
 *  reader) and then reversed, so when a model emits more than the cap it is the
 *  LAST N that survive — the ones that follow its own final thinking — while the
 *  caller still reads them in the order they were written.
 *
 *  ⚠ DE-DUPLICATED, and this is the whole reason the single-span reader could
 *  get away without it. `extractMarkerSpan` returns the LAST paint and is done;
 *  a multi-span reader walks past every earlier paint of the same line. The
 *  claude TUI repaints its output — the same finished `KEPT: … END` line is in
 *  the buffer several times over — so a naive collector turns ONE distilled
 *  sentence into N identical results. Downstream that is N identical rows in an
 *  APPEND-ONLY corpus, which cannot be un-written and which quietly triples the
 *  weight of whatever the model happened to say while the terminal was busy.
 *
 *  Compared AFTER cleaning, because that is what makes the comparison work at
 *  all: two paints of one sentence differ in where the TUI wrapped it, and the
 *  whitespace collapse in cleanSpan is what makes them the same string.
 *
 *  The cap counts DISTINCT spans, never paints: capping first would let five
 *  repaints of one line fill a maxCount of five and hide every other line the
 *  model actually emitted. */
export const extractMarkerSpans = (
  raw: string,
  marker: string,
  end: string,
  opts: { maxLen: number; maxCount: number },
): string[] => {
  if (opts.maxCount <= 0) return []
  const text = stripPtyAnsi(raw)
  const found: string[] = []
  const seen = new Set<string>()
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(marker, from - 1)
    if (start < 0) break
    const stop = text.indexOf(end, start + marker.length)
    if (stop >= 0) {
      const candidate = cleanSpan(text.slice(start + marker.length, stop), opts.maxLen)
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate)
        found.push(candidate)
        if (found.length >= opts.maxCount) break
      }
    }
    from = start
    if (from <= 0) break
  }
  return found.reverse()
}
