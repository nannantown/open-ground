// assistantProposals — what the owner's assistant may only PROPOSE: one card for
// a project's Board, or one message for a project's commander (owner decision
// 2026-10-06 「全部Aで進めて」, docs/research/voice-assistant-2026-10.md §3).
//
// A proposal lives in this process's memory only — never on a Board, never in
// the talk. The window (and the iPhone) shows it in its own frame, and the ONE
// way it is carried out is the owner pressing that frame's button: approve(id,
// hash), where `hash` is computed BY THE SCREEN from the exact strings it shows
// (proposalHash). The card written / the line sent is built from the same
// stored strings, so what happens is, character for character, what was shown.
// Nothing said or typed to the assistant ever carries one out: no word is
// interpreted as a yes anywhere (the parked branch's voice-yes path, reworked 4
// times, is gone). When anything cannot be checked, nothing is done.
//
// The assistant itself can only make proposals and withdraw them (「やめて」 —
// the safe direction). A proposal not acted on expires after 10 minutes.
import { createHash, randomUUID } from 'crypto'
import type { ProjectTask } from '../types'
import { newId } from '@/lib/ids'
import { mutateProjectData } from './projectData'
import { pick, type PromptLang } from './promptLang'
import { isLockdownEnabledSync } from './lockdown'
import { relayToCommander } from './commanderRelay'
import { getSettings } from './store'

/** An open proposal waits this long for its button. */
export const PROPOSAL_MS = 10 * 60_000
/** A closed one (done / dropped / expired) stays on screen, faded, this long after it was made. */
const KEEP_MS = 30 * 60_000
/** All of one proposal (title + body), a hard cap whatever the lines. */
export const PROPOSAL_CHARS = 400
/** The lines a frame may take (project + title + body), so it is seen whole in
 *  the floating window in a call as in chat. Measured 2026-10-06 in Chromium on
 *  the real CSS (rework 1/2): a text line is 20 px and 21 full-width characters
 *  wide (292 px, a full-width character 13.92 px); a frame is 62 px + 20 px a line; the default 460 px window
 *  leaves the frames 356 px in chat and 262 px in a call → (262 - 62) / 20 = 10. */
export const FRAME_LINES = 10
/** Width units of a frame line (a full-width character = 2). */
const LINE_UNITS = 42
/** The lines a text takes in a frame, estimated on the WIDE side (a narrow
 *  character counted wider than it is), so an estimate never fits what the
 *  window would cut: CJK / full-width 2, an ASCII capital 1.7, other ASCII 1.15. */
export const frameLines = (text: string): number =>
  text.split('\n').reduce((n, line) => {
    let units = 0
    for (const ch of line) units += /[\x20-\x7e]/.test(ch) ? (/[A-Z@%&MW#]/.test(ch) ? 1.7 : 1.15) : 2
    return n + Math.max(1, Math.ceil(units / LINE_UNITS))
  }, 0)
/** Open at once (「AとBを作って」 = two frames). */
export const OPEN_MAX = 3
const KEPT_MAX = 6

export interface KnownProject {
  id: string
  name: string
  path: string
}

export type ProposalKind = 'card' | 'commander'
export type ProposalState = 'open' | 'done' | 'dropped' | 'expired'

/** What a screen shows — and the only thing it may carry out. */
export interface ShownProposal {
  id: string
  kind: ProposalKind
  projectId: string
  /** The project's name. */
  project: string
  /** card: its title; commander: ''. */
  title: string
  /** card: its notes, exactly as written; commander: the line, exactly as sent. */
  body: string
  at: number
  expiresAt: number
  state: ProposalState
  /** When it stopped being open (done / dropped / expired); absent while open.
   *  The list is in the order made, so the newest closed one is found by this. */
  closedAt?: number
  /** Where the line that made it was said: the iPhone shows only its own. */
  via: 'phone' | 'screen'
}
interface Held extends ShownProposal {
  path: string
  /** Its button is being carried out (closed meanwhile; may reopen if it did not get through). */
  pressing?: boolean
  /** 「やめて」 / 「やめる」 / a delete came while it was being pressed: it never reopens. */
  cancel?: boolean
}

/** The check a screen sends back with its button press: SHA-256 (hex) of the
 *  shown strings joined by "\n". project and title never hold a newline, and
 *  body comes last, so the joined text can be read back one way only.
 *  docs/PHONE_LINK.md "Assistant proposals" gives a test vector. */
export const proposalHash = (p: Pick<ShownProposal, 'kind' | 'projectId' | 'project' | 'title' | 'body'>): string =>
  createHash('sha256').update([p.kind, p.projectId, p.project, p.title, p.body].join('\n'), 'utf8').digest('hex')

const g = globalThis as typeof globalThis & { __openground_assistant_proposals?: { list: Held[]; listeners: Set<() => void> } }
const store = () => (g.__openground_assistant_proposals ??= { list: [], listeners: new Set() })

/** The talk was deleted: what it proposed goes too (not even listed faded). */
export const clearProposals = (): void => {
  for (const p of store().list) p.cancel = true
  store().list = []
  changed()
}

/** Tests: forget every proposal. */
export const __resetProposals = (): void => {
  g.__openground_assistant_proposals = undefined
}

/** Told whenever the list changes (the phone link sends it on). Returns the unsubscribe. */
export const onProposalsChanged = (fn: () => void): (() => void) => {
  store().listeners.add(fn)
  return () => void store().listeners.delete(fn)
}
const changed = () => {
  store().listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* a listener's failure is its own */
    }
  })
}

