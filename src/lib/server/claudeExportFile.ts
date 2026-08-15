// claudeExportFile — turn the BYTES the owner dropped into the export's JSON.
//
// WHY THIS IS ON THE SERVER (2026-08-15, measured against the owner's own
// export). Their file is a 23 MB zip holding a 98 MB conversations.json. The
// browser path could not survive either half:
//   • the zip was REFUSED outright, with copy telling them to open it and pull
//     the file out themselves — at the one moment the app is asking for their
//     history, it handed them homework;
//   • and 98 MB is past every ceiling the renderer had. The old client path read
//     the whole file into an ArrayBuffer, hashed it, decoded it to a string,
//     JSON.parsed that, then JSON.stringified the result into a request body —
//     five live copies on the thread that draws the screen. The 64 MB cap added
//     to stop that freeze would have refused this file outright: a guard doing
//     exactly what it was built to do, to the exact file it was built to serve.
//
// So the client now uploads BYTES and nothing else, and everything below runs in
// Node, where 98 MB of JSON is unremarkable (measured: 983 ms to inflate, 629 ms
// to parse).
//
// NO DEPENDENCY FOR THE ZIP. It is ~60 lines of central-directory reading plus
// zlib.inflateRaw, which Node already ships. A zip reader added as a dependency
// here would be a supply-chain surface on the path that handles the owner's most
// private file, to save code we can read in one sitting.
//
// ⚠ THE SIZES IN A ZIP ARE ATTACKER-CONTROLLED. Every length below comes out of
// the file itself, so each one is checked before it is trusted: the inflate is
// capped (`maxOutputLength`), the declared offsets are bounds-checked, and a
// ZIP64 marker is refused rather than misread as a 32-bit number. This file is
// only ever fed something the owner dropped on their own machine — but "the
// input is trusted" is exactly the sentence that precedes the incidents.

import { inflateRawSync } from 'zlib'
// The ceiling itself lives in the ISOMORPHIC module: the drop handler needs it
// to fail fast, and a client that imported this file would pull zlib into the
// browser bundle. Re-exported so server callers have one place to look.
import { MAX_EXPORT_UPLOAD_BYTES } from '@/lib/claudeExport'

export { MAX_EXPORT_UPLOAD_BYTES }

/** Largest thing the zip is allowed to inflate TO. A zip's declared sizes are
 *  written by whoever made the zip, so this is the number that actually stops a
 *  compression bomb — not the declared `usize` below, which is only a hint. */
export const MAX_EXPORT_INFLATED_BYTES = 512 * 1024 * 1024

/** The member a claude.ai export keeps its conversations in. */
export const EXPORT_MEMBER = 'conversations.json'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
/** A 32-bit field holding this means "the real value is in a ZIP64 record". */
const ZIP64_MARKER = 0xffffffff

/** Is this byte range a zip? Checked on the CONTENT, never on the file name: an
 *  export saved as `.json` that is really a zip should still work, and a `.zip`
 *  that is really JSON should not be run through the zip reader. */
export const looksLikeZip = (buf: Uint8Array): boolean =>
  buf.length >= 4 &&
  buf[0] === 0x50 &&
  buf[1] === 0x4b &&
  // 03 04 = a local file header; 05 06 = an EMPTY archive; 07 08 = spanned.
  ((buf[2] === 0x03 && buf[3] === 0x04) ||
    (buf[2] === 0x05 && buf[3] === 0x06) ||
    (buf[2] === 0x07 && buf[3] === 0x08))

/** Thrown for every readable-file-but-not-an-export outcome, so the route can
 *  answer 400 without string-matching a message. */
export class ClaudeExportFileError extends Error {}

const u16 = (b: Buffer, at: number): number => {
  if (at + 2 > b.length) throw new ClaudeExportFileError('zip: truncated')
  return b.readUInt16LE(at)
}
const u32 = (b: Buffer, at: number): number => {
  if (at + 4 > b.length) throw new ClaudeExportFileError('zip: truncated')
  return b.readUInt32LE(at)
}

