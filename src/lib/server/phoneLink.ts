// Phone link — the owner's iPhone talks to a project's president desk from
// anywhere (owner request 2026-10-01: earphones in, Mac and app screen closed).
// Protocol + pairing: docs/PHONE_LINK.md.
//
// The Mac is never reachable from the internet. This module dials OUT to a
// Cloudflare relay room (worker/src/phoneRelay.ts) and keeps that socket up:
//   phone → relay → here:  `say` (owner words → the desk's OWNER lane in
//                          supplyNotice.ts, under its busy/half-typed/menu
//                          refusals), `select` (which project), `projects`.
//   here → relay → phone:  every line of the selected president's transcript
//                          that the owner would want to hear, in order — app
//                          notices, commander replies, the owner's own words,
//                          the president's text — plus acks and the project list.
//
// Keys live in ~/.openground/phone-link.json (0600). The room is named by the
// hash of the phone's key, so the relay stores no phone credential at all.
import { randomBytes, createHash } from 'crypto'
import { open, readFile, rm, stat } from 'fs/promises'
import { basename, join } from 'path'
import WebSocket from 'ws'
import { atomicWriteJson } from './atomicWrite'
import { openGroundHome } from './paths'
import { getSettings } from './store'
import { readSwarmSessions } from './swarmSessions'
import { sessionJsonlPath } from './transcript'
import { listLiveDesksIn } from './terminal'
import { SUPPLY_DESK_LABEL } from './swarmSupply'
import { promptAuthor } from './groundMarks'
import {
  queueSupplyOwnerSay,
  ownerSayLine,
  ownerSayTooLong,
  SUPPLY_OWNER_SAY_MAX,
  supplyLineBody,
  SUPPLY_NOTICE_PREFIX,
  SUPPLY_REPLY_PREFIX,
  type SupplyNoticeDeps,
} from './supplyNotice'
import { isLockdownEnabledSync } from './lockdown'
import { alreadyStored, asCursor, asPushTarget, type Cursor, type PushTarget } from '../../../worker/src/phoneRelayAuth'
import { providerTokenExpired, renewStaleProviderToken, pushKeyFingerprint, pushRefusedForGood, pushTokenGone, pushTransient, refusalIsTheApp, readPushKey, sendPushToTalk, type PushKey, type PushResult } from './phonePush'
import { isSwarmLocalOwnerUnlocked } from './swarmGate'
import { getCustomTabRole } from './roles'
import { ASSISTANT_ID, ASSISTANT_SAY_MAX, AssistantFailure, askAssistant, assistantBusy, plainAssistantError, type AssistantAnswer } from './phoneAssistant'
import { langOf, pick } from './promptLang'
import { e2eKeyOf, open as openSealed, seal, sealTag } from './phoneLinkSeal'
import { appendAssistantCall, assistantEntriesFor, readAssistantConfig, readAssistantLog, readAssistantMemory } from './assistantMemory'

/** The relay the owner deployed (worker/wrangler.phone.jsonc). Override with
 *  OPENGROUND_PHONE_RELAY_URL at pairing time (tests, a self-hosted relay). */
export const PHONE_RELAY_DEFAULT_URL = 'https://og-phone-relay.mindbrew.workers.dev'

export interface PhoneLinkConfig {
  /** 2 = sealed (docs/PHONE_LINK.md "Sealed frames"); 1 = a plaintext pairing
   *  from before 2026-10-03, honoured until LEGACY_V1_UNTIL. */
  v: 1 | 2
  relayUrl: string
  macKey: string
  phoneKey: string
  /** v2: the 32-byte end-to-end key (base64url). In the pairing code, never
   *  sent to the relay. */
  e2eKey?: string
  /** v2: ids of phone frames accepted within SEALED_MAX_AGE_MS (id → its ts), so
   *  a frame replayed by the relay is refused even across an app restart. */
  seenIds?: Record<string, number>
  /** The project (registry UUID) whose president the phone hears. */
  projectId?: string
  /** Where reading of the current transcript began (`f` = project:file). A
   *  resume never rewinds before it — and it survives a restart, so the first
   *  read after one cannot reach into talk the previous run never read (said
   *  while another project was selected, or under work mode). */
  floor?: { f: string; o: number }
  /** The phone's newest Push to Talk token (`push-token` frame). Dropped with
   *  the pairing (unpair removes the file, pairing writes a new one without it). */
  push?: PushTarget
  /** Apple's last permanent refusal, for this token + key (fingerprint). While
   *  both are unchanged nothing is pushed and Settings says the wake is off. */
  pushRefused?: { reason: string; token: string; key: string }
  /** v2: the phone fetched the assistant's records once (`assistant-history`),
   *  so it knows the `assistant` frame: from then on the assistant's talk goes
   *  out as that (sealed, passed on by the relay and never kept) instead of as
   *  `event`s the relay keeps (sealed) for catch-up. */
  assistantDirect?: boolean
}

export type PhoneEventKind = 'notice' | 'commander' | 'owner' | 'president'
export interface PhoneEvent {
  kind: PhoneEventKind
  text: string
  /** ms from the transcript line, when it has one. */
  at?: number
}

/** A plaintext (v1) pairing stops connecting after this: pair again to get v2. */
export const LEGACY_V1_UNTIL = Date.parse('2026-11-30T00:00:00Z')
/** A sealed phone frame whose ts is further than this from the Mac's clock is
 *  refused (a say is answered `stale`): the relay cannot hold a say and use it later. */
export const SEALED_MAX_AGE_MS = 5 * 60_000
/** Content frames sealed on a v2 pairing (control frames stay plain). */
const SEALED_TYPES = new Set(['say', 'select', 'projects', 'event', 'ack', 'assistant', 'assistant-history', 'call-note'])

const EVENT_TEXT_MAX = 8000
const TAIL_TICK_MS = 1000
const PROJECTS_EVERY_MS = 15_000
const PING_EVERY_MS = 30_000
const READ_MAX = 1024 * 1024
/** How long a fresh Mac connection waits for the relay's `resume` before
 *  reading on anyway (a relay that predates it never sends one). */
const RESUME_WAIT_MS = 5000
/** A resume never rewinds further than this (a Mac back after a long time
 *  away does not read hours of talk into the earphones). */
const RESUME_MAX_BEHIND = 4 * READ_MAX
/** At most one push per this while the president keeps writing. */
export const PUSH_GAP_MS = 5000
/** A say from the phone holds pushes until its final ack — but never longer
 *  than this (an owner line has no TTL: a desk that never frees up would
 *  otherwise silence the phone for good). */
export const SAY_HOLD_MAX_MS = 2 * 60_000
/** A push that got no answer / 429 / 5xx is tried again after the gap, this many
 *  times in a row at most. */
export const PUSH_RETRY_MAX = 3

/** Apple's standing refusal of this token with this key, or null. */
const pushRefusal = (cfg: PhoneLinkConfig, key: PushKey): string | null => {
  const r = cfg.pushRefused
  return r && typeof r.reason === 'string' && r.token === cfg.push?.token && r.key === pushKeyFingerprint(key) ? r.reason : null
}

/** The app owner only (owner decision 2026-10-01: 「まずはオーナー自分専用」) —
 *  NOT the public Agent Team opt-in, which opens the rest of the swarm. The relay
 *  is the owner's; per-user rooms for App Store users come with their own gate. */