/** Expire what waited too long, drop what is too old to show. */
const sweep = (now: number): boolean => {
  const s = store()
  let moved = false
  for (const p of s.list)
    if (p.state === 'open' && now >= p.expiresAt) {
      p.state = 'expired'
      p.closedAt = p.expiresAt
      moved = true
    }
  const kept = s.list.filter((p) => p.state === 'open' || now - p.at < KEEP_MS)
  if (kept.length !== s.list.length) moved = true
  s.list = kept
  return moved
}

const shown = ({ path: _path, pressing: _pressing, cancel: _cancel, ...p }: Held): ShownProposal => ({ ...p })

/** What the screens show: oldest first. `via: 'phone'` = only those made from the iPhone. */
export const listProposals = (o: { now?: number; via?: 'phone' } = {}): ShownProposal[] => {
  if (sweep(o.now ?? Date.now())) changed()
  return store()
    .list.filter((p) => !o.via || p.via === o.via)
    .map(shown)
}

export const openProposals = (now = Date.now()): ShownProposal[] => listProposals({ now }).filter((p) => p.state === 'open')

// ── making one (the assistant's tools) ──────────────────────────────────────

/** A character that is neither seen nor heard: controls, format characters
 *  (zero-width U+200B-D / U+2060, direction U+202A-E / U+2066-9, BOM, Unicode
 *  TAG U+E0020-E007F — "ASCII smuggling") and the default-ignorables (variation
 *  selectors…). The screen drops them, a worker reading the card does not
 *  (review 2026-10-06: a goal carried 52 TAG units no one could see). Tab /
 *  newline / CR are only whitespace here: every field is folded to one line. */
const UNSEEN = new RegExp('[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}]', 'u')
const visible = (s: string) => !UNSEEN.test(s.replace(/[\t\n\r]/g, ' '))
const flat = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')

const UNSEEN_REFUSED = 'Not proposed: it holds characters that can be neither seen nor heard (zero-width, direction, tag or control characters). Write it in plain text.'
const TOO_LONG = `Not proposed: too long to be seen whole in the owner's window (at most ${FRAME_LINES} short lines of about 20 Japanese characters, project and title included). Make it shorter — or, if it is a big request, tell the owner to ask the president (the owner talks to the president in the project).`
const FULL = `Not proposed: ${OPEN_MAX} proposals already wait for the owner's buttons. Let them press or drop one first.`
const workMode = (lang: PromptLang) => pick(lang, { en: 'Work mode is on: nothing can be done now.', ja: '作業モードがオンなので、今は何もできない。' })

export interface CardInput {
  projectId: string
  title: string
  goal: string
  done: string[]
}

/** The card's notes as written — the window shows exactly this. */
export const cardBody = (goal: string, done: string[], lang: PromptLang): string => {
  const h = pick(lang, { en: ['What to do: ', 'Done when:'], ja: ['やること: ', '完了の条件:'] })
  return [h[0] + goal, h[1], ...done.map((d) => `- ${d}`)].join('\n')
}

/** The line a commander receives — marked as the assistant's, never as the owner's own words. */
export const commanderLine = (words: string, lang: PromptLang): string =>
  pick(lang, { en: "Via the assistant (a summary of the owner's words): ", ja: 'アシスタント経由(オーナーの言葉の要約): ' }) + words

/** The project as the frame names it: its name, and where two registered
 *  projects share that name, the end of its folder too — so two frames that
 *  would land in different projects never look the same. */
