import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { registerTestProject } from '../../test/registerProject'
import { appendEngineJournalLine, engineJournalPath, readEngineJournalTail } from './engineJournal'
import type { OrchestratorLogLine } from '../types'

const line = (message: string, at = '2026-07-22T00:00:00.000Z'): OrchestratorLogLine => ({
  at,
  level: 'info',
  message,
})

describe('engineJournal — append-through persistence (card 1)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-journal-'))
    await registerTestProject(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a line written before "restart" is readable afterward (fresh read, no in-memory state)', async () => {
    await appendEngineJournalLine(dir, line('dispatch: card A'))
    await appendEngineJournalLine(dir, line('promote: card A', '2026-07-22T00:00:01.000Z'))

    // Simulate the restart: nothing but the file on disk is consulted.
    const tail = await readEngineJournalTail(dir)
    expect(tail.map((l) => l.message)).toEqual(['dispatch: card A', 'promote: card A'])
  })

  it('writes valid JSONL — one JSON object per line', async () => {
    await appendEngineJournalLine(dir, line('a'))
    await appendEngineJournalLine(dir, line('b'))
    const file = await engineJournalPath(dir)
    const raw = await import('fs/promises').then((m) => m.readFile(file, 'utf8'))
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  })

  it('skips a torn trailing line instead of failing the whole read', async () => {
    await appendEngineJournalLine(dir, line('good line'))
    const file = await engineJournalPath(dir)
    await import('fs/promises').then((m) => m.appendFile(file, '{"at":"broken', 'utf8'))
    const tail = await readEngineJournalTail(dir)
    expect(tail.map((l) => l.message)).toEqual(['good line'])
  })

  it('missing journal file reads back as empty, not an error', async () => {
    await expect(readEngineJournalTail(dir)).resolves.toEqual([])
  })

  it('rotates to a single `.1` generation once the file would exceed the cap', async () => {
    const file = await engineJournalPath(dir)
    // Seed a file already past the 5MB rotation threshold so the next append
    // must rotate, without actually writing 5MB line-by-line.
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf8')

    await appendEngineJournalLine(dir, line('triggers rotation'))

    const rotated = await stat(`${file}.1`)
    expect(rotated.size).toBeGreaterThan(5 * 1024 * 1024) // the old (huge) content moved here
    const tail = await readEngineJournalTail(dir)
    expect(tail.map((l) => l.message)).toEqual(['triggers rotation']) // fresh file holds only the new line

    // A second rotation overwrites `.1` rather than accumulating generations.
    await writeFile(file, 'y'.repeat(5 * 1024 * 1024 + 1), 'utf8')
    await appendEngineJournalLine(dir, line('second rotation'))
    const rotatedAgain = await stat(`${file}.1`)
    expect(rotatedAgain.size).toBeGreaterThan(5 * 1024 * 1024)
    const contents = await import('fs/promises').then((m) => m.readFile(`${file}.1`, 'utf8'))
    expect(contents.startsWith('y')).toBe(true) // not the first rotation's 'x' content
  })

  it('fail-open: an append to an unregistered project resolves without throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unregistered = await mkdtemp(join(tmpdir(), 'og-journal-unreg-'))
    await expect(appendEngineJournalLine(unregistered, line('never lands'))).resolves.toBeUndefined()
    await rm(unregistered, { recursive: true, force: true })
    spy.mockRestore()
  })
})
