// The desk-pool import boundary's exemption lists.
//
// Extracted from .eslintrc.cjs because ESLint v8 rejects ANY unknown top-level
// property on the exported config — including a test seam — so the lists cannot
// live there and be readable by a test at the same time. Both `.eslintrc.cjs`
// (which enforces them) and `swarmImportBoundary.test.ts` (which pins that the
// debt list only shrinks) require this file.
//
// The rule these serve, and why it exists, is documented at the top of
// .eslintrc.cjs. Read that before adding an entry here.

// ── the exemptions, in three kinds ──────────────────────────────────────────

/** THE SEAMS AND THE POOLS THEMSELVES. These files ARE the answer; they must
 *  see both sides (or they are the side). Nothing here is debt. */
const SEAMS = [
  'src/lib/server/terminal.ts', //        the node-pty pool itself
  'src/lib/server/sdkSession.ts', //      the Agent SDK pool itself
  'src/lib/server/workerRuntime.ts', //   pty⇔sdk dispatcher — workerKey / runtimeOf
  'src/lib/server/liveDesks.ts', //       "who is alive / where", both pools, once
  'server/routes/terminal.ts', //         the PTY pool's own REST surface
  'server/routes/sdkSession.ts', //       the SDK pool's own REST surface
]

/** ONE RUNTIME BY CONSTRUCTION — not a worker-addressing decision at all. Each
 *  of these operates a PTY it created itself, or a surface that has no SDK
 *  counterpart. They stay banned from the OTHER pool, so the day one of them
 *  starts asking about SDK desks it lands here for a decision. */
const PTY_BY_DESIGN = [
  'src/lib/server/claudeTerminal.ts', //      launchClaude — the PTY spawner
  'src/lib/server/generateDescription.ts', // one-off PTY + transcript scrape
  'src/lib/server/generateSkill.ts', //       ditto
  'src/lib/server/generateTaskTitle.ts', //   ditto
  'src/lib/server/canvasAi.ts', //            one-off PTY for a canvas job
  'src/lib/server/claudeSlash.ts', //         pastes into a PTY the caller names
  'src/lib/server/boundaryClear.ts', //       writes /clear into a PTY by id
  'src/lib/server/sessionContext.ts', //      reads PTY transcripts for context
  'src/lib/server/ownerDeskLimit.ts', //      watches the OWNER's own PTY desk
  'src/lib/server/swarmEnvPreflight.ts', //   probes a throwaway PTY before launch
  'src/lib/server/swarmJanitor.ts', //        sweeps the PTY pool's own leftovers
  'src/lib/server/swarmOverseerBrain.ts', //  reads a PTY screen for the brain pass
  'src/lib/server/personaChat.ts', //         one-off PTY per persona turn, marker-scraped
  //                                          (it spawns the desk it reads; there is no
  //                                          worker here to address on either runtime)
  'src/lib/server/researchKnowledge.ts', //   one-off PTY per digest/ask, marker-scraped
  //                                          (same shape as personaChat: it subscribes to
  //                                          and kills ONLY the terminal it just launched)
  'src/lib/server/swarmSupply.ts', //        the supply desk is PTY-ONLY BY DESIGN
  //                                          (Remote Control lives on the PTY runtime;
  //                                          stopSwarmSupplyDesks kills by desk label)
  'server/routes/customModules.ts', //        custom tabs are PTY panes by design
  'server/routes/sse.ts', //                  the PTY output stream
  'server/index.ts', //                       starts/stops the PTY sweep loop
]

/** DEBT. These reach BOTH pools directly today. Every one is a place where the
 *  seams could be used instead, and every entry removed is a call site that can
 *  no longer regress. THIS LIST MAY ONLY SHRINK — `swarmImportBoundary.test.ts`
 *  pins its length so a new entry cannot be added quietly. */
const BOTH_POOLS_DEBT = [
  'src/lib/server/swarmOrchestrator.ts',
  'src/lib/server/swarmManager.ts',
  'src/lib/server/swarmManagerRuntime.ts',
  'src/lib/server/swarmSessions.ts',
  'src/lib/server/swarmEscalations.ts',
  'src/lib/server/swarmWorkerRegistry.ts',
  'src/lib/server/swarmWorker.ts',
  'src/lib/server/sdkDeskLimit.ts',
]


module.exports = { SEAMS, PTY_BY_DESIGN, BOTH_POOLS_DEBT }
