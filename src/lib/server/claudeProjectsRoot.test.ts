import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { claudeProjectsRoot } from './transcript'

// Tests used to derive Claude transcript paths from the real home and leave one
// folder per run under ~/.claude/projects (about 1,900 by 2026-11-28). The test
// setup points CLAUDE_CONFIG_DIR into the test home, and every reader resolves
// the folder through claudeProjectsRoot().
describe('Claude transcript folder', () => {
  it('is never the real ~/.claude/projects while tests run', () => {
    // userInfo() reads the account database, not $HOME, so this is the real home.
    const realRoot = join(userInfo().homedir, '.claude')
    expect(claudeProjectsRoot().startsWith(realRoot)).toBe(false)
    expect(claudeProjectsRoot().startsWith(process.env.OPENGROUND_HOME ?? '\0')).toBe(true)
  })

  it('is built in one place only (transcript.ts)', () => {
    const root = join(__dirname, '..', '..', '..')
    const offenders: string[] = []
    for (const dir of ['src/lib/server', 'server', 'server/routes']) {
      for (const name of readdirSync(join(root, dir))) {
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || name === 'transcript.ts') continue
        const text = readFileSync(join(root, dir, name), 'utf8')
        if (/['"]\.claude['"]\s*,\s*['"]projects['"]/.test(text)) offenders.push(relative(root, join(root, dir, name)))
      }
    }
    expect(offenders).toEqual([])
  })
})
