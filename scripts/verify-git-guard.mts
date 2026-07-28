// Proves gitRepoGuard is INERT for real repos and BLOCKS non-repos.
// Load-independent (2 git calls), so it stays truthful on a congested machine.
//   npx tsx scripts/verify-git-guard.mts
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProjectBranches } from '../src/lib/server/gitBranches'
import { isGitRepoRoot } from '../src/lib/server/gitRepoGuard'

const repo = process.cwd() // this repo — a REAL git checkout
const nonRepo = await mkdtemp(join(tmpdir(), 'og-guard-probe-'))

const real = await listProjectBranches(repo)
const fake = await listProjectBranches(nonRepo)

console.log('--- guard predicate ---')
console.log(`real repo  isGitRepoRoot=${isGitRepoRoot(repo)}`)
console.log(`non-repo   isGitRepoRoot=${isGitRepoRoot(nonRepo)}`)
console.log('--- production helper THROUGH the guard ---')
console.log(`real repo  branches=${real.branches.length} current=${real.current}`)
console.log(`non-repo   branches=${fake.branches.length} current=${fake.current}`)

const inertForRealRepo = real.branches.length > 0 && real.current !== null
const blocksNonRepo = fake.branches.length === 0 && fake.current === null
console.log('--- verdict ---')
console.log(`guard is INERT for a real repo : ${inertForRealRepo ? 'PASS' : 'FAIL'}`)
console.log(`guard BLOCKS a non-repo        : ${blocksNonRepo ? 'PASS' : 'FAIL'}`)

await rm(nonRepo, { recursive: true, force: true })
process.exit(inertForRealRepo && blocksNonRepo ? 0 : 1)