export const hasPhoneLinkAccess = async (): Promise<boolean> =>
  (await isSwarmLocalOwnerUnlocked()) || (await getCustomTabRole()) === 'owner'

const configFile = (): string => join(openGroundHome(), 'phone-link.json')
const key = (): string => randomBytes(32).toString('base64url')
const roomOf = (phoneKey: string): string => createHash('sha256').update(phoneKey).digest('hex')
const wsBase = (relayUrl: string): string => relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '')
export const roomUrl = (c: PhoneLinkConfig, role: 'mac' | 'phone'): string =>
  `${wsBase(c.relayUrl)}/v1/${roomOf(c.phoneKey)}/${role}`
/** The Mac end's headers: its key, plus the app key that lets it create its room
 *  (baked into release builds; only a NEW room needs it — an existing one,
 *  even one emptied after 30 idle days, is entered with the Mac key alone).
 *  Exported for tests. */
export const macHeaders = (c: PhoneLinkConfig): Record<string, string> => {
  const app = process.env.OPENGROUND_PHONE_RELAY_APP_KEY
  return { 'X-OG-Token': c.macKey, ...(app ? { 'X-OG-App-Key': app } : {}) }
}

/** What the phone is given once (docs/PHONE_LINK.md §Pairing). */
export const pairingCode = (c: PhoneLinkConfig): string =>
  Buffer.from(
    JSON.stringify(c.v === 2 ? { v: 2, url: roomUrl(c, 'phone'), key: c.phoneKey, e2e: c.e2eKey } : { v: 1, url: roomUrl(c, 'phone'), key: c.phoneKey }),
  ).toString('base64url')

export const readPhoneLinkConfig = async (): Promise<PhoneLinkConfig | null> => {
  try {
    const c = JSON.parse(await readFile(configFile(), 'utf8')) as PhoneLinkConfig
    if (!((c?.v === 1 || (c?.v === 2 && e2eKeyOf(c.e2eKey))) && c.relayUrl && relayUrlAllowed(c.relayUrl) && c.macKey && c.phoneKey)) return null
    const { push, ...rest } = c
    const target = push && typeof push === 'object' ? asPushTarget(push as unknown as Record<string, unknown>) : null
    return target ? { ...rest, push: target } : rest
  } catch {
    return null
  }
}
/** One write at a time, in call order: each goes through its own temp file, so
 *  unchained renames could land out of order and an older snapshot (without a
 *  just-seen phone frame id) could win on disk. */
let configWrites: Promise<unknown> = Promise.resolve()
const writeConfig = (c: PhoneLinkConfig): Promise<void> => {
  const w = configWrites.then(() => atomicWriteJson(configFile(), c, { mode: 0o600 }))
  configWrites = w.catch(() => {})
  return w
}

// ── transcript → events ─────────────────────────────────────────────────────

const clip = (s: string): string => Array.from(s.trim()).slice(0, EVENT_TEXT_MAX).join('')
const texts = (content: unknown): string[] =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
      : []

/** The events one transcript line carries for the owner's ear (oldest first).
 *  Tool calls / results, meta lines, compaction summaries, API errors and
 *  command wrappers carry none. */
export const phoneEventsFromLine = (line: string): PhoneEvent[] => {
  let ev: {
    type?: string
    isMeta?: boolean
    isCompactSummary?: boolean
    isApiErrorMessage?: boolean
    timestamp?: string
    message?: { content?: unknown }
    origin?: { kind?: string }
    attachment?: { type?: string; prompt?: unknown }
  }
  try {
    ev = JSON.parse(line)
  } catch {
    return []
  }
  if (!ev || ev.isMeta || ev.isCompactSummary) return []
  const t = Date.parse(ev.timestamp ?? '')
  const at = Number.isFinite(t) ? { at: t } : {}
  if (ev.type === 'assistant') {
    if (ev.isApiErrorMessage) return []
    return texts(ev.message?.content)
      .map(clip)
      .filter(Boolean)
      .map((text) => ({ kind: 'president' as const, text, ...at }))
  }
  const queued = ev.type === 'attachment' && ev.attachment?.type === 'queued_command'
  if (ev.type !== 'user' && !queued) return []
  if (ev.origin?.kind === 'task-notification') return []
  const raw = (queued ? texts(ev.attachment?.prompt) : texts(ev.message?.content)).join('\n').trim()
  if (!raw) return []
  if (promptAuthor(raw) === 'owner') return [{ kind: 'owner', text: clip(raw), ...at }]
  const kind = raw.startsWith(SUPPLY_NOTICE_PREFIX) ? 'notice' : raw.startsWith(SUPPLY_REPLY_PREFIX) ? 'commander' : null
  return kind ? [{ kind, text: clip(supplyLineBody(raw)), ...at }] : []
}

// ── projects ────────────────────────────────────────────────────────────────

export interface PhoneProject {
  id: string
  name: string
  /** A president desk is running there now. */
  desk: boolean
}

const listProjects = async (): Promise<(PhoneProject & { path: string })[]> => {
  const s = await getSettings()
  return (s.projects ?? []).map((p) => ({
    id: p.id,
    path: p.path,
    name: p.displayName || basename(p.path),
    desk: listLiveDesksIn(p.path, SUPPLY_DESK_LABEL).length > 0,
  }))
}

// ── the live link ───────────────────────────────────────────────────────────

interface LinkState {
  cfg: PhoneLinkConfig
  ws: WebSocket | null
  stopped: boolean
  backoff: number
  /** The one pending reconnect, and the tick loop. */
  retry?: ReturnType<typeof setTimeout>
  loop?: ReturnType<typeof setInterval>
  /** `start` = the rewind floor of this tail: where reading of this file
   *  began — for the first tail after a restart, where the PREVIOUS run began
   *  reading the same file (cfg.floor), so what it sent into the void before
   *  the restart is recovered and nothing older is. */
  tail: { file?: string; offset: number; projectId?: string; start?: number }
  /** No tail was opened yet since the link started (only that one may take
   *  the persisted floor). */
  firstTail: boolean
  /** The relay's answer to this connection: the position of the newest event
   *  it STORED (null = none). Applied once by pumpTranscript, then cleared. */
  resume?: Cursor | null
  /** The last resume applied: what is re-sent up to there the relay already has
   *  (and drops), so it wakes nobody — a Mac reconnect is not news. */
  pushFloor?: Cursor | null
  /** Nothing is read for the phone until the relay said where it stands. */
  resumeBy: number
  /** stopPhoneLink ran: a tick still in flight must not write the config back
   *  (it would put the old keys over a new pairing, or recreate an unpaired file). */
  retired?: boolean
  lastProjects: string
  lastProjectsAt: number
  lastHeard: number
  lastPing: number
  ticking: boolean
  /** Owner access as of the last projects refresh: a Mac that stopped being the
   *  owner (signed out) stops feeding the phone within PROJECTS_EVERY_MS. */
  access: boolean
  /** Push to Talk: when the last push went out, whether one is owed, the timer
   *  that sends it once the gap / say hold is over, and the phone says still
   *  waiting for their final ack. */
  pushedAt: number
  pushOwed: boolean
  pushing: boolean
  /** Consecutive transient failures of the owed push (see PUSH_RETRY_MAX). */
  pushRetries: number
  pushTimer?: ReturnType<typeof setTimeout>
  says: Set<{ at: number }>
  /** Assistant frames that found the relay socket closed (its answers carry no
   *  transcript position, so nothing else would ever send them). Sent by tick
   *  once the socket is back; capped at ASSISTANT_OUTBOX_MAX, oldest dropped. */
  assistantOutbox: Record<string, unknown>[]
  /** The phone's say ids, so the desk's `owner` echo carries the id of the say
   *  it came from (docs/PHONE_LINK.md `event`). `cur` = the transcript position
   *  it was matched to, so a resend after a reconnect carries the same id.
   *  Capped at SAY_IDS_MAX, oldest dropped. */
  sayIds: { projectId: string; text: string; id: string; cur?: string }[]
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_phone_link: LinkState | undefined
}

