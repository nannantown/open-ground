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
import { asCursor, type Cursor } from '../../../worker/src/phoneRelayAuth'
import { isSwarmLocalOwnerUnlocked } from './swarmGate'
import { getCustomTabRole } from './roles'

/** The relay the owner deployed (worker/wrangler.phone.jsonc). Override with
 *  OPENGROUND_PHONE_RELAY_URL at pairing time (tests, a self-hosted relay). */
export const PHONE_RELAY_DEFAULT_URL = 'https://og-phone-relay.mindbrew.workers.dev'

export interface PhoneLinkConfig {
  v: 1
  relayUrl: string
  macKey: string
  phoneKey: string
  /** The project (registry UUID) whose president the phone hears. */
  projectId?: string
  /** Where reading of the current transcript began (`f` = project:file). A
   *  resume never rewinds before it — and it survives a restart, so the first
   *  read after one cannot reach into talk the previous run never read (said
   *  while another project was selected, or under work mode). */
  floor?: { f: string; o: number }
}

export type PhoneEventKind = 'notice' | 'commander' | 'owner' | 'president'
export interface PhoneEvent {
  kind: PhoneEventKind
  text: string
  /** ms from the transcript line, when it has one. */
  at?: number
}

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

/** What the phone is given once (docs/PHONE_LINK.md §Pairing). */
export const pairingCode = (c: PhoneLinkConfig): string =>
  Buffer.from(JSON.stringify({ v: 1, url: roomUrl(c, 'phone'), key: c.phoneKey })).toString('base64url')

export const readPhoneLinkConfig = async (): Promise<PhoneLinkConfig | null> => {
  try {
    const c = JSON.parse(await readFile(configFile(), 'utf8')) as PhoneLinkConfig
    return c?.v === 1 && c.relayUrl && relayUrlAllowed(c.relayUrl) && c.macKey && c.phoneKey ? c : null
  } catch {
    return null
  }
}
const writeConfig = (c: PhoneLinkConfig) => atomicWriteJson(configFile(), c, { mode: 0o600 })

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
})

