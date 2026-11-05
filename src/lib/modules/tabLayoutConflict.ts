// Resolving a 409 on the panel's whole-object save without losing the owner's
// tab layout.
//
// The panel's save is CAS-guarded: when the store moved on (the engine /
// president / commander wrote the Board between the 5s poll and the debounced
// save), PUT /api/project answers 409 and the panel adopts the server copy —
// cards and notes stay server-wins (clobbering them is how a shared board got
// wiped, incident 2026-06-10). But the three tab-layout fields — tabOrder,
// customTabs, disabledModules — are personal: no server writer ever sets them,
// so a 409 there is never a real conflict. Adopting the server copy wholesale
// silently undid a just-made reorder (the row snapped back; commander rework
// 2026-11-05). So: a layout field the owner changed since the last save rides
// onto the fresh copy and is written again under the fresh token.
//
// Pure (fetch injected) so it runs against the real Hono app in node tests.

import type { ProjectData } from '@/lib/types'

const LAYOUT_KEYS = ['tabOrder', 'customTabs', 'disabledModules'] as const

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** `fresh` with every layout field the owner changed since `lastSavedJson`
 *  carried over from `draft`, or null when there is nothing to carry. */
export function carryTabLayout(
  draft: ProjectData,
  lastSavedJson: string,
  fresh: ProjectData,
): ProjectData | null {
  let last: Partial<ProjectData> = {}
  try {
    last = lastSavedJson ? (JSON.parse(lastSavedJson) as Partial<ProjectData>) : {}
  } catch {
    last = {}
  }
  let out: ProjectData | null = null
  for (const k of LAYOUT_KEYS) {
    if (same(draft[k], last[k]) || same(draft[k], fresh[k])) continue
    out = { ...(out ?? fresh), [k]: draft[k] }
  }
  return out
}

/** After a 409: read the fresh copy, re-save the owner's layout change on top
 *  of it (one retry under the fresh token) and return what the store now
 *  holds, or null when the fresh read failed. A failed re-save falls back to
 *  the plain fresh copy — the old behaviour, never worse. */
export async function resolveSaveConflict(
  draft: ProjectData,
  lastSavedJson: string,
  io: {
    get: () => Response | null | Promise<Response | null>
    put: (body: ProjectData) => Response | null | Promise<Response | null>
  },
): Promise<ProjectData | null> {
  const fresh = await io.get()
  if (!fresh?.ok) return null
  const d = (await fresh.json()) as ProjectData
  const carried = carryTabLayout(draft, lastSavedJson, d)
  if (!carried) return d
  const res = await io.put(carried)
  if (!res?.ok) return d
  const saved = (await res.json()) as ProjectData
  return { ...carried, updatedAt: saved.updatedAt }
}
