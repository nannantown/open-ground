import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat, realpath, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  encodeClaudeProjectKey,
  assembleYouCorpus,
  appendJudgment,
  readYouCorpus,
  readManualJudgments,
  readLiveJudgments,
  liveJudgments,
  retiredJudgments,
  retireJudgment,
  restoreJudgment,
  getCorpusStatus,
  TAKE_TAG,
} from './youCorpus'
import { COURSES } from '@/lib/persona/instruments'
import type { ManualJudgment } from '../types'
import { youCorpusFile, youCorpusAdditionsFile } from './paths'

// Partial os mock: the registry-resolution tests below need homedir() to point
// at a throwaway dir (autoMemoryDirFor computes ~/.claude/projects/… from it —
// the real ~/.claude must NEVER be read by tests). null → the real homedir, so
// every other test (all of which resolve sources via env overrides / explicit
// opts and never reach homedir) is unaffected.
let mockHomedir: string | null = null
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => mockHomedir ?? actual.homedir() }
})

// Phase-0 proxy judgment corpus. HOME is a throwaway dir per test (so the
// corpus + additions files start fresh and never touch the real ~/.openground),
// and the SOURCE locations are pointed at tmp fixtures via the env overrides
// (OPENGROUND_MEMORY_DIR / OPENGROUND_CONCEPT_PATH) so nothing reads the real
// ~/.claude auto-memory. Both the explicit-opts and the default (env) code paths
// are therefore hermetic.

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// A memory note with the same frontmatter shape Claude Code writes.
const writeMemory = (
  dir: string,
  filename: string,
  opts: { name: string; description?: string; type?: string; body: string },
) =>
  writeFile(
    join(dir, filename),
    `---\nname: ${opts.name}\ndescription: ${opts.description ?? ''}\nmetadata: \n  node_type: memory\n  type: ${opts.type ?? 'reference'}\n---\n\n${opts.body}\n`,
  )

let home: string
let memDir: string
let conceptPath: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-youcorpus-home-')))
  process.env.OPENGROUND_HOME = home

  const fixtures = await realpath(await mkdtemp(join(tmpdir(), 'og-youcorpus-src-')))
  memDir = join(fixtures, 'memory')
  await mkdir(memDir, { recursive: true })
  conceptPath = join(fixtures, 'CONCEPT.md')
  await writeFile(conceptPath, '# Concept\nCONCEPT_BODY_MARKER\n')

  await writeMemory(memDir, 'feedback_test.md', {
    name: 'feedback_test',
    description: 'a feedback note',
    type: 'feedback',
    body: 'FEEDBACK_BODY_MARKER',
  })
  await writeMemory(memDir, 'project_business_model_vision.md', {
    name: 'project_business_model_vision',
    description: 'the business soul',
    type: 'project',
    body: 'BUSINESS_BODY_MARKER',
  })
  await writeMemory(memDir, 'project_other.md', {
    name: 'project_other',
    type: 'project',
    body: 'PROJECT_BODY_MARKER',
  })
  await writeMemory(memDir, 'reference_test.md', {
    name: 'reference_test',
    type: 'reference',
    body: 'REFERENCE_BODY_MARKER',
  })
  await writeMemory(memDir, 'user_me.md', { name: 'user_me', type: 'user', body: 'USER_BODY_MARKER' })
  // The index is a pointer list — must NOT be ingested.
  await writeFile(join(memDir, 'MEMORY.md'), '- [x](feedback_test.md) — INDEX_SHOULD_NOT_APPEAR\n')

  process.env.OPENGROUND_MEMORY_DIR = memDir
  process.env.OPENGROUND_CONCEPT_PATH = conceptPath
})