/** Find the End Of Central Directory record.
 *
 *  Scanned BACKWARD from the end and bounded to 64 KiB + 22, which is the most
 *  the record can be from the end (its comment field is a 16-bit length). An
 *  unbounded backward scan over a 256 MB upload looking for four bytes is a free
 *  denial of service on a file that is simply not a zip. */
const findEocd = (b: Buffer): number => {
  const floor = Math.max(0, b.length - (0xffff + 22))
  for (let i = b.length - 22; i >= floor; i--) {
    if (b.readUInt32LE(i) === SIG_EOCD) return i
  }
  throw new ClaudeExportFileError('zip: no end-of-central-directory record')
}

/** Pull ONE named member out of a zip. Deflate and store only — the two methods
 *  every real zip writer uses; anything else is refused by name rather than
 *  silently returning wrong bytes. */
export const readZipMember = (buf: Buffer, member: string): Buffer => {
  const eocd = findEocd(buf)
  const count = u16(buf, eocd + 10)
  const cdOffset = u32(buf, eocd + 16)
  if (cdOffset === ZIP64_MARKER || u32(buf, eocd + 12) === ZIP64_MARKER) {
    throw new ClaudeExportFileError('zip: ZIP64 archives are not supported')
  }
  if (cdOffset >= buf.length) throw new ClaudeExportFileError('zip: bad directory offset')

  let p = cdOffset
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== SIG_CENTRAL) throw new ClaudeExportFileError('zip: bad central header')
    const method = u16(buf, p + 10)
    const csize = u32(buf, p + 20)
    const nameLen = u16(buf, p + 28)
    const extraLen = u16(buf, p + 30)
    const commentLen = u16(buf, p + 32)
    const localOffset = u32(buf, p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    names.push(name)
    if (name === member) {
      if (csize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
        throw new ClaudeExportFileError('zip: ZIP64 entries are not supported')
      }
      if (u32(buf, localOffset) !== SIG_LOCAL) {
        throw new ClaudeExportFileError('zip: bad local header')
      }
      // The LOCAL header's name/extra lengths are the ones that count — they are
      // allowed to differ from the central directory's, and using the central
      // copy here reads the data from the wrong offset.
      const lNameLen = u16(buf, localOffset + 26)
      const lExtraLen = u16(buf, localOffset + 28)
      const start = localOffset + 30 + lNameLen + lExtraLen
      const end = start + csize
      if (end > buf.length) throw new ClaudeExportFileError('zip: entry runs past the file')
      const raw = buf.subarray(start, end)
      if (method === 0) return Buffer.from(raw)
      if (method !== 8) throw new ClaudeExportFileError(`zip: unsupported compression (${method})`)
      try {
        return inflateRawSync(raw, { maxOutputLength: MAX_EXPORT_INFLATED_BYTES })
      } catch (e) {
        // Includes the maxOutputLength refusal, which is the bomb guard firing.
        throw new ClaudeExportFileError(
          `zip: ${member} could not be decompressed (${e instanceof Error ? e.message : 'unknown'})`,
        )
      }
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new ClaudeExportFileError(
    `zip: no ${member} inside (found: ${names.slice(0, 8).join(', ') || 'nothing'})`,
  )
}

/**
 * Bytes the owner dropped → the export's parsed JSON.
 *
 * Accepts BOTH shapes without asking them which they have, because both are
 * things claude.ai actually hands out: the whole `data-….zip` as downloaded, and
 * a `conversations.json` someone already pulled out of one. Detected by content,
 * never by file name.
 */
export const readClaudeExportBytes = (bytes: Buffer): unknown => {
  if (bytes.length === 0) throw new ClaudeExportFileError('the file is empty')
  if (bytes.length > MAX_EXPORT_UPLOAD_BYTES) {
    throw new ClaudeExportFileError('the file is larger than this can take in')
  }
  const json = looksLikeZip(bytes) ? readZipMember(bytes, EXPORT_MEMBER) : bytes
  try {
    return JSON.parse(json.toString('utf8'))
  } catch {
    throw new ClaudeExportFileError('that is not JSON')
  }
}
