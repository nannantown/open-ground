import type { ProjectData } from '@/lib/types'

// The assignee chips are LIST-DRIVEN: the project's registered members
// (project settings → メンバー, shared with the team) plus the user's own
// display name, plus — so the current state is always visible — the card's
// current assignee even when unregistered (legacy data). No derived
// candidates from other cards: names appear because someone registered them,
// not because they happen to be in use, so the list never shifts under you.
// Deduped case-insensitively (first casing wins), trimmed, empties dropped.
export const assigneeCandidates = (
  data: Pick<ProjectData, 'config'>,
  displayName: string | null | undefined,
  currentAssignee?: string | null,
): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | null | undefined) => {
    const name = (raw ?? '').trim()
    if (!name) return
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(name)
  }
  for (const m of data.config?.members ?? []) push(m)
  push(displayName)
  push(currentAssignee)
  return out
}

/** "+ Add" semantics: REGISTER the name into the shared member list (so every
 *  card can use it from now on) AND assign it to the given card — one persist.
 *  Registration is skipped when an equivalent name (case-insensitive) is
 *  already on the list; the existing casing wins. Pure: returns the next
 *  ProjectData. */
export const withRegisteredAssignee = (
  data: ProjectData,
  taskId: string,
  rawName: string,
): ProjectData => {
  const name = rawName.trim()
  if (!name) return data
  const members = data.config?.members ?? []
  const existing = members.find(m => m.trim().toLowerCase() === name.toLowerCase())
  const assignee = existing?.trim() || name
  return {
    ...data,
    config: existing
      ? data.config
      : { ...data.config, members: [...members, name] },
    tasks: data.tasks.map(t => (t.id === taskId ? { ...t, assignee } : t)),
  }
}
