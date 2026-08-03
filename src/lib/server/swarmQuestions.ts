// swarmQuestions — C3 of the overseer EPIC (spec: docs/OVERSEER_DESIGN.md §10 C3):
// detect a worker's `claude` sitting IDLE on a FREE-TEXT question (the one
// blocking state the A1 sandbox leaves — permission menus are gone under
// bypass), and the answer pipe that turns that question into a proxy-you
// answer injected back into the worker's PTY.
//
// Two exports matter:
//  • detectFreeTextQuestion — a PURE screen classifier (the 'question' arm of
//    swarmOrchestrator's classifyOutput). Its false-POSITIVE direction is the
//    dangerous one (actively typing into someone's PTY — the inverse of the
//    rate-limit/permission arms, whose FPs merely grant grace), so every
//    condition below is AND-ed and any uncertainty yields null (fail-closed).
//  • handleWorkerQuestion — the full T1 pipe (context → C2 answerAsOwner →
//    C4-gated answer → W16 injection, else the T3 inbox). It is a LIBRARY for
//    C-core: nothing in this module runs it on a schedule — budget, single
//    flight and seen-dedup are C-core's to own (§10 C3 "C-core の予算配下").
//    Until C-core lands, the engine monitor takes the §6 S4 THROTTLED
//    degradation instead: raise the bare question straight to the inbox
//    (LLM-free) — see swarmOrchestrator's 'question' arm.
//
// Screen signature (verified against live `claude` TUI frames, 2026-07-06 —
// the card's mandated first work item):
//   idle footer   "? for shortcuts"      ← present ONLY at an idle input box
//   working footer "esc to interrupt"    ← present ONLY while generating
//   input box      last "❯"-prefixed row (empty / placeholder `Try "…"` when
//                  idle; the pasted text when a paste is pending unsent)
//   assistant turn "⏺ …" block; its continuation lines are indented
// A permission/trust MENU frame additionally carries numbered options, which
// claudeMenu.detectMenu recognises — menu frames are EXCLUDED here (they are
// the permission-wait arm's business; "menu 誤検出ゼロ" is a Done condition).

import { detectMenu } from '@/lib/claudeMenu'
import {
  IDLE_FOOTER_RE,
  PLACEHOLDER_RE,
  PROMPT_ROW_RE,
  RULE_ROW_RE,
  WORKING_FOOTER_RE,
  isChromeRow,
  lastPromptRow,
  readInputBoxText,
} from '@/lib/claudeScreen'
import type { OwnerAnswer, OwnerQuestion } from './swarmOverseerBrain'
import { answerAsOwner, runOverseerBrain } from './swarmOverseerBrain'
import type { OpenEscalationInput } from './swarmEscalations'
import {
  MAX_ESCALATION_CONTEXT,
  MAX_ESCALATION_QUESTION,
  buildAnswerInjection,
  defaultCanInjectInto,
  deliverAnswerToWorker,
  injectAnswerIntoWorker,
  openEscalation,
} from './swarmEscalations'
import {
  sdkRecentOutputHead,
  workerRuntimeKind,
  type WorkerHandle,
  type WorkerRuntimeKind,
} from './workerRuntime'
import type { Escalation, EscalationWhy } from '../types'

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

/**
 * Detect "claude asked the owner a free-text question and is now idle at an
 * EMPTY input box". ALL of (fail-closed — see file header for why FP is the
 * dangerous direction here):
 *  1. no interactive menu on screen (claudeMenu — the permission arm's turf);
 *  2. the idle footer is present and the working footer is absent;
 *  3. the input box exists and is empty (or the stock `Try "…"` placeholder) —
 *     a pending unsent paste must never be double-answered;
 *  4. the last real (non-chrome) row above the input box ends in '?' / '？';
 *  5. that row's utterance block stays within QUESTION_BLOCK_MAX_ROWS.
 * Returns the reassembled question text, or null.
 */
export const detectFreeTextQuestion = (
  screen: string | null,
): DetectedFreeTextQuestion | null => {
  if (!screen) return null
  if (WORKING_FOOTER_RE.test(screen)) return null
  if (!IDLE_FOOTER_RE.test(screen)) return null
  if (detectMenu(screen)) return null

  const rows = screen.split('\n')
  const p = lastPromptRow(rows)
  if (p < 0) return null
  const boxText = readInputBoxText(screen) ?? ''
  if (boxText && !PLACEHOLDER_RE.test(boxText)) return null

  // The input box is fenced by rules; the conversation log ends above its top
  // rule. Walk up from there, skipping chrome, to the last real utterance row.
  let top = p
  while (top > 0 && !RULE_ROW_RE.test(rows[top - 1])) top--
  let i = top - 1
  while (i >= 0 && RULE_ROW_RE.test(rows[i])) i--
  while (i >= 0 && isChromeRow(rows[i])) i--
  if (i < 0) return null
  const lastReal = rows[i].trim()
  if (!/[?？]$/.test(lastReal)) return null
  // A row that itself reads as a prompt/menu artifact is not an utterance.
  if (PROMPT_ROW_RE.test(rows[i])) return null

  // Reassemble the utterance block: walk further up while rows belong to the
  // same assistant turn (indented continuations), stopping at (and including)
  // the `⏺` turn marker, a chrome row, another prompt row, or the row cap.
  const block: string[] = [lastReal]
  for (let j = i - 1; j >= 0 && block.length < QUESTION_BLOCK_MAX_ROWS; j--) {
    const raw = rows[j]
    const t = raw.trim()
    if (!t || isChromeRow(raw) || PROMPT_ROW_RE.test(raw) || RULE_ROW_RE.test(raw)) break
    if (/^⏺/.test(t)) {
      block.unshift(t.replace(/^⏺\s*/, ''))
      break
    }
    block.unshift(t)
  }
  const question = block.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ESCALATION_QUESTION)
  if (!question) return null
  return { question }
}

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
 *  monitor's raise) go through, so neither can ever ask a PTY-shaped question
 *  of an SDK worker's output again. */
