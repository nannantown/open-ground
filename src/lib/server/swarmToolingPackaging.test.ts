import { describe, it, expect } from 'vitest'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { SWARM_TOOLING_SOURCE_PATHS } from './swarmToolingInstall'

// electron-builder's `build.files` in package.json is an explicit ALLOWLIST —
// a repo-resident file not listed there is simply absent from the packaged
// .app (dev/tsx runs from the repo checkout, so it "works" there regardless,
// masking the gap until a real dmg build). swarmToolingInstall.ts reads its
// sources through resolveHookSourceRoot(), which in a packaged app resolves to
// Contents/Resources/app — so every path in SWARM_TOOLING_SOURCE_PATHS (and
// the sibling og-manage skill) MUST be listed here, or installSwarmTooling()
// silently no-ops (outcome:'error', logged only) for every fresh install.
describe('swarm tooling packaging inventory', () => {
  it('every SWARM_TOOLING_SOURCE_PATHS entry is listed in package.json build.files', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
    const files: string[] = pkg.build.files
    const missing = SWARM_TOOLING_SOURCE_PATHS.filter((p) => !files.includes(p))
    expect(missing).toEqual([])
  })

  it('the og-manage skill (sibling installer) is also listed — regression guard for the same gap', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
    const files: string[] = pkg.build.files
    expect(files).toContain('skills/og-manage/SKILL.md')
  })
})
