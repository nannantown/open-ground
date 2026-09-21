// Pure SDK worker question detection. Delivery is owned by swarmEscalations.
import { MAX_ESCALATION_QUESTION } from './swarmEscalations'
import {
  sdkRecentOutputHead,
  type WorkerRuntimeKind,
} from './workerRuntime'

// ─── Screen anatomy ──────────────────────────────────────────────────────────
// Lives in @/lib/claudeScreen — one model of a rendered frame, shared with the
// injection-landing check (swarmEscalations) and the owner-desk quota sensor
// (swarmRateLimitText). It used to live here, and the copy that grew in the
// third consumer modelled the input box wrongly; see that module's header.
//
// The SYMBOLS below are re-exported so this module's importers keep working. The
// row CLASSIFICATION behind them is NOT byte-identical to the copy that lived
// here, and saying only "re-exported" invited the reader to assume it was (round 3
// nit). The merge WIDENED it, deliberately: the shared list also recognises the
// `⏵⏵ accept edits on` / `Context left until auto-compact: N%` footers, and its
// usage-meter pattern matches every `You've used N% of …` wording rather than the
// single spelling this module carried. Every added shape is CHROME, so the one
// direction it can move question detection is fewer furniture rows mistaken for an
// utterance — an improvement, but an undeclared one until now.

export { IDLE_FOOTER_RE, readInputBoxText } from '@/lib/claudeScreen'

// ─── Free-text-question detection (the classifyOutput 'question' arm) ─────────

export interface DetectedFreeTextQuestion {
  /** The assistant's question block, whitespace-collapsed to one line. */
  question: string
}

/** Max rows walked upward when reassembling the question's utterance block —
 *  a question is a short ask, not a treatise; a longer block reads as ordinary
 *  output that HAPPENS to end in '?' and is not worth the FP risk. */
const QUESTION_BLOCK_MAX_ROWS = 8

// (detectFreeTextQuestion — the PTY TUI question detector: idle-footer /
// input-box / menu-frame reading over a rendered screen — was DELETED
// 2026-08-13 with the PTY worker runtime. The SDK detector below is the only
// worker question detector; detectWorkerFreeTextQuestion routes a legacy
// 'pty' kind to null.)

// ─── The SDK arm (2026-08-03 — the seam workerRuntime reserved) ──────────────
//
// An SDK worker has no screen, so every condition above that reads TUI
// furniture is unsatisfiable for it — classifyOutput answered 'normal' forever
// and a prose question died unheard (heartbeat `blocked` was the only route to
// the owner). The SDK equivalents are STRONGER, not approximations:
//
//   PTY condition                        SDK equivalent
//   idle footer / no working footer  →   the pool's own status: 'waiting' means
//                                        the turn ENDED after real work evidence
//                                        (sdkSession's promotion rule) — an
//                                        authoritative lookup where the footer
//                                        is an inference from pixels
//   no permission menu               →   menus cannot exist (bypass, no TUI)
//   empty input box                  →   no input box exists; pushSdkInput
//                                        queues a turn regardless, so there is
//                                        no half-typed draft to double-answer
//   last row ends in ?/？            →   same, on the DISTILLED tail — whose
//                                        lines are the worker's actual words,
//                                        with tool/API/compact lines rendered
//                                        under unambiguous markers (workerRuntime)
//
// FALSE-POSITIVE COST IS LOWER HERE (no keystrokes are typed into anyone's
// terminal; a raise is an inbox entry and the question-grace park is 'blocked',
// the human lane) — but the same fail-closed posture is kept: only the exact
// 'waiting' head, only an unmarked utterance line, only a bounded block.

/** A tail line that is the RENDERER's marker, not the worker's words —
 *  `[tool] …` / `[tool ok|error] …` / `API Error…` / `[compacted …]`
 *  (workerRuntime.renderSdkEvent is the single writer of these shapes). */
const SDK_MARKER_LINE_RE = /^(?:\[tool(?:\]| ok\]| error\])|API Error|\[compacted )/

/**
 * Detect "an SDK worker ended its turn on a free-text question". Input is the
 * EXACT string sdkWorkerRuntime.recentOutput returns: the status head line
 * (sdkRecentOutputHead — imported, not re-derived) above the distilled tail.
 * ALL of (fail-closed):
 *  1. the head is precisely the idle one — `[sdk session waiting]`. 'working'
 *     is mid-turn, 'quota-parked' is the rate-limit arm's turf, spawn/exit
 *     states have no one listening for an answer;
 *  2. the tail's last non-empty line is the worker's own words (not a
 *     tool/API/compact marker) and ends in '?' / '？';
 *  3. the reassembled block stays within QUESTION_BLOCK_MAX_ROWS.
 */
export const detectSdkFreeTextQuestion = (
  out: string | null,
): DetectedFreeTextQuestion | null => {
  if (!out) return null
  const nl = out.indexOf('\n')
  const head = nl === -1 ? out : out.slice(0, nl)
  if (head !== sdkRecentOutputHead('waiting')) return null

  const rows = nl === -1 ? [] : out.slice(nl + 1).split('\n')
  let i = rows.length - 1
  while (i >= 0 && !rows[i].trim()) i--
  if (i < 0) return null
  const last = rows[i].trim()
  if (SDK_MARKER_LINE_RE.test(last)) return null
  if (!/[?？]$/.test(last)) return null

  const block: string[] = [last]
  for (let j = i - 1; j >= 0 && block.length < QUESTION_BLOCK_MAX_ROWS; j--) {
    const t = rows[j].trim()
    if (!t || SDK_MARKER_LINE_RE.test(t)) break
    block.unshift(t)
  }
  const question = block.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ESCALATION_QUESTION)
  if (!question) return null
  return { question }
}

/** THE question detector — one call, whatever runtime carries the worker.
 *  This is the seam the two call sites (classifyOutput's 'question' arm and the
 *  monitor's raise) go through. A legacy 'pty' kind yields null: the PTY
 *  detector died with the PTY worker runtime (2026-08-13), and a legacy roster
 *  row's dead terminal has no screen to ask questions on anyway. */
export const detectWorkerFreeTextQuestion = (
  kind: WorkerRuntimeKind,
  out: string | null,
): DetectedFreeTextQuestion | null => (kind === 'sdk' ? detectSdkFreeTextQuestion(out) : null)

// ─── The T1 pipe (C-core's library — NOT self-scheduling; see file header) ────
