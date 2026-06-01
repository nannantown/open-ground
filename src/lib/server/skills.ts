import { readFile, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { SkillInfo } from '../types'

// Claude Code stores skills as either a folder with a SKILL.md inside, or as
// a flat `<name>.md` file (legacy layout). Both forms carry a YAML
// frontmatter block with a `description` we surface to the picker.
const SKILL_FILE = 'SKILL.md'

// Lift the `description:` value out of the frontmatter. Handles three shapes:
//   description: one-liner
//   description: "quoted one-liner"
//   description: |
//     multi-line
//     block
// We only need the first non-empty line — the picker shows it as a tooltip,
// so a one-liner is plenty.
const parseDescription = (md: string): string => {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return ''
  const fm = m[1]
  const single = fm.match(/^description:\s*(.+)$/m)
  if (single) {
    return single[1].trim().replace(/^["'`]|["'`]$/g, '').trim()
  }
  const block = fm.match(/^description:\s*\|\s*\n([\s\S]*?)(?:\n[a-zA-Z_][\w-]*:|$)/m)
  if (block) {
    const lines = block[1].split('\n')
    for (const ln of lines) {
      const t = ln.trim()
      if (t) return t
    }
  }
  return ''
}

const fileExists = async (p: string) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const readSkillAt = async (dirOrFile: string, name: string): Promise<string | null> => {
  // Either `<dirOrFile>/<name>/SKILL.md` or `<dirOrFile>/<name>.md`.
  const folderForm = join(dirOrFile, name, SKILL_FILE)
  if (await fileExists(folderForm)) {
    try {
      return await readFile(folderForm, 'utf8')
    } catch {
      return null
    }
  }
  return null
}

const scanDir = async (dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> => {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const full = join(dir, entry)
    let info: { name: string; md: string } | null = null
    try {
      const s = await stat(full)
      if (s.isDirectory()) {
        const md = await readSkillAt(dir, entry)
        if (md) info = { name: entry, md }
      } else if (s.isFile() && entry.endsWith('.md') && entry !== 'README.md') {
        const name = entry.slice(0, -3)
        try {
          info = { name, md: await readFile(full, 'utf8') }
        } catch {}
      }
    } catch {
      continue
    }
    if (!info) continue
    out.push({
      name: info.name,
      description: parseDescription(info.md),
      source,
    })
  }
  return out
}

// Walk every installed plugin's `skills/` folder so plugin-shipped skills
// (e.g. `frontend-design@claude-plugins-official`) show in the picker too.
// Reads `installed_plugins.json` for the authoritative install paths — that's
// what Claude Code itself loads from, so we never list a skill the runtime
// can't actually load.
const scanPluginSkills = async (): Promise<SkillInfo[]> => {
  const indexPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
  let raw: string
  try {
    raw = await readFile(indexPath, 'utf8')
  } catch {
    return []
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const plugins = parsed?.plugins
  if (!plugins || typeof plugins !== 'object') return []
  const out: SkillInfo[] = []
  for (const entries of Object.values(plugins) as any[]) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const installPath: unknown = entry?.installPath
      if (typeof installPath !== 'string' || !installPath) continue
      // Plugins keep skills at either `<install>/skills/<name>/SKILL.md` or
      // `<install>/<anything>/skills/<name>/SKILL.md`. Check the direct path
      // first; that covers the common case without an extra readdir.
      const direct = join(installPath, 'skills')
      let found = await scanDir(direct, 'user')
      if (found.length === 0) {
        // Some plugins nest a version segment (`.../<version>/skills/<name>`),
        // which already collapses into installPath here, so this is rare —
        // but readdir the install root to be safe.
        try {
          const subs = await readdir(installPath)
          for (const sub of subs) {
            if (sub.startsWith('.')) continue
            const nested = join(installPath, sub, 'skills')
            const more = await scanDir(nested, 'user')
            if (more.length) found = found.concat(more)
          }
        } catch {}
      }
      out.push(...found)
    }
  }
  return out
}

// Curated UI/UX design skill allowlist for the Canvas picker.
//
// Earlier iterations tried keyword/heuristic matching against every skill on
// disk and kept letting unrelated ones through (anything with `ui` buried in
// `guide` / `require` / etc.). We now intentionally pick the skills the user
// sees — a hand-picked roster of trending / well-known design tones. To add
// or remove a skill from the picker, edit this list.
//
// Each entry must correspond to a SKILL.md actually present in one of the
// scanned scopes (~/.claude/skills, plugins, project). Names not found on
// disk are silently dropped so the picker can't offer a broken option.
// Curated metadata for the Canvas picker. The picker uses the raw skill
// name as the card title and shows `blurb` as the one-line explainer below
// (editorial copy, not the long English frontmatter). Order here drives
// display order.
interface CuratedSkill {
  name: string
  blurb: string
}

const CURATED_DESIGN_SKILLS: CuratedSkill[] = [
  {
    name: 'frontend-design',
    blurb: 'Anthropic 公式。汎用 UI 生成のベースライン、何にでも合う安定品質。',
  },
  {
    name: 'ui-ux-pro-max',
    blurb: '50+ スタイル・161 パレット・99 UX ルールから検索して提案。迷ったらこれ。',
  },
  {
    name: 'design-taste-frontend',
    blurb: 'シニア UI/UX エンジニア級の構造重視。メトリックに沿った緻密な実装。',
  },
  {
    name: 'high-end-visual-design',
    blurb: 'Awwwards 系。エージェンシー風の濃密でリッチな作り込み。',
  },
  {
    name: 'minimalist-ui',
    blurb: 'モノクロ・余白主導。フラット bento と読み物寄りのタイポ。',
  },
  {
    name: 'industrial-brutalist-ui',
    blurb: 'スイス × 軍事ターミナル。剛直なグリッドと粗いテクスチャ。',
  },
]

// Both scopes the Canvas picker shows. User-scope wins on name collision so a
// project-local override is visible (and labelled) but the user's canonical
// install isn't duplicated under it.
//
// `category: 'design'` runs everything through the design keyword sieve —
// what the Canvas picker asks for. Omit it to get the unfiltered list (kept
// for any future surface that wants everything).
export const listSkills = async (
  projectPath?: string,
  options?: { category?: 'design' | 'all' },
): Promise<SkillInfo[]> => {
  const userDir = join(homedir(), '.claude', 'skills')
  const [userSkills, pluginSkills] = await Promise.all([
    scanDir(userDir, 'user'),
    scanPluginSkills(),
  ])
  let projectSkills: SkillInfo[] = []
  if (projectPath) {
    projectSkills = await scanDir(join(projectPath, '.claude', 'skills'), 'project')
  }
  const seen = new Set<string>()
  const merged: SkillInfo[] = []
  // Order: user-scope → plugin-scope → project-scope. First write wins on
  // a name collision so user-installed canon never gets shadowed.
  for (const s of [...userSkills, ...pluginSkills, ...projectSkills]) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    merged.push(s)
  }
  const category = options?.category ?? 'all'
  if (category !== 'design') {
    merged.sort((a, b) => a.name.localeCompare(b.name))
    return merged
  }
  // Curated mode: return only the allowlisted skills, in their declared
  // order, with editorial label/blurb overriding the on-disk frontmatter.
  // A skill not on disk is silently dropped so the picker can't offer a
  // broken option.
  const byName = new Map(merged.map((s) => [s.name, s] as const))
  const ordered: SkillInfo[] = []
  for (const curated of CURATED_DESIGN_SKILLS) {
    const hit = byName.get(curated.name)
    if (!hit) continue
    ordered.push({
      ...hit,
      description: curated.blurb,
    })
  }
  return ordered
}