const projectLabel = (project: KnownProject, all: KnownProject[]): string => {
  const name = flat(project.name)
  if (all.filter((p) => flat(p.name) === name).length < 2) return name
  return `${name} (${project.path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')})`
}

const add = (p: Omit<Held, 'id' | 'at' | 'expiresAt' | 'state'>, now: number): ShownProposal | string => {
  sweep(now)
  const s = store()
  if (s.list.filter((x) => x.state === 'open').length >= OPEN_MAX) return FULL
  if (p.title.length + p.body.length > PROPOSAL_CHARS || frameLines(p.project) + (p.title ? frameLines(p.title) : 0) + frameLines(p.body) > FRAME_LINES) return TOO_LONG
  const held: Held = { ...p, id: randomUUID(), at: now, expiresAt: now + PROPOSAL_MS, state: 'open' }
  // The newest KEPT_MAX, never dropping an open one.
  s.list = [...s.list, held]
  while (s.list.length > KEPT_MAX) {
    const i = s.list.findIndex((x) => x.state !== 'open')
    if (i < 0) break
    s.list.splice(i, 1)
  }
  changed()
  return shown(held)
}

export interface ProposeContext {
  lang: PromptLang
  now: number
  via: 'phone' | 'screen'
  projects: () => Promise<KnownProject[]>
}

/** One card for a registered project → its proposal, or why not (for the model). */
export const proposeCard = async (c: CardInput, ctx: ProposeContext): Promise<ShownProposal | string> => {
  if (isLockdownEnabledSync()) return workMode(ctx.lang)
  const done = Array.isArray(c.done) ? c.done : []
  if (![c.title, c.goal, ...done].every((t) => typeof t !== 'string' || visible(t))) return UNSEEN_REFUSED
  const all = await ctx.projects()
  const project = all.find((p) => p.id === c.projectId)
  if (!project) return 'No such projectId. Use one from the project list.'
  if (!visible(project.name) || !visible(project.path)) return UNSEEN_REFUSED
  const items = done.map(flat).filter(Boolean)
  const title = flat(c.title)
  const goal = flat(c.goal)
  if (!title || !goal || !items.length) return 'Not proposed: title, goal and at least one done condition are all required. Ask the owner for what is missing.'
  return add({ kind: 'card', projectId: project.id, project: projectLabel(project, all), path: project.path, title, body: cardBody(goal, items, ctx.lang), via: ctx.via }, ctx.now)
}

/** One message for a project's commander → its proposal. One line (a multi-line say wedges a desk). */
export const proposeMessage = async (projectId: string, message: string, ctx: ProposeContext): Promise<ShownProposal | string> => {
  if (isLockdownEnabledSync()) return workMode(ctx.lang)
  if (typeof message === 'string' && !visible(message)) return UNSEEN_REFUSED
  const all = await ctx.projects()
  const project = all.find((p) => p.id === projectId)
  if (!project) return 'No such projectId. Use one from the project list.'
  if (!visible(project.name) || !visible(project.path)) return UNSEEN_REFUSED
  const words = flat(message)
  if (!words) return 'Nothing to say: give the message.'
  return add({ kind: 'commander', projectId: project.id, project: projectLabel(project, all), path: project.path, title: '', body: commanderLine(words, ctx.lang), via: ctx.via }, ctx.now)
}

/** 「やめて」: every open proposal is dropped (the safe direction — no button needed). */
export const withdrawProposals = (now = Date.now()): number => {
  sweep(now)
  let n = 0
  for (const p of store().list)
    if (p.state === 'open') {
      p.state = 'dropped'
      p.closedAt = now
      n++
    } else if (p.pressing) p.cancel = true
  if (n) changed()
  return n
}

// ── the button (the ONLY way one is carried out) ───────────────────────────

export type ButtonRefusal = 'not-found' | 'closed' | 'expired' | 'mismatch' | 'work-mode'
export interface Carried {
  proposal: ShownProposal
  card?: { projectId: string; taskId: string; title: string }
  told?: { delivered: boolean; woke: boolean; error?: string }
}

/** The owner pressed 「出す」/「送る」 on the frame that showed `hash`. Carried
 *  out at most once; anything that cannot be checked does nothing. */