afterEach(async () => {
  delete process.env.OPENGROUND_MEMORY_DIR
  delete process.env.OPENGROUND_CONCEPT_PATH
  mockHomedir = null
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('encodeClaudeProjectKey', () => {
  it('replaces every non-alphanumeric char with "-" (no run-collapsing)', () => {
    expect(encodeClaudeProjectKey('/Users/dev/projects/OPEN GROUND')).toBe(
      '-Users-dev-projects-OPEN-GROUND',
    )
    // underscore and dot are non-alphanumeric too; '/.' becomes '--'
    expect(encodeClaudeProjectKey('/a/OPEN_GROUND-w3')).toBe('-a-OPEN-GROUND-w3')
    expect(encodeClaudeProjectKey('/Users/k/.openground')).toBe('-Users-k--openground')
  })
})

describe('assembleYouCorpus', () => {
  it('writes a single self-describing file pulling all four source kinds', async () => {
    const meta = await assembleYouCorpus({ memoryDir: memDir, conceptPath })

    // Done #1: the single injectable file exists, under the (central) app home.
    expect(meta.path).toBe(youCorpusFile())
    expect(meta.path.startsWith(home)).toBe(true)
    expect(await exists(meta.path)).toBe(true)

    const text = await readFile(meta.path, 'utf8')
    // Proxy framing (this file IS the injection).
    expect(text).toContain('proxy')
    expect(text).toContain('エスカレーション')
    // Done #2: the mechanical sources are all present.
    expect(text).toContain('CONCEPT_BODY_MARKER')
    expect(text).toContain('BUSINESS_BODY_MARKER')
    expect(text).toContain('FEEDBACK_BODY_MARKER')
    expect(text).toContain('PROJECT_BODY_MARKER')
    expect(text).toContain('REFERENCE_BODY_MARKER')
    expect(text).toContain('USER_BODY_MARKER')
    // The index is not a judgment — never ingested.
    expect(text).not.toContain('INDEX_SHOULD_NOT_APPEAR')

    expect(meta.conceptIncluded).toBe(true)
    expect(meta.businessVisionIncluded).toBe(true)
    expect(meta.memoryCount).toBe(5) // 5 notes (MEMORY.md excluded)
    expect(meta.manualCount).toBe(0)
  })

  it('pins business_model_vision once (not duplicated in the project list)', async () => {
    await assembleYouCorpus({ memoryDir: memDir, conceptPath })
    const text = await readFile(youCorpusFile(), 'utf8')
    const occurrences = text.split('BUSINESS_BODY_MARKER').length - 1
    expect(occurrences).toBe(1)
  })

  it('degrades gracefully when sources are missing', async () => {
    const meta = await assembleYouCorpus({
      memoryDir: join(tmpdir(), 'definitely-no-such-dir-xyz'),
      conceptPath: join(tmpdir(), 'definitely-no-such-concept-xyz.md'),
    })
    expect(await exists(youCorpusFile())).toBe(true)
    expect(meta.memoryCount).toBe(0)
    expect(meta.conceptIncluded).toBe(false)
    expect(meta.businessVisionIncluded).toBe(false)
  })

  it('explicit opts override the env defaults', async () => {
    // memoryDir:null means "no memory" even though OPENGROUND_MEMORY_DIR is set.
    const meta = await assembleYouCorpus({ memoryDir: null, conceptPath })
    expect(meta.memoryCount).toBe(0)
    expect(meta.conceptIncluded).toBe(true)
  })
})

describe('appendJudgment (the "new decision" command)', () => {
  it('persists a judgment, renders it, and SURVIVES a later rebuild', async () => {
    const { judgment, meta } = await appendJudgment({
      text: 'JUDGE_MARKER value over economy',
      tags: ['cost', 'philosophy'],
      context: 'why: maximize throughput',
    })
    expect(judgment.id).toMatch(/[0-9a-f-]{36}/)
    expect(judgment.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(meta.manualCount).toBe(1)

    // Stored in the additions JSON.
    const stored = await readManualJudgments()
    expect(stored).toHaveLength(1)
    expect(stored[0].text).toBe('JUDGE_MARKER value over economy')
    expect(stored[0].tags).toEqual(['cost', 'philosophy'])

    // Rendered into the single file.
    let text = await readFile(youCorpusFile(), 'utf8')
    expect(text).toContain('JUDGE_MARKER value over economy')

    // The load-bearing property: re-ingesting the mechanical sources must NOT
    // wipe the hand-added judgment.
    const meta2 = await assembleYouCorpus({ memoryDir: memDir, conceptPath })
    expect(meta2.manualCount).toBe(1)
    text = await readFile(youCorpusFile(), 'utf8')
    expect(text).toContain('JUDGE_MARKER value over economy')
    expect(text).toContain('FEEDBACK_BODY_MARKER') // sources still there too
  })

  it('keeps multiple judgments newest-first', async () => {
    await appendJudgment({ text: 'OLDEST_JUDGE' })
    await appendJudgment({ text: 'NEWEST_JUDGE' })
    const text = await readFile(youCorpusFile(), 'utf8')
    expect(text.indexOf('NEWEST_JUDGE')).toBeLessThan(text.indexOf('OLDEST_JUDGE'))
    expect((await readManualJudgments()).length).toBe(2)
  })

  it('rejects empty text', async () => {
    await expect(appendJudgment({ text: '   ' })).rejects.toThrow()
  })

  it('does not lose updates under concurrent appends', async () => {
    await Promise.all([
      appendJudgment({ text: 'CONCURRENT_A' }),
      appendJudgment({ text: 'CONCURRENT_B' }),
      appendJudgment({ text: 'CONCURRENT_C' }),
    ])
    const stored = await readManualJudgments()
    expect(stored).toHaveLength(3)
    expect(stored.map((j) => j.text).sort()).toEqual([
      'CONCURRENT_A',
      'CONCURRENT_B',
      'CONCURRENT_C',
    ])
  })
})

describe('correction = append (never edit)', () => {
  it('stores the id of the judgment being corrected, and leaves that one alone', async () => {
    const { judgment: original } = await appendJudgment({ text: 'ORIGINAL_CALL' })
    const { judgment: correction } = await appendJudgment({
      text: 'WHAT_IS_ACTUALLY_TRUE',
      context: 'Corrects an earlier note: ORIGINAL_CALL',
      correctsId: original.id,
    })
    expect(correction.correctsId).toBe(original.id)

    // The id has to survive the file round-trip — the reader's type guard only
    // demands `text`, so a stricter reshaping there would silently drop it.
    const live = await readManualJudgments()
    expect(live.find((j) => j.text === 'WHAT_IS_ACTUALLY_TRUE')?.correctsId).toBe(original.id)
    // The corrected note is still there, unchanged and unmarked: what the owner
    // wrote is never rewritten, a correction is only ever stacked on top.
    const kept = live.find((j) => j.text === 'ORIGINAL_CALL')
    expect(kept?.id).toBe(original.id)
    expect(kept?.correctsId).toBeUndefined()
  })

  it('leaves correctsId off a plain note', async () => {
    const { judgment } = await appendJudgment({ text: 'JUST_A_NOTE' })
    expect(judgment.correctsId).toBeUndefined()
    expect('correctsId' in judgment).toBe(false)
  })

  // ⚠ THE HALF THAT WAS NEVER IMPLEMENTED (found 2026-08-16). `correctsId` has
  // been written correctly since the correction UI shipped — and read by NOBODY.
  // The assembled corpus carried the wrong line and its correction side by side
  // as two equal bullets, while the persona prompt told `claude` that "a wrong
  // line can only ever be superseded, never removed". This asserts the FILE, not
  // the field: the field was always right.
  it('the corrected line LEAVES the corpus claude is handed — and stays on disk', async () => {
    const { judgment: original } = await appendJudgment({ text: 'I_ALWAYS_SHIP_ON_FRIDAY' })
    await appendJudgment({ text: 'I_NEVER_SHIP_ON_FRIDAY', correctsId: original.id })

    const corpus = await readFile(youCorpusFile(), 'utf8')
    expect(corpus).toContain('I_NEVER_SHIP_ON_FRIDAY')
    expect(corpus).not.toContain('I_ALWAYS_SHIP_ON_FRIDAY')

    // NOTHING WAS DELETED. Append-only is the safety property; "only the latest
    // counts" is a reading rule, and the two must both hold at once.
    const onDisk = await readManualJudgments()
    expect(onDisk.map((j) => j.text)).toContain('I_ALWAYS_SHIP_ON_FRIDAY')
    expect((await readLiveJudgments()).map((j) => j.text)).not.toContain(
      'I_ALWAYS_SHIP_ON_FRIDAY',
    )
  })
})

describe('「取り消す」 = append (never delete)', () => {
  // ⚠ READ BACK WITH THE PRODUCTION READER, and out of the FILE claude is
  // handed — not out of the return value. A writer that returned a plausible
  // object and wrote nothing would satisfy any assertion about its own result.
  it('takes a line out of the corpus while leaving it on disk', async () => {
    const { judgment } = await appendJudgment({ text: 'I_ONLY_WORK_AT_NIGHT' })
    await appendJudgment({ text: 'KEEP_THIS_ONE' })
    await retireJudgment(judgment.id)

    const corpus = await readFile(youCorpusFile(), 'utf8')
    expect(corpus).toContain('KEEP_THIS_ONE')
    expect(corpus).not.toContain('I_ONLY_WORK_AT_NIGHT')

    // Nothing was deleted — the withdrawn line, and the marker that withdrew it,
    // are both in the append-only file.
    const onDisk = await readManualJudgments()
    expect(onDisk.filter((j) => j.text === 'I_ONLY_WORK_AT_NIGHT')).toHaveLength(2)
    expect(onDisk.some((j) => j.retiredId === judgment.id)).toBe(true)
    // …and it is reported as withdrawn, with a date.
    const retired = retiredJudgments(onDisk)
    expect(retired.map((r) => r.judgment.id)).toEqual([judgment.id])
    expect(retired[0].retiredAt).toMatch(/^\d{4}-/)
  })

  it('「戻す」 puts it back into the corpus claude reads', async () => {
    const { judgment } = await appendJudgment({ text: 'ACTUALLY_I_DO_WORK_AT_NIGHT' })
    await retireJudgment(judgment.id)
    expect(await readFile(youCorpusFile(), 'utf8')).not.toContain('ACTUALLY_I_DO_WORK_AT_NIGHT')

    await restoreJudgment(judgment.id)
    expect(await readFile(youCorpusFile(), 'utf8')).toContain('ACTUALLY_I_DO_WORK_AT_NIGHT')
    expect(retiredJudgments(await readManualJudgments())).toEqual([])
  })

  it('refuses an id that is not in the file rather than leaving a dangling marker', async () => {
    await appendJudgment({ text: 'SOMETHING' })
    await expect(retireJudgment('not-a-real-id')).rejects.toThrow()
    await expect(restoreJudgment('not-a-real-id')).rejects.toThrow()
    // …and nothing was written by the attempt.
    expect((await readManualJudgments()).some((j) => j.retiredId || j.restoredId)).toBe(false)
  })
})

// ─── SUPERSESSION, AS A PURE FUNCTION ───────────────────────────────────────
//
// The end-to-end proof (two real takes through the real writer, read back out
// of the assembled file) lives in personaCourses.test.ts. These pin the RULES,
// including the two places the rule deliberately abstains.
describe('liveJudgments — which lines still speak for the owner', () => {
  const big5 = COURSES[0].id
  const other = COURSES[1].id
  const j = (over: Partial<ManualJudgment> & { id: string; text: string }): ManualJudgment => ({
    addedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  })
  const finding = (id: string, course: string, take: string | null): ManualJudgment =>
    j({ id, text: `${id}-text`, tags: ['persona', course, ...(take ? [TAKE_TAG(take)] : [])] })
  const texts = (list: ManualJudgment[]) => list.map((x) => x.text)

  it('keeps only the NEWEST take of a course', () => {
    const live = liveJudgments([
      finding('a1', big5, '2026-08-01T00:00:00.000Z'),
      finding('a2', big5, '2026-08-01T00:00:00.000Z'),
      finding('b1', big5, '2026-08-14T09:00:00.000Z'),
    ])
    expect(texts(live)).toEqual(['b1-text'])
  })

  it('orders takes by the STAMP, not by the order they sit in the file', () => {
    // Appends are chronological in practice; a file hand-edited or restored out
    // of order must still resolve to the take that was actually taken last.
    const live = liveJudgments([
      finding('newer', big5, '2026-08-14T09:00:00.000Z'),
      finding('older', big5, '2026-08-01T00:00:00.000Z'),
    ])
    expect(texts(live)).toEqual(['newer-text'])
  })

  it('never lets one course retire another', () => {
    const live = liveJudgments([
      finding('big5-old', big5, '2026-08-01T00:00:00.000Z'),
      finding('other-only', other, '2026-08-01T00:00:00.000Z'),
      finding('big5-new', big5, '2026-08-14T09:00:00.000Z'),
    ])
    expect(texts(live).sort()).toEqual(['big5-new-text', 'other-only-text'])
  })

  // ⚠ ABSTENTION 1 — the upgrade path. Findings written before the stamp
  // existed carry a course tag and no take. Retiring them on sight would delete
  // the persona of anyone who upgrades without retaking anything.
  it('keeps unstamped findings while that course has never been redone', () => {
    const live = liveJudgments([
      finding('legacy-1', big5, null),
      finding('legacy-2', big5, null),
      j({ id: 'plain', text: 'a note the owner typed' }),
    ])
    expect(texts(live).sort()).toEqual(['a note the owner typed', 'legacy-1-text', 'legacy-2-text'])
  })

  it('…and retires them the moment that course IS redone', () => {
    const live = liveJudgments([
      finding('legacy', big5, null),
      finding('fresh', big5, '2026-08-14T09:00:00.000Z'),
    ])
    expect(texts(live)).toEqual(['fresh-text'])
  })

  // ⚠ ABSTENTION 2 — no guessing by clock. Two unstamped takes carry no
  // evidence of which came last, and `addedAt` order is exactly the kind of
  // inference this file exists to refuse to make about the owner.
  it('keeps BOTH when nothing says which unstamped take came last', () => {
    const live = liveJudgments([
      j({ id: 'u1', text: 'u1', tags: ['persona', big5], addedAt: '2026-08-01T00:00:00.000Z' }),
      j({ id: 'u2', text: 'u2', tags: ['persona', big5], addedAt: '2026-08-14T00:00:00.000Z' }),
    ])
    expect(texts(live).sort()).toEqual(['u1', 'u2'])
  })

  it('a correction retires its target wherever it sits', () => {
    const live = liveJudgments([
      j({ id: 'wrong', text: 'wrong' }),
      j({ id: 'right', text: 'right', correctsId: 'wrong' }),
    ])
    expect(texts(live)).toEqual(['right'])
  })

  it('leaves an ordinary note alone — it has no course and nobody corrected it', () => {
    const live = liveJudgments([j({ id: 'n', text: 'plain' })])
    expect(texts(live)).toEqual(['plain'])
  })

  // ── 「取り消す」 — the third way a line stops counting ──────────────────────
  const tomb = (target: string, text: string, at = '2026-08-16T00:00:00.000Z') =>
    j({ id: `t-${target}`, text, retiredId: target, addedAt: at })
  const back = (target: string, text: string, at = '2026-08-17T00:00:00.000Z') =>
    j({ id: `r-${target}`, text, restoredId: target, addedAt: at })

  it('a retired line stops speaking — and so does the marker that retired it', () => {
    // ⚠ THE SECOND HALF IS THE ONE THAT BITES. The tombstone carries the retired
    // line's own words (so the raw file is readable by a human), which means a
    // reader that only dropped the TARGET would leave an identical sentence
    // standing in the corpus — taking a line back would change nothing at all.
    const live = liveJudgments([
      j({ id: 'gone', text: 'これは要らない' }),
      j({ id: 'kept', text: 'これは要る' }),
      tomb('gone', 'これは要らない'),
    ])
    expect(texts(live)).toEqual(['これは要る'])
  })

  it('「戻す」 puts it back, and the log is read IN ORDER', () => {
    const live = liveJudgments([
      j({ id: 'x', text: 'ひとつ' }),
      tomb('x', 'ひとつ'),
      back('x', 'ひとつ'),
    ])
    expect(texts(live)).toEqual(['ひとつ'])
    // …and taking it back AGAIN after that sticks.
    const again = liveJudgments([
      j({ id: 'x', text: 'ひとつ' }),
      tomb('x', 'ひとつ'),
      back('x', 'ひとつ'),
      tomb('x', 'ひとつ', '2026-08-18T00:00:00.000Z'),
    ])
    expect(texts(again)).toEqual([])
  })

  it('⚠ IS IDEMPOTENT — a double-send never resurrects what was withdrawn', () => {
    // A toggle would flip back here. Two windows open, or one impatient
    // double-click, and the line the owner deliberately took back returns.
    const live = liveJudgments([
      j({ id: 'x', text: 'ひとつ' }),
      tomb('x', 'ひとつ'),
      tomb('x', 'ひとつ', '2026-08-16T00:00:01.000Z'),
    ])
    expect(texts(live)).toEqual([])
    // …and the same on the restore side.
    const restored = liveJudgments([
      j({ id: 'y', text: 'ふたつ' }),
      tomb('y', 'ふたつ'),
      back('y', 'ふたつ'),
      back('y', 'ふたつ', '2026-08-17T00:00:01.000Z'),
    ])
    expect(texts(restored)).toEqual(['ふたつ'])
  })

  it('retiredJudgments reports the withdrawn line and WHEN it was withdrawn', () => {
    const all = [
      j({ id: 'gone', text: 'これは要らない' }),
      j({ id: 'kept', text: 'これは要る' }),
      tomb('gone', 'これは要らない', '2026-08-16T09:30:00.000Z'),
    ]
    expect(retiredJudgments(all)).toEqual([
      { judgment: all[0], retiredAt: '2026-08-16T09:30:00.000Z' },
    ])
    // A line that was put back is not in the list at all.
    expect(retiredJudgments([...all, back('gone', 'これは要らない')])).toEqual([])
  })

  it('reports the LATEST withdrawal date, not the first', () => {
    const all = [
      j({ id: 'x', text: 'ひとつ' }),
      tomb('x', 'ひとつ', '2026-08-16T00:00:00.000Z'),
      back('x', 'ひとつ', '2026-08-17T00:00:00.000Z'),
      tomb('x', 'ひとつ', '2026-08-18T00:00:00.000Z'),
    ]
    expect(retiredJudgments(all).map((r) => r.retiredAt)).toEqual(['2026-08-18T00:00:00.000Z'])
  })

  it('a tombstone pointing at nothing produces no row', () => {
    // A hand-edited file, or a half-restored backup. A row with a date and no
    // sentence in it is worse than no row.
    expect(retiredJudgments([tomb('missing', 'どこにもない')])).toEqual([])
  })
})

describe('privacy', () => {
  it('writes both personal files 0600 (owner-only)', async () => {
    await appendJudgment({ text: 'private judgment' }) // creates both files
    const corpusMode = (await stat(youCorpusFile())).mode & 0o777
    const additionsMode = (await stat(youCorpusAdditionsFile())).mode & 0o777
    expect(corpusMode).toBe(0o600)
    expect(additionsMode).toBe(0o600)
  })
})

describe('resilience', () => {
  // The other half of "unreadable ≠ absent": an additions file that genuinely
  // is not there yet must still read as empty, quietly. Without this, the fix
  // for the unreadable case could just as easily have been over-applied into
  // "every fresh install errors on its first visit to the tab".
  it('an ABSENT additions file is simply empty — no error on a fresh home', async () => {
    expect(await exists(youCorpusAdditionsFile())).toBe(false)
    expect(await readManualJudgments()).toEqual([])
    expect((await getCorpusStatus()).manualCount).toBe(0)
    const meta = await assembleYouCorpus({ memoryDir: memDir, conceptPath })
    expect(meta.manualCount).toBe(0)
  })

  // The judgment is written BEFORE the corpus is re-assembled, so a failure in
  // the second half must not be reported as a failure of the first: the Persona
  // tab keeps the owner's draft on error and lets them press the button again,
  // which would write the same judgment twice.
  it('an append whose re-assembly fails reports SAVED-but-stale, not a failure', async () => {
    // A directory where the corpus file belongs: the additions write still
    // succeeds, the rename that publishes the assembled corpus cannot.
    await mkdir(youCorpusFile(), { recursive: true })

    const { judgment, meta } = await appendJudgment({ text: 'SAVED_DESPITE_REBUILD_FAILURE' })

    expect(judgment.text).toBe('SAVED_DESPITE_REBUILD_FAILURE')
    // Told the truth: it landed, the file the overseer reads is stale.
    expect(meta.skipped).toBe(true)
    expect(meta.warning).toBeTruthy()
    expect(meta.manualCount).toBe(1)

    // And it really is on disk — exactly once.
    const stored = await readManualJudgments()
    expect(stored.map((j) => j.text)).toEqual(['SAVED_DESPITE_REBUILD_FAILURE'])
  })

  it('tolerates a corrupted additions file during assembly (treats it as empty)', async () => {
    await writeFile(youCorpusAdditionsFile(), 'not json {{{')
    expect(await readManualJudgments()).toEqual([])
    const meta = await assembleYouCorpus({ memoryDir: memDir, conceptPath })
    expect(meta.manualCount).toBe(0)
    expect(await exists(youCorpusFile())).toBe(true)
  })

  it('an append PRESERVES a corrupt additions file instead of silently clobbering it', async () => {
    // A valid judgment, then a corruption that keeps the prior text in the file
    // (the dangerous case: a stray trailing char on an otherwise-valid array).
    await appendJudgment({ text: 'PRESERVE_ME' })
    const valid = await readFile(youCorpusAdditionsFile(), 'utf8')
    expect(valid).toContain('PRESERVE_ME')
    await writeFile(youCorpusAdditionsFile(), valid + 'X') // now malformed JSON

    // The next append must NOT overwrite the corrupt file blind.
    await appendJudgment({ text: 'NEW_ONE' })

    // Live additions hold only the new judgment...
    const live = await readManualJudgments()
    expect(live.map((j) => j.text)).toEqual(['NEW_ONE'])

    // ...and the prior data is recoverable in a .corrupt-* backup (NOT lost).
    const files = await readdir(process.env.OPENGROUND_HOME as string)
    const backup = files.find((f) => f.startsWith('you-corpus-additions.json.corrupt-'))
    expect(backup).toBeTruthy()
    const backupText = await readFile(
      join(process.env.OPENGROUND_HOME as string, backup as string),
      'utf8',
    )
    expect(backupText).toContain('PRESERVE_ME')

    const corpus = await readFile(youCorpusFile(), 'utf8')
    expect(corpus).toContain('NEW_ONE')
  })
})

describe('readYouCorpus / getCorpusStatus', () => {
  it('readYouCorpus assembles on demand when the file is missing', async () => {
    expect(await exists(youCorpusFile())).toBe(false)
    const text = await readYouCorpus() // uses env-fixture sources
    expect(text).toContain('proxy')
    expect(text).toContain('CONCEPT_BODY_MARKER')
    expect(await exists(youCorpusFile())).toBe(true)
  })

  it('getCorpusStatus reports sources before and after assembly', async () => {
    const before = await getCorpusStatus()
    expect(before.exists).toBe(false)
    expect(before.memoryCount).toBe(5)
    expect(before.businessVisionExists).toBe(true)
    expect(before.conceptExists).toBe(true)

    await assembleYouCorpus()
    const after = await getCorpusStatus()
    expect(after.exists).toBe(true)
    expect(after.sizeBytes).toBeGreaterThan(0)
    expect(after.assembledAt).not.toBeNull()
  })
})

// ─── The 2026-07-17 incident guards ──────────────────────────────────────────
// The packaged app's server cwd is NOT the OPEN GROUND repo. A rebuild from
// there used to resolve zero mechanical sources and overwrite a 410KB corpus
// with a near-empty one. Two independent fixes are covered here: the fail-safe
// (an empty assembly must not destroy a populated corpus) and the registry
// resolution (sources resolve without any cwd at all).

describe('fail-safe: empty assembly never destroys a populated corpus', () => {
  it('a rebuild with cwd outside any repo keeps the existing corpus (skipped+warning)', async () => {
    // A healthy corpus, built from the env-override fixtures.
    await assembleYouCorpus()
    const before = await readFile(youCorpusFile(), 'utf8')
    expect(before).toContain('CONCEPT_BODY_MARKER')

    // Packaged-app conditions: no env overrides, cwd pointed OUTSIDE any git
    // repo (an explicit cwd also keeps the resolver away from the real
    // process.cwd() checkout — hermetic).
    delete process.env.OPENGROUND_MEMORY_DIR
    delete process.env.OPENGROUND_CONCEPT_PATH
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'og-nonrepo-')))
    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const meta = await assembleYouCorpus({ cwd: outside })
        expect(meta.skipped).toBe(true)
        expect(meta.warning).toMatch(/no mechanical sources/)
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
      // The load-bearing assertion: the file is byte-identical.
      expect(await readFile(youCorpusFile(), 'utf8')).toBe(before)
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('appendJudgment (the escalation-answer path) preserves the corpus AND the judgment', async () => {
    await assembleYouCorpus()
    const before = await readFile(youCorpusFile(), 'utf8')

    // Resolution "succeeds" but both sources are gone (unmounted-disk shape).
    process.env.OPENGROUND_MEMORY_DIR = join(tmpdir(), 'og-no-such-memory-dir-xyz')
    process.env.OPENGROUND_CONCEPT_PATH = join(tmpdir(), 'og-no-such-concept-xyz.md')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { meta } = await appendJudgment({ text: 'ANSWER_LEARNED_MARKER' })
      expect(meta.skipped).toBe(true)
      expect(meta.manualCount).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }

    // The corpus file is untouched…
    expect(await readFile(youCorpusFile(), 'utf8')).toBe(before)
    // …but the judgment IS persisted in the additions file (nothing is lost —
    // the next healthy rebuild folds it in).
    const stored = await readManualJudgments()
    expect(stored.map((j) => j.text)).toEqual(['ANSWER_LEARNED_MARKER'])
  })

  it('a corpus that never had mechanical sources keeps accepting manual-only assembly', async () => {
    // Fresh-machine shape: no mechanical sources from day one.
    delete process.env.OPENGROUND_MEMORY_DIR
    delete process.env.OPENGROUND_CONCEPT_PATH
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'og-nonrepo-')))
    try {
      // First write is allowed (nothing to protect)…
      const first = await assembleYouCorpus({ cwd: outside })
      expect(first.skipped).toBeUndefined()
      expect(await exists(youCorpusFile())).toBe(true)

      // …and manual-only REassembly keeps landing (no false lock-out): a
      // mechanical-source-free corpus is a legitimate state, not damage.
      const { meta } = await appendJudgment({ text: 'MANUAL_ONLY_MARKER' })
      expect(meta.skipped).toBeUndefined()
      expect(meta.manualCount).toBe(1)
      expect(await readFile(youCorpusFile(), 'utf8')).toContain('MANUAL_ONLY_MARKER')
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('registry resolution (cwd-independent sources)', () => {
  let fakeHome: string
  let repo: string
  let outsideTmps: string[]

  // A fake OPEN GROUND checkout (CONCEPT.md in the repo) + its auto-memory dir
  // under a MOCKED homedir, registered in the project registry. No env
  // overrides — this exercises the registry path end to end. process.cwd() IS
  // a real git checkout while these tests run, so every assertion that the
  // REGISTRY fixtures land in the corpus doubles as proof cwd was never used.
  beforeEach(async () => {
    delete process.env.OPENGROUND_MEMORY_DIR
    delete process.env.OPENGROUND_CONCEPT_PATH
    outsideTmps = []
    fakeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-fake-usrhome-')))
    mockHomedir = fakeHome
    repo = await mkRegisteredRepo('og-fake-repo-', {
      concept: 'REGISTRY_CONCEPT_MARKER',
      memories: [
        { file: 'project_business_model_vision.md', name: 'project_business_model_vision', body: 'REGISTRY_BIZ_MARKER' },
        { file: 'feedback_reg.md', name: 'feedback_reg', body: 'REGISTRY_MEMO_MARKER' },
      ],
    })
    await writeRegistry([repo])
  })

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
    for (const d of outsideTmps) await rm(d, { recursive: true, force: true }).catch(() => {})
  })

  // Creates a fake registered-project folder + its auto-memory dir under the
  // mocked homedir. Returns the repo path.
  const mkRegisteredRepo = async (
    prefix: string,
    fixture: { concept?: string; memories: { file: string; name: string; body: string }[] },
  ): Promise<string> => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    outsideTmps.push(dir)
    if (fixture.concept) await writeFile(join(dir, 'CONCEPT.md'), `# C\n${fixture.concept}\n`)
    const mem = join(fakeHome, '.claude', 'projects', encodeClaudeProjectKey(dir), 'memory')
    await mkdir(mem, { recursive: true })
    for (const m of fixture.memories) {
      await writeMemory(mem, m.file, { name: m.name, type: 'project', body: m.body })
    }
    return dir
  }

  const writeRegistry = (paths: string[]) =>
    writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        projects: paths.map((p, i) => ({ id: `reg-${i}`, path: p, addedAt: new Date().toISOString() })),
      }),
    )

  it('assembles all sources from the registry with NO cwd and no env overrides', async () => {
    const meta = await assembleYouCorpus() // ← no opts at all: the route's exact call shape
    expect(meta.skipped).toBeUndefined()
    expect(meta.conceptIncluded).toBe(true)
    expect(meta.businessVisionIncluded).toBe(true)
    expect(meta.memoryCount).toBe(2)

    const text = await readFile(youCorpusFile(), 'utf8')
    // Registry fixtures — and NOT the real checkout process.cwd() lives in.
    expect(text).toContain('REGISTRY_CONCEPT_MARKER')
    expect(text).toContain('REGISTRY_BIZ_MARKER')
    expect(text).toContain('REGISTRY_MEMO_MARKER')
  })

  it('prefers the entry whose memory holds business_model_vision', async () => {
    // A DECOY registered project that also has CONCEPT.md + memory (more notes),
    // but no business-vision note — the vision-bearing repo must still win.
    const decoy = await mkRegisteredRepo('og-decoy-repo-', {
      concept: 'DECOY_CONCEPT_MARKER',
      memories: [
        { file: 'project_a.md', name: 'project_a', body: 'DECOY_A' },
        { file: 'project_b.md', name: 'project_b', body: 'DECOY_B' },
        { file: 'project_c.md', name: 'project_c', body: 'DECOY_C' },
      ],
    })
    await writeRegistry([decoy, repo])

    const meta = await assembleYouCorpus()
    expect(meta.businessVisionIncluded).toBe(true)
    const text = await readFile(youCorpusFile(), 'utf8')
    expect(text).toContain('REGISTRY_CONCEPT_MARKER')
    expect(text).not.toContain('DECOY_CONCEPT_MARKER')
  })

  it('getCorpusStatus reflects the registry-resolved sources', async () => {
    const s = await getCorpusStatus()
    expect(s.memoryDir).toBe(join(fakeHome, '.claude', 'projects', encodeClaudeProjectKey(repo), 'memory'))
    expect(s.memoryDirExists).toBe(true)
    expect(s.memoryCount).toBe(2)
    expect(s.conceptPath).toBe(join(repo, 'CONCEPT.md'))
    expect(s.conceptExists).toBe(true)
    expect(s.businessVisionExists).toBe(true)
  })

  it('registry entries without BOTH sources never qualify (no half-matches)', async () => {
    // concept-only and memory-only entries are skipped even when they come
    // FIRST in the registry — only the full (CONCEPT.md + memory) entry
    // qualifies, so a random registered project holding some CONCEPT.md can't
    // hijack the corpus.
    const conceptOnly = await mkRegisteredRepo('og-conceptonly-', {
      concept: 'HALF_CONCEPT_MARKER',
      memories: [],
    })
    // Drop its auto-memory dir entirely: CONCEPT.md alone must not qualify.
    await rm(join(fakeHome, '.claude', 'projects', encodeClaudeProjectKey(conceptOnly)), {
      recursive: true,
      force: true,
    })
    const memoryOnly = await mkRegisteredRepo('og-memoryonly-', {
      memories: [{ file: 'project_x.md', name: 'project_x', body: 'HALF_MEMORY_MARKER' }],
    })
    await writeRegistry([conceptOnly, memoryOnly, repo])

    const meta = await assembleYouCorpus()
    expect(meta.skipped).toBeUndefined()
    expect(meta.conceptIncluded).toBe(true)
    const text = await readFile(youCorpusFile(), 'utf8')
    expect(text).toContain('REGISTRY_CONCEPT_MARKER') // the full entry won
    expect(text).not.toContain('HALF_CONCEPT_MARKER')
    expect(text).not.toContain('HALF_MEMORY_MARKER')
  })
})