export interface PhoneLinkDeps {
  /** supplyNotice deps for the owner lane (tests). */
  supply?: Partial<SupplyNoticeDeps>
  /** Start the president desk of a project that has none (null = started). */
  wakeDesk?: (path: string) => Promise<string | null>
  /** The APNs key / the push itself (tests). */
  pushKey?: () => Promise<PushKey | null>
  sendPush?: (key: PushKey, target: PushTarget) => Promise<PushResult>
  /** The cross-project assistant's turn (tests). */
  assistant?: (text: string) => Promise<AssistantAnswer>
}

/** Only the primary instance (fixed port 47776) holds the link: a second server
 *  on the same ~/.openground (npm run dev:alt) would fight it for the relay's one
 *  Mac end, send every event twice and could start a twin president desk.
 *  OPENGROUND_PHONE_LINK=1 forces it on (an isolated-HOME verification server). */
export const isPhoneLinkPrimary = (): boolean =>
  process.env.OPENGROUND_PHONE_LINK === '1' || (Number(process.env.PORT) || 47776) === 47776

const newLinkState = (cfg: PhoneLinkConfig, ws: WebSocket | null): LinkState => ({
  cfg,
  ws,
  stopped: true,
  backoff: 2000,
  tail: { offset: 0 },
  lastProjects: '',
  lastProjectsAt: 0,
  lastHeard: 0,
  lastPing: 0,
  ticking: false,
  access: true,
  resumeBy: 0,
  firstTail: true,
  pushedAt: 0,
  pushOwed: false,
  pushing: false,
  pushRetries: 0,
  says: new Set(),
  assistantOutbox: [],
  sayIds: [],
})

/** `cur.f` as the relay sees it: on v2 a keyed tag (the plain one names the
 *  project and the session file), so the relay can still compare it. */
const wireCurFile = (cfg: PhoneLinkConfig, f: string): string => {
  const key = cfg.v === 2 ? e2eKeyOf(cfg.e2eKey) : null
  return key ? sealTag(key, 'cur', f) : f
}

/** Every sealed Mac → phone frame carries `sent`: strictly increasing, so the
 *  phone can tell an old `projects` the relay plays again from the newest. */
let lastSent = 0
const nextSent = (): number => (lastSent = Math.max(lastSent + 1, Date.now()))

/** What the relay gets for a frame: on a v2 pairing a content frame keeps only
 *  its `type` (routing) and an event its `cur` (resend dedupe, file tagged);
 *  the rest is in `box`. Exported for tests. */
export const outerFrame = (cfg: PhoneLinkConfig, frame: Record<string, unknown>): Record<string, unknown> | null => {
  if (cfg.v !== 2 || !SEALED_TYPES.has(String(frame.type))) return frame
  const key = e2eKeyOf(cfg.e2eKey)
  if (!key) return null // fail closed: a v2 pairing never sends words in plain
  const { cur: rawCur, ...inner } = frame
  const cur = asCursor(rawCur)
  inner.sent = nextSent()
  // An event's own mark, inside (`id` stays the say id of an owner echo): the
  // relay can re-send a stored event under a new `seq`, and the phone skips one
  // whose `eid` it already read. From the transcript position, so a Mac resend
  // of the same line carries the same `eid`.
  // The assistant's own frames get one too (random: the relay never stores them,
  // but a phone that hears one twice — a reconnect overlap — still skips it).
  if (frame.type === 'event' || frame.type === 'assistant') inner.eid = cur ? sealTag(key, 'eid', `${cur.f}:${cur.o}:${cur.i}`) : randomBytes(16).toString('base64url')
  return { type: frame.type, box: seal(key, 'm2p', inner), ...(cur ? { cur: { ...cur, f: sealTag(key, 'cur', cur.f) } } : {}) }
}

const send = (st: LinkState, frame: Record<string, unknown>): boolean => {
  // Work mode: nothing goes out — not even in the moment before tick cuts the
  // socket (an ack, a project list, the rest of a pump in flight).
  if (st.ws?.readyState !== WebSocket.OPEN || isLockdownEnabledSync()) return false
  const out = outerFrame(st.cfg, frame)
  if (!out) return false
  st.ws.send(JSON.stringify(out))
  return true
}

/** Same steps as POST /api/swarm/supply: preflights, spawn (resuming the
 *  stored conversation), remember the intent. Returns an error string or null. */
const defaultWakeDesk = async (path: string): Promise<string | null> => {
  const { claudeRunPreflight } = await import('./claudePreflight')
  const { swarmEnvPreflight } = await import('./swarmEnvPreflight')
  const { spawnSwarmSupply } = await import('./swarmSupply')
  const { patchEngineIntent } = await import('./swarmEnginePersistence')
  if (!(await claudeRunPreflight()).ok) return 'claude-unavailable'
  if (!(await swarmEnvPreflight(path, { force: true, requireGit: false, requireGitRepo: false })).ok) return 'env-unavailable'
  await spawnSwarmSupply({ projectPath: path })
  await patchEngineIntent(path, { supplyDesired: true }).catch(() => {})
  return null
}

const selectedProject = async (st: LinkState) => {
  const all = await listProjects()
  // Not chosen yet (or gone): the project whose president is up — and that
  // choice is KEPT, or closing the desk would leave the phone with no project.
  const chosen = all.find((p) => p.id === st.cfg.projectId) ?? all.find((p) => p.desk)
  if (chosen && chosen.id !== st.cfg.projectId) {
    st.cfg = { ...st.cfg, projectId: chosen.id }
    if (!st.retired) await writeConfig(st.cfg).catch(() => {})
  }
  return { all, chosen }
}

const sendProjects = async (st: LinkState, force = false): Promise<void> => {
  const { all, chosen } = await selectedProject(st)
  // The assistant first: a talk partner of its own, never `selected` (its events
  // come whatever is selected — docs/PHONE_LINK.md "The assistant").
  // Its name and colour are the owner's (Settings of the floating assistant —
  // docs/ASSISTANT_DESIGN.md); unnamed, it is just "Assistant".
  const look = await readAssistantConfig()
  const assistant = {
    id: ASSISTANT_ID,
    name: look.name || pick(langOf(await getSettings()), { en: 'Assistant', ja: 'アシスタント' }),
    look: look.look,
    desk: false,
    assistant: true,
  }
  const frame = {
    type: 'projects',
    selected: chosen?.id ?? null,
    ...(st.cfg.v === 2 ? { callNote: true } : {}),
    projects: [assistant, ...all.map(({ id, name, desk }) => ({ id, name, desk }))],
  }
  const body = JSON.stringify(frame)
  if (!force && body === st.lastProjects) return
  if (send(st, frame)) st.lastProjects = body
  st.lastProjectsAt = Date.now()
}