export const detectWorkerFreeTextQuestion = (
  kind: WorkerRuntimeKind,
  out: string | null,
): DetectedFreeTextQuestion | null =>
  kind === 'sdk' ? detectSdkFreeTextQuestion(out) : detectFreeTextQuestion(out)

// ─── The T1 pipe (C-core's library — NOT self-scheduling; see file header) ────

export interface WorkerQuestionInput {
  projectPath: string
  /** The question text — PTY-detected (this module) or heartbeat-blockers
   *  (S4). One pipe for both, so the receiptKey dedup unifies the two paths. */
  question: string
  /** What the asker was doing — PTY tail, card title, blockers line. Clamped. */
  context: string
  taskId?: string
  branch?: string
  /** The blocked worker's ADDRESS — `runtime` plus the ONE handle it names
   *  (pty ⇔ `terminalId`, sdk ⇔ `sdkSessionId`; workerRuntime.ts). Absent
   *  entirely (S4 heartbeat path, dead worker) ⇒ a confident answer still lands
   *  in the inbox as a proxyDraft.
   *
   *  ⚠ THIS USED TO BE `terminalId` ALONE, and the pipe below branched on
   *  `if (input.terminalId)`. An SDK worker's terminalId is the EMPTY STRING by
   *  the identity invariant, so for every such worker the branch was false: the
   *  answer was never delivered, the escalation that replaced it carried no
   *  address either, and the whole thing reported success ('escalated'). Not a
   *  degraded path — one that could not fire once. Carry the WHOLE handle and
   *  let {@link deliverAnswerToWorker} branch. */
  runtime?: WorkerRuntimeKind
  terminalId?: string
  sdkSessionId?: string
}

export type WorkerQuestionOutcome =
  | { outcome: 'injected'; answer: string; confidence: 'high' | 'medium' | 'low' }
  | { outcome: 'escalated'; escalationId: string; why: EscalationWhy; deduped: boolean }
  /** Even the T3 inbox write failed — nothing was delivered anywhere. The
   *  caller (C-core) must surface this; swallowing it would silently drop an
   *  owner-bound question. */
  | { outcome: 'failed'; reason: string }

export interface HandleWorkerQuestionDeps {
  /** The C2 proxy (default: answerAsOwner over runOverseerBrain). */
  answer?: (q: OwnerQuestion) => Promise<OwnerAnswer>
  /** PTY ARM ONLY — the injection-target guard (default: {@link defaultCanInjectInto}). */
  canInjectInto?: (terminalId: string, projectPath: string) => Promise<boolean>
  /** PTY ARM ONLY — the W16 delivery helper (default: {@link injectAnswerIntoWorker}). */
  inject?: (terminalId: string, text: string) => Promise<boolean>
  /** SDK ARM — the targeting guard (default: `defaultCanPushIntoSdkWorker`).
   *  Declared here, and not only on `DeliverAnswerDeps`, for the same reason
   *  {@link import('./swarmEscalations').AnswerEscalationDeps} declares it: a
   *  test that can inject only the PTY seams can only ever exercise the PTY
   *  half — which is precisely how this pipe stayed PTY-only unnoticed. */
  canPushInto?: (sdkSessionId: string, projectPath: string) => Promise<boolean>
  /** SDK ARM — the delivery (default: `pushSdkInput`). */
  push?: (sdkSessionId: string, text: string) => boolean
  /** The WHOLE conduit, overriding both arms (default: the composition below).
   *  Mirrors `OverseerDeps.deliverAnswer` — one seam a caller can hand a fake
   *  runtime-agnostic delivery to. */
  deliver?: (target: WorkerHandle, projectPath: string, text: string) => Promise<boolean>
  /** The T3 inbox (default: {@link openEscalation}). */
  escalate?: (
    input: OpenEscalationInput,
  ) => Promise<{ escalation: Escalation; deduped: boolean }>
  signal?: AbortSignal
}

