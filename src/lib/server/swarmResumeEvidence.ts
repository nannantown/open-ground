// swarmResumeEvidence — two facts the monitor needs to resume work by itself
// (docs/AUTONOMY-SPEC.md R-C1(2), R-C2), read from records that already exist.
//
//  • lastTranscriptUsageRefusal — a dead worker whose SDK session the pool has
//    already forgotten (its 30-minute linger ran out while nobody was looking:
//    engine OFF, a Mac asleep, a long runtime switch) has no "last words" left
//    in memory, so its usage-limit stop read as a crash and a branch with
//    commits parked the card in `blocked`, where nothing brings it back. The
//    CLI's transcript still says it: the refusal is an assistant entry carrying
//    `isApiErrorMessage: true` (docs/SDK_CLIENT_INVESTIGATION.md §9-B, measured
//    over 249 files) — a quote of the same sentence never carries that marker.
//  • apiErrorTurnSeq — a turn that ended on `terminal_reason: api_error` (network
//    loss, sleep, provider 5xx) leaves the session sitting `waiting` with
//    nothing to wake it but the 10-minute stall arm.

import { open } from 'fs/promises'
import { matchesQuotaRefusal, type SdkEvent } from './sdkEvents'

/** How much of a transcript's END is read. The refusal is the newest assistant
 *  entry, a few hundred bytes from the end; a multi-MB transcript is never read
 *  whole for it. Nothing found in the window ⇒ no refusal (the old crash rule). */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The usage-limit refusal a transcript ENDS on, or null.
 *
 *  "Ends on" = its newest `assistant` entry is the CLI's own error message
 *  (`isApiErrorMessage: true`) and its text starts with one of the vendor's
 *  refusal prefixes (the SDK's `USAGE_LIMIT_ERROR_PREFIXES`, passed in — never a
 *  private copy). Anything else is null: a normal reply after the refusal (it
 *  moved on), an API error that is not a usage limit (`API Error: 529`), a quote
 *  of the sentence without the marker, a missing or unreadable file. Never throws. */
export const lastTranscriptUsageRefusal = async (
  file: string,
  prefixes: readonly string[],
): Promise<string | null> => {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, size - len)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec: { type?: unknown; isApiErrorMessage?: unknown; message?: { content?: unknown } }
      try {
        rec = JSON.parse(lines[i])
      } catch {
        continue // a torn last line, or the first line the window cut in half
      }
      if (rec?.type !== 'assistant') continue
      if (rec.isApiErrorMessage !== true) return null
      const content = rec.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
            : ''
      return matchesQuotaRefusal(text, prefixes) ? oneLine(text) : null
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** The seq of a session's newest turn boundary when that turn ended on an API
 *  error that is NOT a usage refusal and nothing has happened since; undefined
 *  otherwise. `frames` are the session's newest frames, oldest first (status
 *  frames are bookkeeping and skipped). A usage refusal distils to
 *  `quota_refusal` instead of `api_error` (sdkEvents), so it never matches —
 *  that stop belongs to the quota arm. A turn handed over since (an `input`
 *  frame, e.g. our own "Continue.") also clears it. */
export const apiErrorTurnSeq = (frames: readonly { seq: number; ev: SdkEvent }[]): number | undefined => {
  const events = frames.filter((f) => f.ev.kind !== 'status')
  const end = events[events.length - 1]
  const cause = events[events.length - 2]
  return end?.ev.kind === 'turn_end' && end.ev.reason === 'api_error' && cause?.ev.kind === 'api_error'
    ? end.seq
    : undefined
}
