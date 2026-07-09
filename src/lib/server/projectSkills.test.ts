import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'fs/promises'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { listGlobalSkills, listProjectSkills, parseSkillFrontmatter } from './projectSkills'

// Pure scanner over <project>/.claude/skills/*/SKILL.md — no HOME/registry, just
// a throwaway project dir per test.

describe('parseSkillFrontmatter', () => {
  it('reads bare name + description scalars', () => {
    expect(
      parseSkillFrontmatter('---\nname: commit-helper\ndescription: Write commits\n---\nbody'),
    ).toEqual({ name: 'commit-helper', description: 'Write commits' })
  })

  it('strips matching single/double quotes', () => {
    expect(parseSkillFrontmatter('---\nname: "My Skill"\ndescription: \'does X\'\n---')).toEqual({
      name: 'My Skill',
      description: 'does X',
    })
  })

  it('folds a `>` block scalar onto one line', () => {
    const raw = '---\nname: s\ndescription: >\n  first line\n  second line\n---\n'
    expect(parseSkillFrontmatter(raw).description).toBe('first line second line')
  })

  it('keeps newlines for a `|` block scalar', () => {
    const raw = '---\ndescription: |\n  line one\n  line two\nname: s\n---\n'
    expect(parseSkillFrontmatter(raw).description).toBe('line one\nline two')
  })

  it('folds an empty-inline value wrapped onto indented lines (real Anthropic shape)', () => {
    // `description:` with nothing after the colon, the quoted text wrapping onto
    // the following indented lines — as official plugin skills (math-olympiad) do.
    const raw =
      '---\nname: math-olympiad\ndescription:\n  "Solve competition math problems with adversarial\n  verification and rigor."\n---\n'
    const fm = parseSkillFrontmatter(raw)
    expect(fm.name).toBe('math-olympiad')
    expect(fm.description).toBe(
      'Solve competition math problems with adversarial verification and rigor.',
    )
  })

  it('returns {} when there is no frontmatter', () => {
    expect(parseSkillFrontmatter('# Just a heading\nname: nope')).toEqual({})
  })

  it('ignores indented (nested) keys — only top-level name/description', () => {
    const raw = '---\nmeta:\n  name: nested\ndescription: real\n---'
    const fm = parseSkillFrontmatter(raw)
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBe('real')
  })
})

