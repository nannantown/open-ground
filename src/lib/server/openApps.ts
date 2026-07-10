import type { OpenApp } from '../types'

// Older saves stored openApps as a plain string[]. Normalise either shape into
// the new {name, path?, mode} object, dropping duplicates and empties.
export const normalizeOpenApps = (raw: unknown): OpenApp[] => {
  if (!Array.isArray(raw)) return []
  const out: OpenApp[] = []
  for (const a of raw) {
    const one = normalizeOne(a)
    if (one && !out.some(x => x.name === one.name)) out.push(one)
  }
  return out
}

const normalizeOne = (a: unknown): OpenApp | null => {
  if (typeof a === 'string') {
    const name = a.trim()
    if (!name || name.length > 80) return null
    return { name, mode: 'open' }
  }
  if (a && typeof a === 'object' && typeof (a as any).name === 'string') {
    const o = a as any
    const name = String(o.name).trim()
    if (!name || name.length > 80) return null
    const out: OpenApp = { name, mode: 'open' }
    if (typeof o.path === 'string' && o.path.trim()) out.path = o.path
    out.mode = o.mode === 'cwd' ? 'cwd' : 'open'
    return out
  }
  return null
}