/** Read from the end the next time: nothing before this moment is sent, and
 *  no pending resume or persisted floor can reach back past it — the floor is
 *  dropped ON DISK too, or the first read after a restart would rewind to it
 *  (work-mode talk, or talk of a project left before it was unregistered). */
const forgetTail = async (st: LinkState): Promise<void> => {
  st.tail = { offset: 0 }
  st.resume = undefined
  st.firstTail = false
  // A say not echoed yet never will be now (project left, or work mode): left
  // waiting, a later say with the same words would get its id.
  st.sayIds = st.sayIds.filter((x) => x.cur)
  const { floor: _gone, ...rest } = st.cfg
  st.cfg = rest
  if (!st.retired) await writeConfig(st.cfg).catch(() => {})
}

const persistFloor = async (st: LinkState, f: string, o: number): Promise<void> => {
  st.cfg = { ...st.cfg, floor: { f, o } }
  if (!st.retired) await writeConfig(st.cfg).catch(() => {})
}

/** Hear `projectId` from now on (no replay of its past). */
const selectProject = async (st: LinkState, projectId: string): Promise<void> => {
  st.cfg = { ...st.cfg, projectId }
  await forgetTail(st) // a pending resume / the floor spoke of the transcript we are leaving (saves projectId too)
  await sendProjects(st, true)
}

// ── waking the phone (Push to Talk, docs/PHONE_LINK.md "Waking the phone") ──

/** Send the owed push once the gap since the last one and every say hold are
 *  over (a timer comes back then). Exported for tests. */
export const flushPush = async (st: LinkState, deps: PhoneLinkDeps = {}): Promise<void> => {
  const target = st.cfg.push
  if (!st.pushOwed || st.pushing || st.retired) return
  // No token / no owner / work mode: nothing is owed (work-mode talk is never announced).
  if (!target || !st.access || isLockdownEnabledSync()) return void (st.pushOwed = false)
  const now = Date.now()
  for (const s of Array.from(st.says)) if (now - s.at >= SAY_HOLD_MAX_MS) st.says.delete(s)
  // The owner is talking or has just finished: a push would cut in with the
  // president's voice. It goes once the say's ack went out (or the hold ran out).
  const at = Math.max(st.pushedAt + PUSH_GAP_MS, ...Array.from(st.says, (s) => s.at + SAY_HOLD_MAX_MS))
  if (at > now) {
    clearTimeout(st.pushTimer)
    st.pushTimer = setTimeout(() => void flushPush(st, deps).catch(() => {}), at - now)
    st.pushTimer.unref?.()
    return
  }
  st.pushing = true
  try {
    const key = await (deps.pushKey ?? readPushKey)()
    // No key, or Apple refuses this key + token for good: not owed.
    if (!key || pushRefusal(st.cfg, key)) return void (st.pushOwed = false)
    st.pushOwed = false
    st.pushedAt = Date.now()
    const r = await (deps.sendPush ?? sendPushToTalk)(key, target)
    if (r.status === 200) st.pushRetries = 0
    else if (pushTokenGone(r)) {
      st.pushRetries = 0
      // Only the token that failed (a newer one may have come in meanwhile).
      if (st.cfg.push?.token === target.token) {
        const { push: _gone, ...rest } = st.cfg
        st.cfg = rest
        if (!st.retired) await writeConfig(st.cfg).catch(() => {})
      }
    } else if (pushRefusedForGood(r)) {
      st.pushRetries = 0
      st.cfg = { ...st.cfg, pushRefused: { reason: r.reason ?? String(r.status), token: target.token, key: pushKeyFingerprint(key) } }
      if (!st.retired) await writeConfig(st.cfg).catch(() => {})
    } else if ((pushTransient(r) || providerTokenExpired(r)) && st.pushRetries < PUSH_RETRY_MAX) {
      // Lost on the way, or our JWT too old (signed anew if Apple allows it yet):
      // owed again, sent once the gap is over (finally below).
      if (providerTokenExpired(r)) renewStaleProviderToken()
      st.pushRetries++
      st.pushOwed = true
    } else st.pushRetries = 0
    // Status and Apple's reason only — never the token or the key.
    if (r.status !== 200) console.warn(`[phone-link] push not accepted: ${r.status} ${r.reason ?? ''}`)
  } finally {
    st.pushing = false
    // Owed while this one was in flight: it waits out the gap like any other.
    if (st.pushOwed) void flushPush(st, deps).catch(() => {})
  }
}

/** Something the phone reads aloud went to the relay. */
const owePush = (st: LinkState, deps: PhoneLinkDeps): void => {
  if (!st.cfg.push) return
  st.pushOwed = true
  void flushPush(st, deps).catch(() => {})
}

/** The owner entered (or replaced) the APNs key: clear any refusal and tell the
 *  relay now, on the live socket (a restart of the link would drop the say holds). */
export const pushKeySaved = async (): Promise<void> => {
  // Entering the key (even the same one again) is the owner's "try again":
  // any stored refusal goes, on the live link and on disk.
  const st = globalThis.__openground_phone_link
  if (st) {
    const { pushRefused: _gone, ...rest } = st.cfg
    st.cfg = rest
    st.pushRetries = 0
    if (!st.retired) await writeConfig(st.cfg).catch(() => {})
    if (st.access) send(st, { type: 'push-ready', on: (await readPushKey()) !== null })
    return
  }
  const cfg = await readPhoneLinkConfig()
  if (cfg?.pushRefused) {
    const { pushRefused: _gone, ...rest } = cfg
    await writeConfig(rest).catch(() => {}) // the key is saved; a stale refusal only waits for the next save
  }
}

const ASSISTANT_OUTBOX_MAX = 20
const SAY_IDS_MAX = 20

/** Characters claude's transcript drops when they stand alone (zero-width
 *  space, lone ZWJ, variation selectors incl. IVS, soft hyphen, LRM, tag
 *  characters, U+3164 …, measured on a real claude PTY): gone from BOTH sides
 *  before the words are compared, or the echo of such a say carries no id. */
const INVISIBLE = new RegExp('[\\p{Cf}\\p{Default_Ignorable_Code_Point}]', 'gu')
const sayKey = (s: string): string => clip(s.replace(INVISIBLE, ''))

/** The id of the phone say an `owner` line at `cur` echoes, if any: the one
 *  already matched to this position, else the oldest unmatched say of this
 *  project with the same words (the Mac typed them; compared as sayKey). */
const sayIdFor = (st: LinkState, projectId: string, text: string, cur: string): string | undefined => {
  const key = sayKey(text)
  const e =
    st.sayIds.find((x) => x.cur === cur) ?? st.sayIds.find((x) => !x.cur && x.projectId === projectId && x.text === key)
  if (e) e.cur = cur
  return e?.id
}

const isAssistantAnswer = (f: Record<string, unknown>) => (f.type === 'event' || f.type === 'assistant') && f.kind === 'assistant'

/** One line of the assistant's talk. Both shapes are sealed on v2 (outerFrame);
 *  once the phone fetches records from the Mac it gets the `assistant` frame,
 *  which the relay passes on without keeping. */