/**
 * One worker question, end to end: C2 answers as the owner (C4 gates the
 * question AND the answer text inside answerAsOwner), a confident answer is
 * delivered to the live worker ON ITS OWN RUNTIME (W16 bracketed paste + Enter
 * with landing confirmation/retry for a PTY; one queued turn for an SDK
 * session), and EVERY other path — proxy escalation, missing/refused/failed
 * target — falls CLOSED into the T3 inbox (with the proxy's draft attached when
 * one exists, so the owner reviews instead of retyping). Never throws.
 */
export const handleWorkerQuestion = async (
  input: WorkerQuestionInput,
  deps?: HandleWorkerQuestionDeps,
): Promise<WorkerQuestionOutcome> => {
  const answer =
    deps?.answer ??
    ((q: OwnerQuestion) =>
      answerAsOwner(q, { runBrain: runOverseerBrain, signal: deps?.signal }))
  const canInjectInto = deps?.canInjectInto ?? defaultCanInjectInto
  const inject = deps?.inject ?? injectAnswerIntoWorker
  const escalate = deps?.escalate ?? openEscalation

  /** Deliver to the worker on ITS OWN runtime.
   *
   *  ONE branch, in ONE place — and it exists (rather than being a bare call to
   *  {@link deliverAnswerToWorker}) for the same reason swarmOverseer's
   *  `deliverProxyAnswer` does: the PTY seams this pipe exposes (`canInjectInto`
   *  + `inject`, which replaces the WHOLE of `injectAnswerIntoWorker`) have no
   *  counterpart inside `DeliverAnswerDeps` to compose. The SDK arm has no such
   *  legacy shape, so it goes straight through the production conduit with its
   *  own seams injected. */
  const deliverTo = async (h: WorkerHandle, text: string): Promise<boolean> => {
    if (deps?.deliver) return deps.deliver(h, input.projectPath, text)
    if (workerRuntimeKind(h) === 'sdk') {
      return deliverAnswerToWorker(h, input.projectPath, text, {
        ...(deps?.canPushInto ? { canPushInto: deps.canPushInto } : {}),
        ...(deps?.push ? { push: deps.push } : {}),
      })
    }
    const id = h.terminalId
    if (!id) return false
    return (await canInjectInto(id, input.projectPath)) && (await inject(id, text))
  }

  const question = input.question.replace(/\s+/g, ' ').trim().slice(0, MAX_ESCALATION_QUESTION)
  const context = input.context.slice(0, MAX_ESCALATION_CONTEXT)
  // The blocked worker's address, normalized once. Empty ids are dropped here so
  // an SDK worker's `terminalId: ''` can never be mistaken for a PTY handle by
  // anything downstream (openEscalation's `addressOf` would store nothing for it
  // anyway — but the branch below would already have taken the wrong arm).
  const target: WorkerHandle = {
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.terminalId ? { terminalId: input.terminalId } : {}),
    ...(input.sdkSessionId ? { sdkSessionId: input.sdkSessionId } : {}),
  }
  const coords = {
    projectPath: input.projectPath,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    // The escalation record must be able to name the SAME worker this pipe just
    // failed to reach: the inbox row is the owner's only remaining route to it.
    ...target,
  }

  const raise = async (
    why: EscalationWhy,
    reason: string,
    proxyDraft?: { answer: string; confidence: 'high' | 'medium' | 'low' },
  ): Promise<WorkerQuestionOutcome> => {
    try {
      const { escalation, deduped } = await escalate({
        ...coords,
        question,
        context: reason ? `${reason}\n\n${context}`.slice(0, MAX_ESCALATION_CONTEXT) : context,
        whyEscalated: why,
        ...(proxyDraft ? { proxyDraft: { ...proxyDraft, isAbstention: false } } : {}),
      })
      return { outcome: 'escalated', escalationId: escalation.id, why, deduped }
    } catch (e) {
      // The inbox itself failed (fs fault) — the "never throws" backstop. The
      // caller must surface this: the question reached NO ONE.
      return {
        outcome: 'failed',
        reason: `escalation write failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  let verdict: OwnerAnswer
  try {
    verdict = await answer({ question, context, projectPath: input.projectPath })
  } catch (e) {
    // answerAsOwner never throws; this guards injected fakes / future edits.
    return raise(
      'insufficient-info',
      `proxy pipeline crashed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (verdict.kind === 'escalate') {
    return raise(verdict.why, verdict.reason)
  }

  // Confident, C4-clean answer — deliver it into the LIVE worker, on whatever
  // runtime carries it. The address decides which conduit; this call site does
  // not get to pick one id and hope.
  if (target.terminalId || target.sdkSessionId) {
    let delivered = false
    try {
      delivered = await deliverTo(target, buildAnswerInjection(question, verdict.text))
    } catch {
      delivered = false
    }
    if (delivered) {
      return { outcome: 'injected', answer: verdict.text, confidence: verdict.confidence }
    }
  }
  // No target / target refused / delivery failed ⇒ the answer must not be lost
  // AND must not be silently dropped into a wrong desk: inbox, draft attached.
  return raise('policy', 'proxy answered but the worker was not reachable', {
    answer: verdict.text,
    confidence: verdict.confidence,
  })
}
