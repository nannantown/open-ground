// supplyProgress — the "how is it going" lane of the supply desk (社長), derived
// from the Board alone (owner decision 2026-09-23: 「それの状況が逐一補給官が
// 理解してる感じ」, with 「トークンあんまり使いすぎてもダメ」).
//
// DETERMINISTIC AND FREE. No model reads anything here: the engine pass already
// reads the Board every tick, and a card changing column IS the progress event.
// We diff the columns against the previous pass and turn each move into one
// plain sentence for the desk's progress digest (supplyNotice.queueSupplyProgress),
// which accumulates them until the desk is free — ten moves, one turn.
//
// What becomes what:
//   todo    → doing    「X」に取りかかりました            (progress)
//   doing   → review   「X」ができて、確認中です          (progress)
//   review  → doing    「X」は確認で直しが入り、やり直し中です (progress)
//   doing/review → blocked 「X」が止まって保留になりました (IMPORTANT — something stopped)
// → done is NOT reported here: a landing is a delivery, reported by
// swarmLandedLedger.sweepLanded (important lane, with its own persist gate).
//
// The first pass after a (re)start only records a baseline — a restart must not
// replay the whole Board as news.

import { queueSupplyNotice, queueSupplyProgress } from './supplyNotice'
import type { ProjectTask } from '../types'

type Col = 'todo' | 'doing' | 'review' | 'done' | 'blocked' | string

const columnOf = (t: ProjectTask): Col => t.boardColumn ?? (t.done ? 'done' : 'todo')

declare global {
  // eslint-disable-next-line no-var
  var __openground_supply_progress_cols: Map<string, Map<string, Col>> | undefined
}
const lastCols: Map<string, Map<string, Col>> =
  globalThis.__openground_supply_progress_cols ?? (globalThis.__openground_supply_progress_cols = new Map())

export const resetSupplyProgressState = (): void => lastCols.clear()

const title = (t: ProjectTask): string => {
  const s = (t.title ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 40 ? `${s.slice(0, 40)}…` : s || '(無題のカード)'
}

export interface ProgressEvent {
  kind: 'progress' | 'important'
  text: string
}

/** The progress sentences for one Board transition set. Pure. */
export const progressEvents = (
  prev: ReadonlyMap<string, Col>,
  tasks: readonly ProjectTask[],
): ProgressEvent[] => {
  const out: ProgressEvent[] = []
  for (const t of tasks) {
    const before = prev.get(t.id)
    const now = columnOf(t)
    if (before === undefined || before === now) continue
    const x = `「${title(t)}」`
    if (before === 'todo' && now === 'doing') out.push({ kind: 'progress', text: `${x}に取りかかりました` })
    else if (before === 'doing' && now === 'review') out.push({ kind: 'progress', text: `${x}ができて、確認中です` })
    else if (before === 'review' && now === 'doing') out.push({ kind: 'progress', text: `${x}は確認で直しが入り、やり直し中です` })
    else if ((before === 'doing' || before === 'review') && now === 'blocked') {
      out.push({ kind: 'important', text: `${x}が途中で止まり、保留になりました。` })
    }
  }
  return out
}

/** The engine pass's hook. Never throws. */
export const observeBoardProgress = (projectPath: string, tasks: readonly ProjectTask[]): ProgressEvent[] => {
  try {
    const prev = lastCols.get(projectPath)
    const next = new Map<string, Col>(tasks.map((t) => [t.id, columnOf(t)]))
    lastCols.set(projectPath, next)
    if (!prev) return [] // baseline — never replay the Board as news
    const events = progressEvents(prev, tasks)
    for (const e of events) {
      if (e.kind === 'important') queueSupplyNotice(projectPath, e.text)
      else queueSupplyProgress(projectPath, e.text)
    }
    return events
  } catch {
    return []
  }
}