const assistantTalk = (st: LinkState, kind: 'owner' | 'assistant', body: Record<string, unknown>, id?: string): Record<string, unknown> =>
  st.cfg.v === 2 && st.cfg.assistantDirect
    ? { type: 'assistant', kind, ...body, ...(id !== undefined ? { id } : {}) }
    : { type: 'event', projectId: ASSISTANT_ID, kind, ...body, ...(id !== undefined ? { id } : {}) }

/** The plain-text budget of one `assistant-history` page: sealed and base64'd
 *  it stays under the relay's 64 KB Mac frame (memo at its 8000-character
 *  maximum included). */
const HISTORY_PAGE_BYTES = 40_000

/** The phone fetches the assistant's records from the Mac (they are kept here
 *  only): newest first, a page at a time (`before` = the oldest `at` it has),
 *  the memo and the settings with the first page. v2 only — sealed by
 *  outerFrame; a v1 (plaintext) pairing is told to pair again and gets none. */
const assistantHistory = async (st: LinkState, f: Record<string, unknown>, id: string | undefined): Promise<void> => {
  if (isLockdownEnabledSync()) return
  if (st.cfg.v !== 2) return void send(st, { type: 'assistant-history', ...(id !== undefined ? { id } : {}), error: 'pair-again' })
  const before = typeof f.before === 'number' ? f.before : undefined
  const projectId = typeof f.projectId === 'string' ? f.projectId : ASSISTANT_ID
  if (projectId !== ASSISTANT_ID && !(await listProjects()).some((p) => p.id === projectId))
    return void send(st, { type: 'assistant-history', id, projectId, error: 'no-project' })
  if (projectId === ASSISTANT_ID && !st.cfg.assistantDirect) {
    st.cfg = { ...st.cfg, assistantDirect: true }
    if (!st.retired) await writeConfig(st.cfg).catch(() => {})
  }
  const head = before === undefined && projectId === ASSISTANT_ID ? { memory: await readAssistantMemory(), ...(await readAssistantConfig()) } : {}
  const all = assistantEntriesFor(await readAssistantLog(), projectId).filter((e) => before === undefined || e.at < before)
  let bytes = Buffer.byteLength(JSON.stringify(head))
  let from = all.length
  while (from > 0) {
    const size = Buffer.byteLength(JSON.stringify(all[from - 1])) + 1
    if (from < all.length && bytes + size > HISTORY_PAGE_BYTES) break
    bytes += size
    from--
  }
  const page = { projectId, entries: all.slice(from), more: from > 0, ...head }
  send(st, { type: 'assistant-history', ...(id !== undefined ? { id } : {}), ...page })
}

/** Send an assistant frame, or keep it for the next open socket (never under
 *  work mode: what is said then is never sent). What is kept goes first, so the
 *  phone never hears an older answer after a newer one. True = it went out now. */
const sendAssistant = (st: LinkState, frame: Record<string, unknown>, deps: PhoneLinkDeps): boolean => {
  flushAssistantOutbox(st, deps)
  if (!st.assistantOutbox.length && send(st, frame)) return true
  if (!isLockdownEnabledSync()) st.assistantOutbox = [...st.assistantOutbox, frame].slice(-ASSISTANT_OUTBOX_MAX)
  return false
}

/** What the assistant said while the socket was down, in order. Exported for tests. */
export const flushAssistantOutbox = (st: LinkState, deps: PhoneLinkDeps = {}): void => {
  while (st.assistantOutbox.length && send(st, st.assistantOutbox[0])) {
    const f = st.assistantOutbox.shift()!
    if (isAssistantAnswer(f)) owePush(st, deps)
  }
}

/** A say to the assistant (phoneAssistant.ts): answered on the Mac and sent to
 *  the phone only — never typed into a desk, never shown on a screen. */
const assistantSay = async (st: LinkState, id: string | undefined, text: string, deps: PhoneLinkDeps): Promise<void> => {
  const ack = (state: 'queued' | 'delivered' | 'rejected', extra: Record<string, unknown> = {}) =>
    sendAssistant(st, { type: 'ack', ...(id !== undefined ? { id } : {}), state, ...extra }, deps)
  const line = text.trim()
  if (!line) return void ack('rejected', { reason: 'empty' })
  if (line.length > ASSISTANT_SAY_MAX) return void ack('rejected', { reason: 'too-long', max: ASSISTANT_SAY_MAX })
  // Work mode: nothing would go out, so nothing is asked either.
  if (isLockdownEnabledSync()) return
  // Full (one answering, one waiting): just `busy`, nothing queued or echoed.
  if (assistantBusy()) return void ack('rejected', { reason: 'busy' })
  // The owner has just spoken: no push until the answer is out (see flushPush).
  const hold = { at: Date.now() }
  st.says.add(hold)
  ack('queued', { projectId: ASSISTANT_ID })
  sendAssistant(st, assistantTalk(st, 'owner', { text: line, at: Date.now() }, id), deps)
  // One final ack, whatever happens after the answer came back. The phone hears
  // plain words only (plainAssistantError), never an internal message.
  // Settings unreadable: English, but the final ack still goes.
  const a = await (deps.assistant ? deps.assistant(line) : askAssistant(line, { clientId: id })).catch(async (e: unknown) =>
    plainAssistantError(e, await getSettings().then(langOf, () => 'en' as const)),
  )
  if (a instanceof AssistantFailure) {
    ack('rejected', { reason: a.reason, ...(a.reason === 'busy' ? {} : { detail: a.message }) })
    if (st.says.delete(hold)) void flushPush(st, deps).catch(() => {})
    return
  }
  ack('delivered', { projectId: ASSISTANT_ID, heard: true, ...(a.card ? { card: a.card } : {}) })
  const sent = sendAssistant(st, assistantTalk(st, 'assistant', { text: a.reply, at: Date.now() }), deps)
  st.says.delete(hold)
  if (sent) owePush(st, deps)
  else void flushPush(st, deps).catch(() => {})
}