// ─── Unreadable ≠ absent (the tolerant-reader trap) ──────────────────────────
// Both writers below used to collapse EVERY read failure into "the file isn't
// there", which turns a transient/permission condition into permanent silent
// loss: the append would write a fresh one-element array over a populated
// additions file, and the assemble fail-safe would disarm itself and overwrite
// a populated corpus. Only ENOENT may mean "empty"; anything else must refuse.
//
// chmod is the only way to make a real read fail, so these skip where it does
// not bite: as root (permission bits are ignored) and on Windows.
const chmodBites = process.platform !== 'win32' && process.getuid?.() !== 0

describe.skipIf(!chmodBites)('an UNREADABLE file is never treated as an empty one', () => {
  it('append REFUSES rather than clobbering an unreadable additions file', async () => {
    await appendJudgment({ text: 'FIRST_JUDGMENT' })
    await appendJudgment({ text: 'SECOND_JUDGMENT' })
    const file = youCorpusAdditionsFile()
    const before = await readFile(file, 'utf8')
    expect(JSON.parse(before)).toHaveLength(2)

    await chmod(file, 0o000)
    try {
      // The append must SURFACE the failure — a thrown error is recoverable,
      // an erased history is not.
      await expect(appendJudgment({ text: 'WOULD_HAVE_ERASED_EVERYTHING' })).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }

    // The load-bearing assertion: the prior judgments are still all there, and
    // nothing was quietly moved aside either (a read failure is not corruption).
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await readManualJudgments()).map((j) => j.text)).toEqual([
      'FIRST_JUDGMENT',
      'SECOND_JUDGMENT',
    ])
    const strays = (await readdir(join(process.env.OPENGROUND_HOME as string))).filter((n) =>
      n.includes('.corrupt-'),
    )
    expect(strays).toEqual([])
  })

  // The READERS have to obey the same rule as the writer above, or the two
  // contradict each other on one file: the append refuses to touch it while the
  // status/tab/assembly all report it as "you have written nothing yet".
  it('readManualJudgments SURFACES an unreadable additions file instead of reporting empty', async () => {
    await appendJudgment({ text: 'FIRST_JUDGMENT' })
    await appendJudgment({ text: 'SECOND_JUDGMENT' })
    const file = youCorpusAdditionsFile()

    await chmod(file, 0o000)
    try {
      await expect(readManualJudgments()).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    // Still all there once it is readable again — the throw was about VISIBILITY,
    // and nothing about the file changed.
    expect((await readManualJudgments()).map((j) => j.text)).toEqual([
      'FIRST_JUDGMENT',
      'SECOND_JUDGMENT',
    ])
  })

  it('getCorpusStatus REFUSES rather than reporting manualCount 0 over an unreadable file', async () => {
    await appendJudgment({ text: 'FIRST_JUDGMENT' })
    const file = youCorpusAdditionsFile()

    await chmod(file, 0o000)
    try {
      // A 0 here is what the Persona tab turns into "nothing here yet" — the
      // first-run invitation, shown to an owner whose corpus is full.
      await expect(getCorpusStatus()).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    expect((await getCorpusStatus()).manualCount).toBe(1)
  })

  // The worst instance of the same bug: assembly does not just MISREPORT the
  // judgments, it writes a corpus without them — silently deleting the persona
  // from the one file the overseer reads before it judges on the owner's behalf.
  it('assembly REFUSES rather than rewriting the corpus with the judgments dropped', async () => {
    await appendJudgment({ text: 'FIRST_JUDGMENT' })
    await appendJudgment({ text: 'SECOND_JUDGMENT' })
    const corpus = youCorpusFile()
    const before = await readFile(corpus, 'utf8')
    expect(before).toContain('FIRST_JUDGMENT')
    expect(before).toContain('SECOND_JUDGMENT')

    // Mechanical sources still resolve, so the empty-assembly fail-safe does NOT
    // fire — this path has to refuse on its own.
    await chmod(youCorpusAdditionsFile(), 0o000)
    try {
      await expect(assembleYouCorpus()).rejects.toThrow()
    } finally {
      await chmod(youCorpusAdditionsFile(), 0o600)
    }
    // The load-bearing assertion: byte-identical. Not "still has a manual
    // section", not "still non-empty" — unchanged.
    expect(await readFile(corpus, 'utf8')).toBe(before)
  })

  it('the empty-assembly fail-safe REFUSES rather than overwriting an unreadable corpus', async () => {
    await assembleYouCorpus()
    const file = youCorpusFile()
    const before = await readFile(file, 'utf8')
    expect(before).toContain('CONCEPT_BODY_MARKER')

    // Sources stop resolving AND the existing corpus cannot be read — the exact
    // pairing that used to slip past the guard (unreadable → "no corpus yet" →
    // first write is fine → a populated corpus replaced by an empty assembly,
    // with no `skipped` flag to warn anyone).
    process.env.OPENGROUND_MEMORY_DIR = join(tmpdir(), 'og-unreadable-no-mem')
    process.env.OPENGROUND_CONCEPT_PATH = join(tmpdir(), 'og-unreadable-no-concept.md')
    await chmod(file, 0o000)
    try {
      await expect(assembleYouCorpus()).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})

// ─── Multi-line judgments stay inside their own bullet ───────────────────────
// The Persona tab writes these through a textarea, so newlines are ordinary
// input. Rendered naively, a 2nd line at column 0 ends the list item — and one
// beginning "## " or "- " then reads as a real corpus heading / a separate
// judgment. Because manual judgments render NEWEST FIRST, a single such note
// would re-parent every older entry beneath it.
describe('renderManual: multi-line text cannot break out of its entry', () => {
  const corpusManualSection = async (): Promise<string> => {
    const text = await readFile(youCorpusFile(), 'utf8')
    return text.slice(text.indexOf('## 4.'))
  }

  it('indents continuation lines so a "## " second line is not a heading', async () => {
    await appendJudgment({ text: 'OLDEST_ENTRY' })
    await appendJudgment({ text: '価格は $8 に固定する。\n## 見出しに見える行\n- **偽エントリ**' })

    const section = await corpusManualSection()
    // Not one line of the note reaches column 0 — every continuation is
    // indented into the bullet it belongs to.
    expect(section).not.toMatch(/^## 見出しに見える行$/m)
    expect(section).not.toMatch(/^- \*\*偽エントリ\*\*$/m)
    expect(section).toMatch(/^ {2}## 見出しに見える行$/m)
    // (the closing "**" of the whole judgment lands on its last line, so match
    // the indented prefix rather than the exact tail)
    expect(section).toMatch(/^ {2}- \*\*偽エントリ/m)
    // The older entry still starts its own bullet — it was not swallowed.
    expect(section).toMatch(/^- \*\*OLDEST_ENTRY\*\*$/m)
    // Exactly two top-level bullets: the two judgments, nothing invented.
    expect(section.match(/^- \*\*/gm)).toHaveLength(2)
  })

  it('indents a multi-line context (the correction path) the same way', async () => {
    await appendJudgment({
      text: 'CORRECTED_CALL',
      context: '前の記述の訂正: 一行目\n## 二行目が見出しに見える',
    })
    const section = await corpusManualSection()
    expect(section).not.toMatch(/^## 二行目が見出しに見える$/m)
    expect(section).toMatch(/^ {2}## 二行目が見出しに見える$/m)
  })

  it('leaves an ordinary single-line judgment rendered exactly as before', async () => {
    await appendJudgment({ text: 'PLAIN_ONE_LINER', tags: ['t'] })
    const section = await corpusManualSection()
    expect(section).toMatch(/^- \*\*PLAIN_ONE_LINER\*\*$/m)
  })
})
