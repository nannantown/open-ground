// engineLogSink — write ONE line into a project's swarm engine log from a module
// the engine itself imports.
//
// Why a sink and not a direct call: the lines that need it come from desk code
// (swarmManager.ts spawns the commander; the orchestrator imports swarmManager),
// so importing the orchestrator back would be a cycle. The orchestrator
// REGISTERS its logLine-by-path here at load; until it has (unit tests that
// never load it), lines fall through to the on-disk journal, which is also where
// the engine's own lines end up — so a line is never simply dropped.
//
// Fire-and-forget and never throws: a log line must not be able to fail a spawn.

import { appendEngineJournalLine } from './engineJournal'
import type { OrchestratorLogLine } from '../types'

export type EngineLogSink = (
  projectPath: string,
  level: OrchestratorLogLine['level'],
  message: string,
) => void | Promise<void>

declare global {
  // eslint-disable-next-line no-var
  var __openground_engine_log_sink: EngineLogSink | undefined
}

const journalOnly: EngineLogSink = (projectPath, level, message) =>
  appendEngineJournalLine(projectPath, { at: new Date().toISOString(), level, message })

/** Called once by swarmOrchestrator at module load. Lives on globalThis so a
 *  `tsx watch` re-eval of either module keeps the pairing. */
export const registerEngineLogSink = (sink: EngineLogSink): void => {
  globalThis.__openground_engine_log_sink = sink
}

export const logToEngine = (
  projectPath: string,
  level: OrchestratorLogLine['level'],
  message: string,
): void => {
  try {
    const r = (globalThis.__openground_engine_log_sink ?? journalOnly)(projectPath, level, message)
    if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {})
  } catch {
    /* a log line must never break its caller */
  }
}