/** One frame relayed from the phone. Exported for tests. */
export const handlePhoneFrame = async (st: LinkState, f: Record<string, unknown>, deps: PhoneLinkDeps = {}): Promise<void> => {
  const id = typeof f.id === 'string' ? f.id.slice(0, 100) : undefined
  const ack = (state: 'queued' | 'delivered' | 'rejected', extra: Record<string, unknown> = {}) =>
    send(st, { type: 'ack', ...(id !== undefined ? { id } : {}), state, ...extra })
  // The president is an owner seat: no owner access, nothing is answered.
  if (!(await hasPhoneLinkAccess())) return void ack('rejected', { reason: 'forbidden' })
  if (f.type === 'projects') return sendProjects(st, true)
  if (f.type === 'push-token') {
    const target = asPushTarget(f)
    if (target === undefined) return
    // A refusal that was the app's (topic) is tried again once the app hands its
    // token over anew — reopening the app is the fix Settings asks for.
    const { push: _old, pushRefused, ...rest } = st.cfg
    const keep = pushRefused && !refusalIsTheApp(pushRefused.reason) ? { pushRefused } : {}
    st.cfg = target ? { ...rest, ...keep, push: target } : { ...rest, ...keep }
    if (!st.retired) await writeConfig(st.cfg).catch(() => {})
    return
  }
  if (f.type === 'select') {
    // Nothing to select: the assistant's answers come whatever is selected.
    if (f.projectId === ASSISTANT_ID) return sendProjects(st, true)
    const { all, chosen } = await selectedProject(st)
    const p = all.find((x) => x.id === f.projectId)
    if (!p) return void ack('rejected', { reason: 'no-project' })
    // Already selected: keep reading where we are (nothing is dropped).
    if (p.id === chosen?.id) return sendProjects(st, true)
    return selectProject(st, p.id)
  }
  if (f.type === 'assistant-history') return assistantHistory(st, f, id)
  if (f.type === 'call-note') {
    if (isLockdownEnabledSync() || st.cfg.v !== 2 || st.retired) return
    const projectId = typeof f.projectId === 'string' ? f.projectId : ''
    if (projectId !== ASSISTANT_ID && !(await listProjects()).some((p) => p.id === projectId))
      return void ack('rejected', { reason: 'no-project' })
    if (!id || f.kind !== undefined && f.kind !== 'call' || !Number.isInteger(f.seconds) || (f.seconds as number) < 0 || (f.seconds as number) > 86_400)
      return void ack('rejected', { reason: 'bad-note', projectId })
    const seconds = f.seconds as number
    const now = Date.now()
    const endedAt = f.endedAt ?? now
    if (typeof endedAt !== 'number' || !Number.isSafeInteger(endedAt) || endedAt > now + SEALED_MAX_AGE_MS || endedAt < now - 365 * 86_400_000)
      return void ack('rejected', { reason: 'bad-note', projectId })
    const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    try {
      const entry = await appendAssistantCall(id, {
        at: endedAt, who: 'owner', via: 'phone', kind: 'call', seconds, projectId,
        text: pick(langOf(await getSettings()), { en: `Call ${duration}`, ja: `通話 ${duration}` }),
      }, f.endedAt !== undefined)
      ack('delivered', { projectId, entry })
    } catch {
      ack('rejected', { reason: 'mac-error', projectId })
    }
    return
  }
  if (f.type !== 'say') return
  const text = typeof f.text === 'string' ? f.text : ''
  if (f.projectId === ASSISTANT_ID) return assistantSay(st, id, text, deps)
  // Empty once the mode characters are dropped ('/', '!!'): it would never land.
  if (!ownerSayLine(text)) return void ack('rejected', { reason: 'empty' })
  if (ownerSayTooLong(text)) return void ack('rejected', { reason: 'too-long', max: SUPPLY_OWNER_SAY_MAX })
  const { all, chosen } = await selectedProject(st)
  const p = typeof f.projectId === 'string' ? all.find((x) => x.id === f.projectId) : chosen
  if (!p) return void ack('rejected', { reason: 'no-project' })
  // Saying to another project selects it — otherwise its answer is never heard.
  if (p.id !== chosen?.id) await selectProject(st, p.id)
  // No push until this say's final ack went out (see flushPush).
  const hold = { at: Date.now() }
  st.says.add(hold)
  const release = () => {
    if (st.says.delete(hold)) void flushPush(st, deps).catch(() => {})
  }
  let starting = false
  if (!p.desk) {
    const err = await (deps.wakeDesk ?? defaultWakeDesk)(p.path).catch((e) => String(e?.message ?? e))
    if (err) {
      ack('rejected', { reason: 'desk-failed', detail: err.slice(0, 200) })
      return release()
    }
    starting = true
  }
  ack('queued', { projectId: p.id, ...(starting ? { desk: 'starting' } : {}) })
  const said: LinkState['sayIds'][number] | undefined = id !== undefined ? { projectId: p.id, text: sayKey(ownerSayLine(text)), id } : undefined
  if (said) st.sayIds = [...st.sayIds, said].slice(-SAY_IDS_MAX)
  await queueSupplyOwnerSay(
    p.path,
    text,
    (heard) => {
      // The box was found emptied (sent or cleared — unknown): not transcribed
      // yet, so a later say with the same words must not get this id.
      if (!heard && said && !said.cur) st.sayIds = st.sayIds.filter((x) => x !== said)
      ack('delivered', { projectId: p.id, heard })
      release()
    },
    deps.supply ?? {},
  ).catch((e) => {
    release()
    throw e
  })
}

/** One frame from the relay: its own `resume` (the relay never forwards a phone
 *  frame of that type), else a phone frame. Exported for tests. */
export const handleRelayFrame = async (st: LinkState, f: Record<string, unknown>, deps: PhoneLinkDeps = {}): Promise<void> => {
  if (f.type === 'resume') {
    st.resume = asCursor(f.cur)
    st.resumeBy = 0
    return
  }
  if (st.cfg.v !== 2 || f.type === 'push-token') return handlePhoneFrame(st, f, deps)
  const key = e2eKeyOf(st.cfg.e2eKey)
  const inner = key ? await unsealPhoneFrame(st, key, f) : null
  if (inner) return handlePhoneFrame(st, inner, deps)
}

let lastDropWarn = 0

/** A v2 phone frame, opened and checked — or null (dropped). Only what the
 *  phone sealed with the pairing's key opens: a frame the relay made up, altered
 *  or plays back from the Mac's own direction never does. Every frame must be
 *  fresh (ts within SEALED_MAX_AGE_MS) and its id new — a replayed `select`
 *  could otherwise steer the next say — and a say must name its project.
 *  Logs never carry the content. */
const unsealPhoneFrame = async (st: LinkState, key: Buffer, f: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
  const inner = openSealed(key, 'p2m', f.box)
  if (!inner || !(inner.type === 'say' || inner.type === 'select' || inner.type === 'projects' || inner.type === 'assistant-history' || inner.type === 'call-note')) {
    // The relay can send these at will: one line a minute, never the frame.
    if (Date.now() - lastDropWarn > 60_000) {
      console.warn(
        inner
          ? '[phone-link] dropped a phone frame that opened but has an unexpected type'
          : '[phone-link] dropped a phone frame that did not open with the pairing key',
      )
      lastDropWarn = Date.now()
    }
    return null
  }
  const id = typeof inner.id === 'string' && inner.id.length > 0 && inner.id.length <= 100 ? inner.id : null
  if (!id) return null
  const now = Date.now()
  const ts = inner.ts
  if (!(typeof ts === 'number' && Math.abs(now - ts) <= SEALED_MAX_AGE_MS)) {
    if (inner.type === 'say' || inner.type === 'call-note') send(st, { type: 'ack', id, state: 'rejected', reason: 'stale' })
    return null
  }
  const seen = Object.fromEntries(Object.entries(st.cfg.seenIds ?? {}).filter(([, t]) => typeof t === 'number' && now - t <= SEALED_MAX_AGE_MS))
  if (id in seen && inner.type !== 'call-note') return null // a second time: the first one was answered
  st.cfg = { ...st.cfg, seenIds: { ...seen, [id]: ts } }
  // On disk before it acts: a restart right after must still know this id —
  // when it cannot be saved, the frame is not acted on (fail closed).
  if (st.retired) return null
  try {
    await writeConfig(st.cfg)
  } catch {
    // Not acted on — but a say is told so, or the phone waits for nothing.
    if (inner.type === 'say' || inner.type === 'call-note') send(st, { type: 'ack', id, state: 'rejected', reason: 'mac-error' })
    return null
  }
  if (inner.type === 'say' && typeof inner.projectId !== 'string') {
    send(st, { type: 'ack', id, state: 'rejected', reason: 'no-project' })
    return null
  }
  return inner
}

