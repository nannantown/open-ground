import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'

// A compact (~2-3KB) snapshot of a project that Claude can read at the top of
// its prompt instead of spending its first turns Glob/Grep/Read-ing the repo.
//
// Why this matters: every fresh Claude run starts from zero and burns several
// tool turns just to learn the repo layout. Pre-injecting the same digest at
// the top of every prompt (a) skips that exploration, and (b) makes the prompt
// prefix identical across consecutive runs in the same project, so Anthropic's
// 5-minute prompt cache hits and the digest tokens are effectively free.

interface DigestCacheEntry {
  digest: string
  // Mtime of the signal files we sniff for invalidation. If any of them moves,
  // we rebuild. We don't try to detect every kind of repo change — a stale tree
  // listing for a few extra files is fine; a stale CLAUDE.md is not.
  signature: string
}

const cache = new Map<string, DigestCacheEntry>()
const SOFT_TTL_MS = 5 * 60 * 1000
const cacheTimes = new Map<string, number>()

// Hard cap on digest size — past this the prompt cache savings get outweighed
// by per-token cost and the model starts skimming. ~3KB ≈ 700 tokens.
const MAX_DIGEST_CHARS = 3000
const MAX_CLAUDE_MD_CHARS = 1500
const MAX_README_CHARS = 600
const MAX_TREE_ENTRIES = 60

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache',
  '.openground', '.hove', '.pmmap', '_archive', '.turbo', 'coverage', '.venv', 'venv',
  '__pycache__', 'target', '.idea', '.vscode',
])

const tryRead = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

const tryStat = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

const truncate = (s: string, n: number): string => {
  const trimmed = s.trim()
  if (trimmed.length <= n) return trimmed
  return trimmed.slice(0, n).trimEnd() + '\n…(truncated)'
}

const summarizePackageJson = (raw: string): string => {
  try {
    const pkg = JSON.parse(raw)
    const lines: string[] = []
    if (pkg.name) lines.push(`name: ${pkg.name}`)
    if (pkg.description) lines.push(`description: ${pkg.description}`)
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      const scripts = Object.keys(pkg.scripts).slice(0, 10)
      if (scripts.length) lines.push(`scripts: ${scripts.join(', ')}`)
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    if (deps.length) lines.push(`deps (${deps.length}): ${deps.slice(0, 12).join(', ')}${deps.length > 12 ? '…' : ''}`)
    const devDeps = Object.keys(pkg.devDependencies ?? {})
    if (devDeps.length) lines.push(`devDeps (${devDeps.length}): ${devDeps.slice(0, 8).join(', ')}${devDeps.length > 8 ? '…' : ''}`)
    return lines.join('\n')
  } catch {
    return ''
  }
}

const listDir = async (path: string): Promise<string[]> => {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter(e => !e.name.startsWith('.') || e.name === '.github')
      .filter(e => !IGNORE_DIRS.has(e.name))
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
  } catch {
    return []
  }
}

// Build a shallow tree: project root + one level into the most-likely source
// directories. Enough for Claude to know "where things live" without dumping
// every file.
const buildTree = async (projectPath: string): Promise<string> => {
  const out: string[] = []
  let entryCount = 0

  const topLevel = await listDir(projectPath)
  if (topLevel.length === 0) return ''
  out.push('.')
  for (const name of topLevel) {
    if (entryCount++ >= MAX_TREE_ENTRIES) { out.push('  …'); break }
    out.push(`  ${name}`)
  }

  // Drill one level into the canonical source roots if present.
  const drillCandidates = ['src', 'app', 'lib', 'packages', 'components']
  for (const candidate of drillCandidates) {
    if (entryCount >= MAX_TREE_ENTRIES) break
    if (!topLevel.includes(`${candidate}/`)) continue
    const children = await listDir(join(projectPath, candidate))
    if (children.length === 0) continue
    out.push(`${candidate}/`)
    for (const name of children) {
      if (entryCount++ >= MAX_TREE_ENTRIES) { out.push('  …'); break }
      out.push(`  ${name}`)
    }
  }
  return out.join('\n')
}

const computeSignature = async (projectPath: string): Promise<string> => {
  const parts = await Promise.all([
    tryStat(join(projectPath, 'CLAUDE.md')),
    tryStat(join(projectPath, 'README.md')),
    tryStat(join(projectPath, 'package.json')),
  ])
  return parts.map(p => String(p ?? '-')).join('|')
}

export const buildRepoDigest = async (projectPath: string): Promise<string> => {
  const now = Date.now()
  const cached = cache.get(projectPath)
  const cachedAt = cacheTimes.get(projectPath) ?? 0
  // Within the soft TTL we trust the cache without re-statting; past it we
  // verify the signature so a CLAUDE.md edit takes effect on the very next run.
  if (cached && now - cachedAt < SOFT_TTL_MS) return cached.digest
  const signature = await computeSignature(projectPath)
  if (cached && cached.signature === signature) {
    cacheTimes.set(projectPath, now)
    return cached.digest
  }

  const [claudeMd, readme, pkgJson, tree] = await Promise.all([
    tryRead(join(projectPath, 'CLAUDE.md')),
    tryRead(join(projectPath, 'README.md')),
    tryRead(join(projectPath, 'package.json')),
    buildTree(projectPath),
  ])

  const sections: string[] = []
  if (claudeMd) sections.push(`## CLAUDE.md\n${truncate(claudeMd, MAX_CLAUDE_MD_CHARS)}`)
  const pkgSummary = pkgJson ? summarizePackageJson(pkgJson) : ''
  if (pkgSummary) sections.push(`## package.json\n${pkgSummary}`)
  if (readme && !claudeMd) {
    sections.push(`## README.md\n${truncate(readme, MAX_README_CHARS)}`)
  }
  if (tree) sections.push(`## Layout\n${tree}`)

  if (sections.length === 0) {
    cache.set(projectPath, { digest: '', signature })
    cacheTimes.set(projectPath, now)
    return ''
  }

  const header = '以下はこのプロジェクトの要約です（OPEN GROUND が自動生成）。最初のツール呼び出しに頼らず、まずこれを読んで判断してください。'
  const full = `${header}\n\n${sections.join('\n\n')}`
  const digest = truncate(full, MAX_DIGEST_CHARS)
  cache.set(projectPath, { digest, signature })
  cacheTimes.set(projectPath, now)
  return digest
}

// Exposed for tests / a future "regenerate digest" button.
export const invalidateRepoDigest = (projectPath?: string) => {
  if (projectPath) {
    cache.delete(projectPath)
    cacheTimes.delete(projectPath)
  } else {
    cache.clear()
    cacheTimes.clear()
  }
}