export const approveProposal = async (
  id: unknown,
  hash: unknown,
  o: { now?: number; lang: PromptLang; relay?: typeof relayToCommander },
): Promise<Carried | { error: ButtonRefusal }> => {
  if (isLockdownEnabledSync()) return { error: 'work-mode' }
  const now = o.now ?? Date.now()
  if (sweep(now)) changed()
  const p = typeof id === 'string' ? store().list.find((x) => x.id === id) : undefined
  if (!p) return { error: 'not-found' }
  if (p.state === 'expired') return { error: 'expired' }
  if (p.state !== 'open') return { error: 'closed' }
  if (typeof hash !== 'string' || hash !== proposalHash(p)) return { error: 'mismatch' }
  // Closed before anything awaits: a second press (the Mac and the iPhone at once) finds it closed.
  p.state = 'done'
  p.closedAt = now
  p.pressing = true
  changed()
  // Not delivered / failed: open again to be pressed — unless it was dropped meanwhile.
  const reopen = () => {
    p.state = p.cancel ? 'dropped' : 'open'
    if (p.state === 'open') delete p.closedAt
    changed()
  }
  try {
    // Where the project is NOW (it may have been relocated since; removed = nothing to do).
    const path = ((await getSettings()).projects ?? []).find((x) => x.id === p.projectId)?.path
    if (!path) {
      p.state = 'dropped'
      changed()
      return { error: 'not-found' }
    }
    p.path = path
    if (p.kind === 'card') {
      const task: ProjectTask = { id: newId(), title: p.title, notes: p.body, done: false, createdAt: new Date(now).toISOString(), boardColumn: 'todo' }
      // One write, with the notes in it. Never folded into another card of the same title.
      await mutateProjectData(p.path, (d) => void d.tasks.push(task))
      return { proposal: shown(p), card: { projectId: p.projectId, taskId: task.id, title: task.title } }
    }
    const r = await (o.relay ?? relayToCommander)(p.path, p.body)
    const told = r.ok ? { delivered: r.delivered, woke: r.woke } : { delivered: false, woke: false, error: String(r.body.error ?? 'unreachable') }
    // Not delivered: it stays open, to be pressed again.
    if (!told.delivered) reopen()
    return { proposal: shown(p), told }
  } catch (e) {
    reopen()
    throw e
  } finally {
    p.pressing = false
  }
}

/** The owner pressed 「やめる」. */
export const dropProposal = (id: unknown, now = Date.now()): ShownProposal | { error: ButtonRefusal } => {
  if (sweep(now)) changed()
  const p = typeof id === 'string' ? store().list.find((x) => x.id === id) : undefined
  if (!p) return { error: 'not-found' }
  if (p.pressing) p.cancel = true
  if (p.state !== 'open') return { error: p.state === 'expired' ? 'expired' : 'closed' }
  p.state = 'dropped'
  p.closedAt = now
  changed()
  return shown(p)
}

/** The app's own words for what a button did (never the model's). */
export const carriedLine = (c: Carried, lang: PromptLang): string => {
  const name = c.proposal.project
  if (c.card) return pick(lang, { en: `Done — "${c.card.title}" is on ${name}'s Board.`, ja: `${name}に「${c.card.title}」を積んだよ。` })
  const t = c.told
  if (!t || t.error) return pick(lang, { en: `I couldn't reach ${name}'s commander.`, ja: `${name}の司令官に届けられなかった。` })
  return t.delivered
    ? pick(lang, { en: `Passed to ${name}'s commander.${t.woke ? ' It was asleep, so its answer takes a bit longer.' : ''}`, ja: `${name}の司令官に伝えたよ。${t.woke ? '寝てたのを起こしたから、返事は少しかかるよ。' : ''}` })
    : pick(lang, { en: `${name}'s commander is busy; it did not get it. Press again in a bit.`, ja: `${name}の司令官は手が離せなくて、まだ届いてない。少ししてからもう一回押して。` })
}

/** What is said aloud after a line that made proposals (the app's words, not the model's). */
export const proposedLine = (kinds: ProposalKind[], lang: PromptLang): string =>
  kinds.every((k) => k === 'card')
    ? pick(lang, { en: 'I put up a card proposal. Press "Add" if it looks right.', ja: 'カード案を出したよ。よければ「出す」を押してね。' })
    : kinds.every((k) => k === 'commander')
      ? pick(lang, { en: 'I put up the message. Press "Send" if it looks right.', ja: '伝言の案を出したよ。よければ「送る」を押してね。' })
      : pick(lang, { en: 'I put up the proposals. Press their buttons if they look right.', ja: '案を出したよ。よければボタンを押してね。' })