/** Read the selected president's transcript from the last offset and send
 *  every new event, each tagged with its position (`cur`). The offset advances
 *  line by line past what was handed to the socket — but a socket can stay OPEN
 *  while nothing arrives (Wi-Fi / IP change, NAT drop, sleep) until the 90 s
 *  no-pong cut. So on every new connection the relay says where its newest
 *  STORED event sits (`resume`), the reader rewinds to there, and the relay drops
 *  what it already has: nothing lost, nothing told twice. Exported for tests. */
export const pumpTranscript = async (st: LinkState, deps: PhoneLinkDeps = {}): Promise<number> => {
  const { chosen } = await selectedProject(st)
  if (!chosen) return 0
  const sess = (await readSwarmSessions(chosen.path)).supply
  if (!sess) return 0
  const file = sessionJsonlPath(sess.cwd, sess.sessionId)
  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    return 0
  }
  // First sight of a project's transcript: start at its end (no replay of the
  // past). A NEW session file of the same project (a fresh desk) is read from 0.
  const fid = `${chosen.id}:${basename(file)}`
  if (st.tail.projectId !== chosen.id || !st.tail.file) {
    const prev = st.firstTail ? st.cfg.floor : undefined
    st.firstTail = false
    const floor = prev && prev.f === fid ? Math.min(prev.o, size) : size
    st.tail = { file, projectId: chosen.id, offset: size, start: floor }
    await persistFloor(st, fid, floor)
  } else if (st.tail.file !== file) {
    st.tail = { file, projectId: chosen.id, offset: 0, start: 0 }
    await persistFloor(st, fid, 0)
  } else if (size < st.tail.offset) st.tail.offset = size
  if (st.resume !== undefined) {
    // The relay speaks of the file by the tag it was sent under (v2).
    const raw = st.resume
    const r = raw && raw.f === wireCurFile(st.cfg, fid) ? { ...raw, f: fid } : raw
    st.resume = undefined
    st.pushFloor = r
    // Back to just after the newest event the relay stored — or, when it stored
    // nothing of this file, to where reading of it began — never below the floor.
    const start = st.tail.start ?? st.tail.offset
    const from = r && r.f === fid ? Math.max(r.o, start) : start
    if (from < st.tail.offset && st.tail.offset - from <= RESUME_MAX_BEHIND) st.tail.offset = from
  }
  if (size <= st.tail.offset) return 0
  const fh = await open(file, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(Math.min(size - st.tail.offset, READ_MAX))
    const { bytesRead } = await fh.read(buf, 0, buf.length, st.tail.offset)
    buf = buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
  // A line longer than READ_MAX (a pasted screenshot's base64) has no newline in
  // the window: step over the window. Its rest fails to parse and carries
  // nothing to say anyway — without this the feed would stall on it for good.
  if (buf.indexOf(0x0a) < 0) {
    if (buf.length === READ_MAX) st.tail.offset += buf.length
    return 0
  }
  const base = st.tail.offset
  let n = 0
  let at = 0
  for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, at)) {
    // '\n' never splits a UTF-8 character.
    const events = phoneEventsFromLine(buf.subarray(at, nl).toString('utf8'))
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      const sayId = ev.kind === 'owner' ? sayIdFor(st, chosen.id, ev.text, `${fid}:${base + at}:${i}`) : undefined
      if (!send(st, { type: 'event', projectId: chosen.id, ...ev, ...(sayId !== undefined ? { id: sayId } : {}), cur: { f: fid, o: base + at, i } })) return n
      n++
      // What the phone reads aloud wakes it (the owner's own words do not).
      if (events[i].kind !== 'owner' && !alreadyStored(st.pushFloor, { f: fid, o: base + at, i })) owePush(st, deps)
    }
    at = nl + 1
    st.tail.offset = base + at
  }
  return n
}

const later = (st: LinkState, ms: number) => {
  clearTimeout(st.retry)
  st.retry = setTimeout(() => connect(st), ms)
}

const connect = (st: LinkState): void => {
  if (st.stopped) return
  // A plaintext pairing past its date: no more dialing, also on a running link.
  if (st.cfg.v === 1 && Date.now() >= LEGACY_V1_UNTIL) return void (st.stopped = true)
  if (isLockdownEnabledSync()) {
    // Work mode refuses every non-Anthropic host; look again later — and what
    // is said meanwhile never leaves this Mac, not even once it is switched off.
    void forgetTail(st)
    st.assistantOutbox = []
    later(st, 60_000)
    return
  }
  const ws = new WebSocket(roomUrl(st.cfg, 'mac'), { headers: macHeaders(st.cfg) })
  st.ws = ws
  ws.on('open', () => {
    st.backoff = 2000
    st.lastHeard = Date.now()
    st.resume = undefined
    st.resumeBy = Date.now() + RESUME_WAIT_MS
    // Owner access as in tick; under work mode send() refuses (the next tick cuts).
    void (async () => {
      if (isLockdownEnabledSync()) return
      st.access = await hasPhoneLinkAccess()
      if (!st.access) return
      // The relay tells the phone it may hand over its push token only while this is on.
      send(st, { type: 'push-ready', on: (await readPushKey()) !== null })
      await sendProjects(st, true)
    })().catch(() => {})
  })
  ws.on('message', (data) => {
    st.lastHeard = Date.now()
    const s = String(data)
    if (s === 'pong') return
    let f: unknown
    try {
      f = JSON.parse(s)
    } catch {
      return
    }
    if (f && typeof f === 'object') void handleRelayFrame(st, f as Record<string, unknown>).catch(() => {})
  })
  ws.on('unexpected-response', (_req, res) => {
    // 401 = this pairing was reset elsewhere (or the keys are wrong): retrying
    // will not help, but costs nothing — slow down to the ceiling.
    if (res.statusCode === 401) st.backoff = 60_000
    ws.terminate()
  })
  ws.on('error', () => {})
  ws.on('close', (code) => {
    if (st.ws === ws) st.ws = null
    if (st.stopped) return
    // 4001 = another Mac end took the room (a second app on this pairing):
    // do not snatch it straight back. 4029 = over the relay's per-minute limit:
    // a quick redial would trip it again (push-ready / projects count) until the
    // minute turns, so wait it out; the relay resumes us from its newest event.
    const wait = code === 4001 || code === 4029 ? 60_000 : st.backoff
    later(st, wait)
    st.backoff = Math.min(Math.max(st.backoff * 2, wait), 60_000)
  })
}

/** One pass of the link loop. Exported for tests. */
export const tick = async (st: LinkState): Promise<void> => {
  if (st.ticking || st.ws?.readyState !== WebSocket.OPEN) return
  st.ticking = true
  try {
    // Work mode switched on while linked: the open socket must not keep
    // streaming the president's words out (connect waits under lockdown).
    if (isLockdownEnabledSync()) {
      st.ws.terminate()
      await forgetTail(st)
      st.assistantOutbox = [] // unsent assistant talk goes the way of the desk's
      return
    }
    const now = Date.now()
    if (now - st.lastHeard > PING_EVERY_MS * 3) {
      st.ws.terminate() // half-open socket: no pong for 90 s
      return
    }
    if (now - st.lastHeard > PING_EVERY_MS && now - st.lastPing > PING_EVERY_MS) {
      st.ws.send('ping')
      st.lastPing = now
    }
    if (now - st.lastProjectsAt > PROJECTS_EVERY_MS) {
      st.access = await hasPhoneLinkAccess()
      if (st.access) await sendProjects(st)
      else st.lastProjectsAt = now
    }
    if (st.access && now >= st.resumeBy) await pumpTranscript(st)
    if (st.access) flushAssistantOutbox(st)
  } catch {
    /* next tick */
  } finally {
    st.ticking = false
  }
}

