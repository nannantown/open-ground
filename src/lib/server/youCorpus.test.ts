import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  encodeClaudeProjectKey,
  assembleYouCorpus,
  appendJudgment,
  readYouCorpus,
  readManualJudgments,
  getCorpusStatus,
} from './youCorpus'
import { youCorpusFile, youCorpusAdditionsFile } from './paths'

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
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('encodeClaudeProjectKey', () => {
  it('replaces every non-alphanumeric char with "-" (no run-collapsing)', () => {
    expect(encodeClaudeProjectKey('/Users/kokinaniwa/projects/OPEN GROUND')).toBe(
      '-Users-kokinaniwa-projects-OPEN-GROUND',
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