describe('listProjectSkills', () => {
  let proj: string
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), 'og-skills-'))
  })
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true })
  })

  const writeSkill = async (name: string, contents: string) => {
    const dir = join(proj, '.claude', 'skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), contents)
  }

  it('returns [] when the project has no .claude/skills dir', async () => {
    expect(await listProjectSkills(proj)).toEqual([])
  })

  it('lists skills with frontmatter name/description and the relative file path', async () => {
    await writeSkill('pr-writer', '---\nname: PR Writer\ndescription: Draft a PR\n---\nbody')
    const skills = await listProjectSkills(proj)
    expect(skills).toEqual([
      {
        id: 'pr-writer',
        name: 'PR Writer',
        description: 'Draft a PR',
        file: '.claude/skills/pr-writer/SKILL.md',
      },
    ])
  })

  it('falls back to the directory name when frontmatter has no name', async () => {
    await writeSkill('lint-fixer', '---\ndescription: fixes lint\n---')
    const [s] = await listProjectSkills(proj)
    expect(s.name).toBe('lint-fixer')
    expect(s.description).toBe('fixes lint')
  })

  it('description is "" when absent', async () => {
    await writeSkill('bare', '---\nname: Bare\n---')
    const [s] = await listProjectSkills(proj)
    expect(s.description).toBe('')
  })

  it('skips directories without a SKILL.md, dotfiles, and non-skill files', async () => {
    await writeSkill('real', '---\nname: Real\n---')
    // a dir with no SKILL.md
    await mkdir(join(proj, '.claude', 'skills', 'empty-dir'), { recursive: true })
    // a dotfile dir
    await mkdir(join(proj, '.claude', 'skills', '.hidden'), { recursive: true })
    await writeFile(join(proj, '.claude', 'skills', '.hidden', 'SKILL.md'), '---\nname: H\n---')
    // a stray file (not a dir)
    await writeFile(join(proj, '.claude', 'skills', 'README.md'), 'hi')
    const skills = await listProjectSkills(proj)
    expect(skills.map((s) => s.id)).toEqual(['real'])
  })

  it('sorts by display name', async () => {
    await writeSkill('z-dir', '---\nname: Alpha\n---')
    await writeSkill('a-dir', '---\nname: Zulu\n---')
    expect((await listProjectSkills(proj)).map((s) => s.name)).toEqual(['Alpha', 'Zulu'])
  })

  it('skips a SKILL.md that symlinks OUTSIDE the project (no content leak)', async () => {
    // A secret file living entirely outside the project tree.
    const outside = await mkdtemp(join(tmpdir(), 'og-outside-'))
    try {
      await writeFile(
        join(outside, 'secret.md'),
        '---\nname: STOLEN\ndescription: private key\n---',
      )
      // A skill whose SKILL.md is a symlink to that out-of-project secret.
      const evil = join(proj, '.claude', 'skills', 'evil')
      await mkdir(evil, { recursive: true })
      await symlink(join(outside, 'secret.md'), join(evil, 'SKILL.md'))
      // …plus a legit in-repo skill.
      await writeSkill('good', '---\nname: Good\n---')

      const skills = await listProjectSkills(proj)
      // The symlinked-out skill is refused; only the legit one is returned.
      expect(skills.map((s) => s.id)).toEqual(['good'])
      expect(skills.some((s) => s.name === 'STOLEN')).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('skips a non-regular SKILL.md (a directory in its place)', async () => {
    // SKILL.md is a directory, not a file → the isFile() guard skips it.
    await mkdir(join(proj, '.claude', 'skills', 'weird', 'SKILL.md'), { recursive: true })
    await writeSkill('good', '---\nname: Good\n---')
    expect((await listProjectSkills(proj)).map((s) => s.id)).toEqual(['good'])
  })

  it('lists a skill whose DIRECTORY is a symlink to elsewhere in the project', async () => {
    // The skill dir itself is a symlink (Dirent.isDirectory()=false) pointing
    // inside the project → containment holds, the skill must be listed.
    const realDir = join(proj, 'shared-skills', 'linked')
    await mkdir(realDir, { recursive: true })
    await writeFile(join(realDir, 'SKILL.md'), '---\nname: Linked Dir\n---')
    await mkdir(join(proj, '.claude', 'skills'), { recursive: true })
    await symlink(realDir, join(proj, '.claude', 'skills', 'linked'))
    expect((await listProjectSkills(proj)).map((s) => s.name)).toEqual(['Linked Dir'])
  })

  it('still refuses a skill DIRECTORY symlinked OUTSIDE the project', async () => {
    // Loosening the readdir filter must NOT loosen containment: a whole-dir
    // symlink escaping the project resolves outside and is refused.
    const outside = await mkdtemp(join(tmpdir(), 'og-outside-'))
    try {
      await writeFile(join(outside, 'SKILL.md'), '---\nname: STOLEN\n---')
      await mkdir(join(proj, '.claude', 'skills'), { recursive: true })
      await symlink(outside, join(proj, '.claude', 'skills', 'evil-dir'))
      await writeSkill('good', '---\nname: Good\n---')
      const skills = await listProjectSkills(proj)
      expect(skills.map((s) => s.id)).toEqual(['good'])
      expect(skills.some((s) => s.name === 'STOLEN')).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('skips symlinks to a file and dangling symlinks without breaking the scan', async () => {
    const skillsDir = join(proj, '.claude', 'skills')
    await mkdir(skillsDir, { recursive: true })
    // symlink to a regular file → <link>/SKILL.md can't resolve → skipped
    await writeFile(join(proj, 'notes.md'), 'hi')
    await symlink(join(proj, 'notes.md'), join(skillsDir, 'file-link'))
    // dangling symlink → realpath fails → skipped
    await symlink(join(proj, 'no-such-target'), join(skillsDir, 'dangling'))
    await writeSkill('good', '---\nname: Good\n---')
    expect((await listProjectSkills(proj)).map((s) => s.id)).toEqual(['good'])
  })

  it('skips a FIFO SKILL.md without hanging (threadpool-DoS guard)', async () => {
    const dir = join(proj, '.claude', 'skills', 'pipe')
    await mkdir(dir, { recursive: true })
    try {
      execFileSync('mkfifo', [join(dir, 'SKILL.md')])
    } catch {
      return // mkfifo unavailable on this host — skip (the dir-case test covers the guard)
    }
    await writeSkill('good', '---\nname: Good\n---')
    // Must resolve promptly: the isFile() guard skips the FIFO BEFORE readFile,
    // which on a writer-less pipe would block forever. (A regression here surfaces
    // as a test-timeout, not a silent pass.)
    const skills = await listProjectSkills(proj)
    expect(skills.map((s) => s.id)).toEqual(['good'])
  })
})

describe('listGlobalSkills', () => {
  // The OG user's OWN ~/.claude/skills — `home` is injected so the test never
  // touches the real home directory (the suite isolates OPENGROUND_HOME but NOT
  // os.homedir()).
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'og-global-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const writeGlobalSkill = async (name: string, contents: string) => {
    const dir = join(home, '.claude', 'skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), contents)
  }

  it('returns [] when ~/.claude/skills is absent', async () => {
    expect(await listGlobalSkills(home)).toEqual([])
  })

  it('lists global skills with a ~/.claude/skills file label', async () => {
    await writeGlobalSkill('committer', '---\nname: Committer\ndescription: commits\n---')
    expect(await listGlobalSkills(home)).toEqual([
      {
        id: 'committer',
        name: 'Committer',
        description: 'commits',
        file: '~/.claude/skills/committer/SKILL.md',
      },
    ])
  })

  it("follows a symlinked SKILL.md (dotfiles) — no containment guard for the user's own home", async () => {
    // Users legitimately symlink global skills in from a dotfiles repo. Unlike
    // project skills, global has NO containment guard, so the target is read.
    const store = await mkdtemp(join(tmpdir(), 'og-dotfiles-'))
    try {
      await writeFile(join(store, 'real.md'), '---\nname: Dotfile Skill\n---')
      const dir = join(home, '.claude', 'skills', 'linked')
      await mkdir(dir, { recursive: true })
      await symlink(join(store, 'real.md'), join(dir, 'SKILL.md'))
      expect((await listGlobalSkills(home)).map((s) => s.name)).toEqual(['Dotfile Skill'])
    } finally {
      await rm(store, { recursive: true, force: true })
    }
  })

  it('lists a skill whose whole DIRECTORY is a symlink from a dotfiles repo', async () => {
    // Audit 856daefb repro: ln -s ~/dotfiles/claude-skills/myskill
    // ~/.claude/skills/myskill. The Dirent for the symlink has
    // isDirectory()=false, so an isDirectory()-only filter dropped it and only
    // the real dir survived. Both must be listed.
    const store = await mkdtemp(join(tmpdir(), 'og-dotfiles-'))
    try {
      const realDir = join(store, 'claude-skills', 'linkedskill')
      await mkdir(realDir, { recursive: true })
      await writeFile(join(realDir, 'SKILL.md'), '---\nname: Linked Skill\ndescription: via dotfiles\n---')
      await mkdir(join(home, '.claude', 'skills'), { recursive: true })
      await symlink(realDir, join(home, '.claude', 'skills', 'linkedskill'))
      await writeGlobalSkill('realskill', '---\nname: Real Skill\n---')

      const skills = await listGlobalSkills(home)
      expect(skills.map((s) => s.id).sort()).toEqual(['linkedskill', 'realskill'])
      const linked = skills.find((s) => s.id === 'linkedskill')
      expect(linked?.name).toBe('Linked Skill')
      expect(linked?.file).toBe('~/.claude/skills/linkedskill/SKILL.md')
    } finally {
      await rm(store, { recursive: true, force: true })
    }
  })

  it('still skips a non-regular (directory) SKILL.md', async () => {
    await mkdir(join(home, '.claude', 'skills', 'weird', 'SKILL.md'), { recursive: true })
    await writeGlobalSkill('good', '---\nname: Good\n---')
    expect((await listGlobalSkills(home)).map((s) => s.id)).toEqual(['good'])
  })
})