export const stopPhoneLink = (): void => {
  const st = globalThis.__openground_phone_link
  if (!st) return
  st.stopped = true
  st.retired = true
  clearTimeout(st.retry)
  clearInterval(st.loop)
  clearTimeout(st.pushTimer)
  st.ws?.close()
  globalThis.__openground_phone_link = undefined
}

/** Boot entry (server/index.ts) and after pairing: connect if paired. */
export const startPhoneLink = async (): Promise<boolean> => {
  stopPhoneLink()
  if (!isPhoneLinkPrimary()) return false
  const cfg = await readPhoneLinkConfig()
  if (!cfg || (cfg.v === 1 && Date.now() >= LEGACY_V1_UNTIL)) return false
  // Warm the work-mode mirror first: isLockdownEnabledSync() reads false until
  // the first settings read, and at boot this can be the first one to finish.
  await getSettings()
  const st = newLinkState(cfg, null)
  st.stopped = false
  globalThis.__openground_phone_link = st
  connect(st)
  st.loop = setInterval(() => void tick(st), TAIL_TICK_MS)
  st.loop.unref?.()
  return true
}

export const phoneLinkStatus = async () => {
  const cfg = await readPhoneLinkConfig()
  const key = await readPushKey()
  const st = globalThis.__openground_phone_link
  return {
    paired: cfg !== null,
    online: st?.ws?.readyState === WebSocket.OPEN,
    relayUrl: cfg?.relayUrl ?? null,
    /** v2: the relay cannot read or forge what passes (false = pair again). */
    sealed: cfg?.v === 2,
    projectId: cfg?.projectId ?? null,
    /** Push to Talk: the APNs key's ID once the owner entered it (never the key),
     *  and whether the phone handed over a token. */
    pushKeyId: key?.keyId ?? null,
    pushPhone: !!cfg?.push,
    /** Apple refuses this key + token for good (its reason), else null. */
    pushRefused: cfg && key ? pushRefusal(cfg, key) : null,
    /** Whose fault: 'app' (token / topic — reopen the iPhone app) or 'key'. */
    pushRefusedBy: cfg && key && pushRefusal(cfg, key) ? (refusalIsTheApp(pushRefusal(cfg, key)!) ? 'app' : 'key') : null,
  }
}

/** Open the room's Mac end once (5 s): `reset` erases and retires the room;
 *  otherwise this only registers the Mac key (the room keeps the first Mac key
 *  it sees). `ok` when the relay did it — a reset of an already retired room
 *  (401) counts as done. `status` is the HTTP status the relay refused the
 *  upgrade with; absent for a network failure / DNS error / timeout / close. */
const dialRoom = (cfg: PhoneLinkConfig, reset: boolean): Promise<{ ok: boolean; status?: number }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(roomUrl(cfg, 'mac'), { headers: macHeaders(cfg) })
    let settled = false
    const done = (ok: boolean, status?: number) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      ws.terminate()
      resolve({ ok, status })
    }
    const t = setTimeout(() => done(false), 5000)
    ws.on('open', () => (reset ? ws.send(JSON.stringify({ type: 'reset' })) : done(true)))
    ws.on('unexpected-response', (_req, res) => done(reset && res.statusCode === 401, res.statusCode))
    ws.on('close', (code) => done(code === 1000))
    ws.on('error', () => done(false))
  })

export type PhoneLinkRefusal = 'lockdown' | 'relay-unreachable' | 'not-primary' | 'insecure-relay'

/** The keys travel in a header: only an https relay — or plain http on this
 *  machine (a local test relay). */
export const relayUrlAllowed = (u: string): boolean => {
  try {
    const { protocol, hostname } = new URL(u)
    return protocol === 'https:' || (protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname))
  } catch {
    return false
  }
}

/** New keys (the old phone stops working), saved and connected. The old room is
 *  erased first, and the new one registered to this Mac before the code is
 *  handed out. Refused (nothing changes) when either cannot be done. */
export const pairPhone = async (): Promise<{ code: string } | { error: PhoneLinkRefusal }> => {
  if (!isPhoneLinkPrimary()) return { error: 'not-primary' }
  if (isLockdownEnabledSync()) return { error: 'lockdown' }
  const relayUrl = process.env.OPENGROUND_PHONE_RELAY_URL || PHONE_RELAY_DEFAULT_URL
  if (!relayUrlAllowed(relayUrl)) return { error: 'insecure-relay' }
  const old = await readPhoneLinkConfig()
  stopPhoneLink()
  const cfg: PhoneLinkConfig = {
    v: 2,
    relayUrl,
    macKey: key(),
    phoneKey: key(),
    e2eKey: key(),
    ...(old?.projectId ? { projectId: old.projectId } : {}),
  }
  // The new room first (the relay may refuse it: no app key), then the old phone
  // is cut off — and only then is the new code handed out. Either step failing
  // leaves the old pairing as it was.
  const made = await dialRoom(cfg, false)
  if (!made.ok || (old && !(await dialRoom(old, true)).ok)) {
    // A gated relay refuses a new room without the app key (401), which the
    // owner sees only as "could not reach the relay": name that cause — but
    // only when the relay really answered the NEW room with 401. A network
    // failure, timeout or a failed reset of the old room says nothing about it.
    if (made.status === 401 && !process.env.OPENGROUND_PHONE_RELAY_APP_KEY)
      console.warn('[phone-link] pairing failed: the relay refused the new room (401) and this build has no OPENGROUND_PHONE_RELAY_APP_KEY — a relay with the gate on refuses new rooms without it (docs/PHONE_LINK.md "Security model")')
    await startPhoneLink()
    return { error: 'relay-unreachable' }
  }
  await writeConfig(cfg)
  await startPhoneLink()
  return { code: pairingCode(cfg) }
}

/** Erase and retire the room, then forget the keys. If the relay cannot be
 *  reached the pairing is KEPT (the phone is not cut off yet) and refused. */
export const unpairPhone = async (): Promise<{ ok: true } | { error: PhoneLinkRefusal }> => {
  if (!isPhoneLinkPrimary()) return { error: 'not-primary' }
  if (isLockdownEnabledSync()) return { error: 'lockdown' }
  const old = await readPhoneLinkConfig()
  if (!old) return { ok: true }
  stopPhoneLink()
  if (!(await dialRoom(old, true)).ok) {
    await startPhoneLink()
    return { error: 'relay-unreachable' }
  }
  await rm(configFile(), { force: true })
  return { ok: true }
}

/** Tests: the reconnect step (work mode is checked there first). */
export const __testConnect = (st: LinkState): void => connect(st)

export const __testLinkState = (cfg: PhoneLinkConfig, ws: { readyState: number; send: (s: string) => void }): LinkState =>
  newLinkState(cfg, ws as unknown as WebSocket)
