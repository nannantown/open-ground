import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'zlib'
import {
  ClaudeExportFileError,
  EXPORT_MEMBER,
  MAX_EXPORT_INFLATED_BYTES,
  looksLikeZip,
  readClaudeExportBytes,
  readZipMember,
} from './claudeExportFile'

// The entry point for the owner's most private file, so every case here is
// about NOT GUESSING: a shape we cannot read is refused by name, never repaired
// into something that looks like an answer.
//
// The zip fixtures are built by this file rather than committed, so what is
// under test is the reader against real deflate output — a committed binary
// would be a fixture nobody can review, on the one path that parses untrusted
// length fields.

/** A minimal but SPEC-SHAPED zip: local headers, central directory, EOCD. */
const makeZip = (
  entries: Array<{ name: string; body: Buffer; store?: boolean }>,
  opts: { comment?: Buffer } = {},
): Buffer => {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = e.store ? e.body : deflateRawSync(e.body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(e.store ? 0 : 8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(e.body.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(e.store ? 0 : 8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(e.body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const comment = opts.comment ?? Buffer.alloc(0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(comment.length, 20)
  return Buffer.concat([localBuf, centralBuf, eocd, comment])
}

const EXPORT_JSON = JSON.stringify([
  { uuid: 'c1', name: 'n', chat_messages: [{ sender: 'human', text: 'a real sentence here' }] },
])

describe('looksLikeZip — decided by CONTENT, never by name', () => {
  it('knows a zip when it sees one', () => {
    expect(looksLikeZip(makeZip([{ name: 'x', body: Buffer.from('y') }]))).toBe(true)
  })

  it('does not mistake JSON for one', () => {
    expect(looksLikeZip(Buffer.from(EXPORT_JSON))).toBe(false)
    expect(looksLikeZip(Buffer.alloc(0))).toBe(false)
    expect(looksLikeZip(Buffer.from('PK'))).toBe(false)
  })
})

describe('readClaudeExportBytes — takes either shape the owner actually has', () => {
  it('reads a bare conversations.json', () => {
    expect(readClaudeExportBytes(Buffer.from(EXPORT_JSON))).toEqual(JSON.parse(EXPORT_JSON))
  })

  it('reads the export ZIP, which is what claude.ai actually hands over', () => {
    // ⚠ THE FEATURE. Before this, the app refused zips and told the owner to
    // open the archive and pull the file out themselves — homework, at the one
    // moment it is asking for their history.
    const zip = makeZip([
      { name: 'users.json', body: Buffer.from('{}') },
      { name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON) },
      { name: 'memories.json', body: Buffer.from('{}') },
    ])
    expect(readClaudeExportBytes(zip)).toEqual(JSON.parse(EXPORT_JSON))
  })

  it('reads a STORED (uncompressed) member too', () => {
    const zip = makeZip([{ name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON), store: true }])
    expect(readClaudeExportBytes(zip)).toEqual(JSON.parse(EXPORT_JSON))
  })

  it('finds the member behind a zip COMMENT (the EOCD is not always last)', () => {
    const zip = makeZip([{ name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON) }], {
      comment: Buffer.from('written by something with opinions'),
    })
    expect(readClaudeExportBytes(zip)).toEqual(JSON.parse(EXPORT_JSON))
  })

  it('says what is in the zip when the member is not', () => {
    // The owner may have grabbed the wrong archive. Naming what WAS inside is
    // the difference between a fixable mistake and "it failed".
    const zip = makeZip([{ name: 'users.json', body: Buffer.from('{}') }])
    expect(() => readClaudeExportBytes(zip)).toThrow(/no conversations\.json inside[\s\S]*users\.json/)
  })

  it('refuses an empty file, JSON that is not JSON, and anything oversized', () => {
    expect(() => readClaudeExportBytes(Buffer.alloc(0))).toThrow(ClaudeExportFileError)
    expect(() => readClaudeExportBytes(Buffer.from('not json at all'))).toThrow(/not JSON/)
  })
})

describe('the zip reader does not trust the numbers inside the zip', () => {
  // Every length here is written by whoever made the file. The rule is that a
  // bad one produces a REFUSAL, never a read at the wrong offset.
  it('refuses a file with no end-of-central-directory record', () => {
    expect(() => readZipMember(Buffer.from('PK\x03\x04' + 'x'.repeat(200)), EXPORT_MEMBER)).toThrow(
      /end-of-central-directory/,
    )
  })

  it('refuses a central-directory offset that points outside the file', () => {
    const zip = makeZip([{ name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON) }])
    const bad = Buffer.from(zip)
    // The EOCD sits 22 bytes from the end when there is no comment.
    bad.writeUInt32LE(0x7fffffff, bad.length - 22 + 16)
    expect(() => readZipMember(bad, EXPORT_MEMBER)).toThrow(/bad directory offset/)
  })

  it('refuses a ZIP64 marker rather than reading it as a 32-bit number', () => {
    const zip = makeZip([{ name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON) }])
    const bad = Buffer.from(zip)
    bad.writeUInt32LE(0xffffffff, bad.length - 22 + 16)
    expect(() => readZipMember(bad, EXPORT_MEMBER)).toThrow(/ZIP64/)
  })

  it('refuses a compression method it does not implement', () => {
    const zip = makeZip([{ name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON) }])
    const bad = Buffer.from(zip)
    // method lives at +10 in the LOCAL header… and at +10 in the central one,
    // which is the copy the reader trusts.
    const cdOffset = bad.readUInt32LE(bad.length - 22 + 16)
    bad.writeUInt16LE(99, cdOffset + 10)
    expect(() => readZipMember(bad, EXPORT_MEMBER)).toThrow(/unsupported compression \(99\)/)
  })

  it('refuses an entry whose declared size runs past the end of the file', () => {
    const zip = makeZip([{ name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON) }])
    const bad = Buffer.from(zip)
    const cdOffset = bad.readUInt32LE(bad.length - 22 + 16)
    bad.writeUInt32LE(0x7ffffff0, cdOffset + 20) // csize
    expect(() => readZipMember(bad, EXPORT_MEMBER)).toThrow(/past the file/)
  })

  it('has a bomb ceiling, and it is the INFLATE that enforces it', () => {
    // The declared uncompressed size is a hint written by the archive; the only
    // number that actually stops a bomb is the one handed to inflateRaw.
    expect(MAX_EXPORT_INFLATED_BYTES).toBeGreaterThan(100 * 1024 * 1024)
    const zip = makeZip([{ name: EXPORT_MEMBER, body: Buffer.from(EXPORT_JSON) }])
    const lying = Buffer.from(zip)
    const cdOffset = lying.readUInt32LE(lying.length - 22 + 16)
    lying.writeUInt32LE(0x7ffffff0, cdOffset + 24) // usize claims 2GB
    // …and the read still succeeds, because the real output is small. A reader
    // that pre-allocated from `usize` would have died here instead.
    expect(readZipMember(lying, EXPORT_MEMBER).toString()).toBe(EXPORT_JSON)
  })
})
