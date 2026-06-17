import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock the PTY layer so createGlobalSkill never spawns a real `claude`. The
// pure functions (prompt / marker extraction) don't touch these. `nextChunk`
// is what the (mocked) subscription emits to the consumer once it wires up —
// set it per-test BEFORE calling createGlobalSkill.
const launchClaude = vi.fn((_opts?: unknown) => ({ terminalId: 't1' }))
const unsubscribe = vi.fn()
const killTerminal = vi.fn()
let nextChunk: string | null = null
vi.mock('./claudeTerminal', () => ({ launchClaude: (o: unknown) => launchClaude(o as never) }))
vi.mock('./terminal', () => ({
  subscribeTerminal: (_id: string, onChunk: (c: string) => void) => {
    if (nextChunk != null) {
      const c = nextChunk
      queueMicrotask(() => onChunk(c))
    }
    return { info: { finishedAt: null }, unsubscribe }
  },
  killTerminal: () => killTerminal(),
}))

import {
  buildCreateSkillPrompt,
  extractSkillName,
  createGlobalSkill,
  SkillCreationBusyError,
  SKILL_NAME_MARKER,
  SKILL_END,
} from './generateSkill'

describe('extractSkillName (PTY stream)', () => {
  const wrap = (name: string) => `${SKILL_NAME_MARKER} ${name} ${SKILL_END}`

  it('pulls a valid kebab name between marker and end token', () => {
    expect(extractSkillName(`noise\n${wrap('pdf-export')}`)).toBe('pdf-export')
  })

  it('requires the end token — a bare marker is mid-stream', () => {
    expect(extractSkillName(`${SKILL_NAME_MARKER} pdf-export`)).toBeNull()
  })

  it("rejects the prompt's echoed placeholder (contains '<')", () => {
    expect(extractSkillName(wrap('<name>'))).toBeNull()
  })

  it('rejects an unsafe name (spaces, slashes, traversal)', () => {
    expect(extractSkillName(wrap('../evil'))).toBeNull()
    expect(extractSkillName(wrap('a b'))).toBeNull()
    expect(extractSkillName(wrap('a/b'))).toBeNull()
  })

  it('takes the LAST marker when the TUI repaints', () => {
    expect(extractSkillName(`${wrap('stale-name')}\n${wrap('final-name')}`)).toBe('final-name')
  })

  it('strips ANSI styling around the name', () => {
    expect(extractSkillName(`${SKILL_NAME_MARKER} \x1b[1mmy-skill\x1b[0m ${SKILL_END}`)).toBe(
      'my-skill',
    )
  })
})

describe('buildCreateSkillPrompt', () => {
  it('embeds the request and the marker/frontmatter contract', () => {
    const p = buildCreateSkillPrompt('a skill that exports PDFs')
    expect(p).toContain('a skill that exports PDFs')
    expect(p).toContain(SKILL_NAME_MARKER)
    expect(p).toContain(SKILL_END)
    expect(p).toContain('SKILL.md')
    expect(p).toMatch(/frontmatter/i)
    expect(p).toContain('.openground/')
  })
})

describe('createGlobalSkill (orchestration, mocked PTY)', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'og-createskill-'))
    nextChunk = null
    launchClaude.mockClear()
    killTerminal.mockClear()
    unsubscribe.mockClear()
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('returns the created skill once the marker lands and the file exists', async () => {
    // Simulate claude having written the skill, then have the PTY emit the marker.
    const dir = join(home, '.claude', 'skills', 'pdf-export')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: PDF Export\ndescription: Make PDFs\n---\nbody')
    nextChunk = `${SKILL_NAME_MARKER} pdf-export ${SKILL_END}\n`

    const skill = await createGlobalSkill('a skill that exports PDFs', { home })
    expect(skill).toEqual({
      id: 'pdf-export',
      name: 'PDF Export',
      description: 'Make PDFs',
      file: '~/.claude/skills/pdf-export/SKILL.md',
    })
    expect(launchClaude).toHaveBeenCalledTimes(1)
    expect(killTerminal).toHaveBeenCalledTimes(1) // PTY always torn down
  })

  it('rejects an empty request without spawning claude', async () => {
    await expect(createGlobalSkill('   ', { home })).rejects.toThrow(/required/)
    expect(launchClaude).not.toHaveBeenCalled()
  })

  it('fails if the marker never lands (short timeout)', async () => {
    await expect(createGlobalSkill('something', { home, timeoutMs: 1 })).rejects.toThrow(
      /could not create/,
    )
    expect(killTerminal).toHaveBeenCalledTimes(1)
  })

  it('refuses a concurrent creation (single-flight)', async () => {
    nextChunk = null // the first run never gets a marker, so it stays in flight
    const first = createGlobalSkill('one', { home, timeoutMs: 300 })
    // A second request while the first is still running is rejected as busy.
    await expect(createGlobalSkill('two', { home })).rejects.toBeInstanceOf(
      SkillCreationBusyError,
    )
    await expect(first).rejects.toThrow(/could not create/)
    // Only ONE PTY was ever launched (the busy second short-circuited before spawn).
    expect(launchClaude).toHaveBeenCalledTimes(1)
  })
})