const send = (st: LinkState, frame: unknown): boolean => {
  // Work mode: nothing goes out — not even in the moment before tick cuts the
  // socket (an ack, a project list, the rest of a pump in flight).
  if (st.ws?.readyState !== WebSocket.OPEN || isLockdownEnabledSync()) return false
  st.ws.send(JSON.stringify(frame))
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
  const frame = { type: 'projects', selected: chosen?.id ?? null, projects: all.map(({ id, name, desk }) => ({ id, name, desk })) }
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

/** One frame relayed from the phone. Exported for tests. */
export const handlePhoneFrame = async (st: LinkState, f: Record<string, unknown>, deps: PhoneLinkDeps = {}): Promise<void> => {
  const id = typeof f.id === 'string' ? f.id.slice(0, 100) : undefined
  const ack = (state: 'queued' | 'delivered' | 'rejected', extra: Record<string, unknown> = {}) =>
    send(st, { type: 'ack', ...(id !== undefined ? { id } : {}), state, ...extra })
  // The president is an owner seat: no owner access, nothing is answered.
  if (!(await hasPhoneLinkAccess())) return void ack('rejected', { reason: 'forbidden' })
  if (f.type === 'projects') return sendProjects(st, true)
  if (f.type === 'select') {
    const { all, chosen } = await selectedProject(st)
    const p = all.find((x) => x.id === f.projectId)
    if (!p) return void ack('rejected', { reason: 'no-project' })
    // Already selected: keep reading where we are (nothing is dropped).
    if (p.id === chosen?.id) return sendProjects(st, true)
    return selectProject(st, p.id)
  }
  if (f.type !== 'say') return
  const text = typeof f.text === 'string' ? f.text : ''
  // Empty once the mode characters are dropped ('/', '!!'): it would never land.
  if (!ownerSayLine(text)) return void ack('rejected', { reason: 'empty' })
  if (ownerSayTooLong(text)) return void ack('rejected', { reason: 'too-long', max: SUPPLY_OWNER_SAY_MAX })
  const { all, chosen } = await selectedProject(st)
  const p = typeof f.projectId === 'string' ? all.find((x) => x.id === f.projectId) : chosen
  if (!p) return void ack('rejected', { reason: 'no-project' })
  // Saying to another project selects it — otherwise its answer is never heard.
  if (p.id !== chosen?.id) await selectProject(st, p.id)
  let starting = false
  if (!p.desk) {
    const err = await (deps.wakeDesk ?? defaultWakeDesk)(p.path).catch((e) => String(e?.message ?? e))
    if (err) return void ack('rejected', { reason: 'desk-failed', detail: err.slice(0, 200) })
    starting = true
  }
  ack('queued', { projectId: p.id, ...(starting ? { desk: 'starting' } : {}) })
  await queueSupplyOwnerSay(
    p.path,
    text,
    (heard) => void ack('delivered', { projectId: p.id, heard }),
    deps.supply ?? {},
  )
}

/** One frame from the relay: its own `resume` (the relay never forwards a phone
 *  frame of that type), else a phone frame. Exported for tests. */
export const handleRelayFrame = async (st: LinkState, f: Record<string, unknown>, deps: PhoneLinkDeps = {}): Promise<void> => {
  if (f.type !== 'resume') return handlePhoneFrame(st, f, deps)
  st.resume = asCursor(f.cur)
  st.resumeBy = 0
}

/** Read the selected president's transcript from the last offset and send
 *  every new event, each tagged with its position (`cur`). The offset advances
 *  line by line past what was handed to the socket — but a socket can stay OPEN
 *  while nothing arrives (Wi-Fi / IP change, NAT drop, sleep) until the 90 s
 *  no-pong cut. So on every new connection the relay says where its newest
 *  STORED event sits (`resume`), the reader rewinds to there, and the relay drops
 *  what it already has: nothing lost, nothing told twice. Exported for tests. */
export const pumpTranscript = async (st: LinkState): Promise<number> => {
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
    const r = st.resume
    st.resume = undefined
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
      if (!send(st, { type: 'event', projectId: chosen.id, ...events[i], cur: { f: fid, o: base + at, i } })) return n
      n++
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
  if (isLockdownEnabledSync()) {
    // Work mode refuses every non-Anthropic host; look again later — and what
    // is said meanwhile never leaves this Mac, not even once it is switched off.
    void forgetTail(st)
    later(st, 60_000)
    return
  }
  const ws = new WebSocket(roomUrl(st.cfg, 'mac'), { headers: { 'X-OG-Token': st.cfg.macKey } })
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
      if (st.access) await sendProjects(st, true)
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
    // do not snatch it straight back.
    const wait = code === 4001 ? 60_000 : st.backoff
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
  st.ws?.close()
  globalThis.__openground_phone_link = undefined
}

/** Boot entry (server/index.ts) and after pairing: connect if paired. */
export const startPhoneLink = async (): Promise<boolean> => {
  stopPhoneLink()
  if (!isPhoneLinkPrimary()) return false
  const cfg = await readPhoneLinkConfig()
  if (!cfg) return false
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
  const st = globalThis.__openground_phone_link
  return {
    paired: cfg !== null,
    online: st?.ws?.readyState === WebSocket.OPEN,
    relayUrl: cfg?.relayUrl ?? null,
    projectId: cfg?.projectId ?? null,
  }
}

/** Open the room's Mac end once (5 s): `reset` erases and retires the room;
 *  otherwise this only registers the Mac key (the room keeps the first Mac key
 *  it sees). True when the relay did it — a reset of an already retired room
 *  (401) counts as done. */
const dialRoom = (cfg: PhoneLinkConfig, reset: boolean): Promise<boolean> =>
  new Promise((resolve) => {
    const ws = new WebSocket(roomUrl(cfg, 'mac'), { headers: { 'X-OG-Token': cfg.macKey } })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      ws.terminate()
      resolve(ok)
    }
    const t = setTimeout(() => done(false), 5000)
    ws.on('open', () => (reset ? ws.send(JSON.stringify({ type: 'reset' })) : done(true)))
    ws.on('unexpected-response', (_req, res) => done(reset && res.statusCode === 401))
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
    v: 1,
    relayUrl,
    macKey: key(),
    phoneKey: key(),
    ...(old?.projectId ? { projectId: old.projectId } : {}),
  }
  // The old phone must be cut off before a new one is let in.
  if ((old && !(await dialRoom(old, true))) || !(await dialRoom(cfg, false))) {
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
  if (!(await dialRoom(old, true))) {
    await startPhoneLink()
    return { error: 'relay-unreachable' }
  }
  await rm(configFile(), { force: true })
  return { ok: true }
}

/** Tests only. */
export const __testLinkState = (cfg: PhoneLinkConfig, ws: { readyState: number; send: (s: string) => void }): LinkState =>
  newLinkState(cfg, ws as unknown as WebSocket)
