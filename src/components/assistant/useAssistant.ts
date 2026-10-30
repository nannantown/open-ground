// useAssistant — the floating assistant's talk, read from and written to the
// one log on this Mac (src/lib/server/assistantMemory.ts, the same log the
// iPhone reads). The state lives in the always-mounted floating character, so
// closing the talk window never drops a line still being answered.
import { useCallback, useEffect, useRef, useState } from 'react'

export type AssistantLook = 'verm' | 'moss' | 'ochre' | 'ink'
/** Who reads a call aloud (assistantMemory.ts ASSISTANT_VOICES): VOICEVOX made on this Mac, or the system voice. */
export type AssistantVoice = 'nemo' | 'himari' | 'system'
/** Where the pick's VOICEVOX files are (voicevox.ts); null = this Mac cannot make them. */
export type VoiceFiles = 'ready' | 'getting' | 'missing' | null
/** A proposal as the server lists it (assistantProposals.ts ShownProposal). */
export interface AssistantProposalView {
  id: string
  kind: 'card' | 'commander' | 'president'
  projectId: string
  project: string
  title: string
  body: string
  at: number
  expiresAt: number
  state: 'open' | 'done' | 'dropped' | 'expired'
  /** When it closed (absent while open). */
  closedAt?: number
}
export interface AssistantLine {
  id: string
  at: number
  who: 'owner' | 'assistant'
  text: string
  /** A photo the owner sent with the line (its kept name). */
  photo?: string
  /** The id the sender gave the line (the phone's say id, the window's own) — matches it to its state. */
  clientId?: string
  /** A call record (`通話 1:42`): not a line, never failed. */
  kind?: 'call'
  /** The app's own line (a proposal's button): not an answer to the line before it. */
  app?: boolean
  /** A president's answer retold (a passed-on message): not an answer to the line before it. */
  president?: { projectId: string; project: string }
}

/** Where the line in flight is (docs/CHAT_SPEC.md §5b): sent, taken by the Mac, being answered. */
export type LineState = 'sending' | 'delivered' | 'replying'
/** An own line that did not get through (§5b "failed"): 「未送信」 never reached the
 *  assistant, 「返事なし」 reached it and got no answer. `entryId` = it is in the log. */
export interface FailedLine {
  key: string
  text: string
  /** A data URL (kept in memory) or the log photo's URL. */
  photo?: string
  at: number
  kind: 'notSent' | 'noReply'
  entryId?: string
}
/** §5b: at most this many failed lines, each for at most a day. */
export const FAILED_MAX = 5
export const FAILED_FOR_MS = 24 * 3600_000
/** §5b: no answer this long after its turn began = 返事なし (the server gives a turn 2 min). */
export const ANSWER_WAIT_MS = 200_000
/** Refusals a resend cannot fix: the words go back into the input instead (§5b). */
const GIVE_BACK = new Set(['too-long', 'empty', 'photo-type', 'photo-too-large'])

/** The failed lines the talk shows: an owner line in the log with no answer after
 *  it (whoever sent it — the phone's too), plus the window's own lines that never
 *  reached the log; newest FAILED_MAX, within FAILED_FOR_MS, in time order.
 *  The line being answered is not in the log yet (it is written with its answer). */
export const failedLines = (lines: AssistantLine[], held: FailedLine[], now: number): FailedLine[] => {
  const talk = lines.filter((l) => l.kind !== 'call' && !l.app && !l.president)
  const logged = talk.flatMap((l, i): FailedLine[] =>
    l.who === 'owner' && talk[i + 1]?.who !== 'assistant'
      ? [{ key: l.id, entryId: l.id, text: l.text, ...(l.photo ? { photo: photoUrl(l.photo) } : {}), at: l.at, kind: 'noReply' }]
      : [],
  )
  // A held line the log has after all (a late answer, a read that failed) is the log's.
  const inLog = new Set(talk.map((l) => l.clientId).filter(Boolean))
  return [...logged, ...held.filter((f) => !inLog.has(f.key))]
    .filter((f) => now - f.at < FAILED_FOR_MS)
    .sort((a, b) => a.at - b.at)
    .slice(-FAILED_MAX)
}

/** A failed line's photo as a data URL again, to send it once more. */
export const photoData = async (src: string): Promise<string | undefined> => {
  if (src.startsWith('data:')) return src
  const blob = await fetch(src).then((r) => (r.ok ? r.blob() : null)).catch(() => null)
  if (!blob) return undefined
  return new Promise((done) => {
    const reader = new FileReader()
    reader.onload = () => done(typeof reader.result === 'string' ? reader.result : undefined)
    reader.onerror = () => done(undefined)
    reader.readAsDataURL(blob)
  })
}

/** What the server takes (assistantMemory.ts ASSISTANT_PHOTO_*). */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const photoUrl = (name: string) => `/api/phone-link/assistant/photo/${encodeURIComponent(name)}`
interface LogResponse {
  entries: AssistantLine[]
  name: string
  look: AssistantLook
  voiceChoice?: AssistantVoice
  voicevox?: VoiceFiles
  /** This Mac can listen (macOS, og-listen built): show the mic. */
  voice?: boolean
  /** The proposals the frames show. */
  proposals?: AssistantProposalView[]
}

const API = '/api/phone-link/assistant'
/** How often an open window re-reads the log (the phone talks into it too). */
const OPEN_POLL_MS = 5_000
/** A failed first read is asked again after this, doubling up to the max. */
const FIRST_RETRY_MS = 3_000
const FIRST_RETRY_MAX_MS = 60_000

export interface AssistantState {
  /** false = not the owner's machine (the routes answer 401/403), or not read yet: show nothing. */
  ready: boolean
  lines: AssistantLine[]
  name: string
  look: AssistantLook
  voiceChoice: AssistantVoice
  voicevox: VoiceFiles
  /** The owner's line still being answered (shown at once, before the log has it). */
  pending: string | null
  /** The photo (data URL) sent with the pending line, if any. */
  pendingPhoto: string | null
  /** Where the pending line is (§5b); 'replying' = the thinking row. */
  pendingState: LineState
  /** Lines that did not get through, with 再送 / 削除 (§5b). */
  failed: FailedLine[]
  /** 削除: a failed line goes (out of the log too, when it is there). */
  forget: (f: FailedLine) => Promise<void>
  /** `error` is said by a failed line's own note: the chat leaves it out (the call screen has no lines). */
  quiet: boolean
  /** What it said while looking something up for the pending line ("ちょっと待ってね"); '' when nothing. */
  interim: string
  /** A plain-words reason the last line failed; '' when none. */
  error: string
  /** An answer came while the window was closed. */
  unread: boolean
  /** The proposals the frames show (open and recently closed). */
  proposals: AssistantProposalView[]
  /** A frame's button is being answered. */
  pressing: boolean
  /** 「出す」/「送る」: carried out only with the hash of what the frame shows. */
  approve: (id: string, hash: string) => Promise<void>
  /** 「やめる」. */
  drop: (id: string) => Promise<void>
  /** This Mac can listen: the mic button is offered. */
  voice: boolean
  /** false = refused for a reason a resend cannot fix (too long, photo) — give
   *  it back to the input; true = answered, or kept as a failed line (§5b).
   *  onReply gets the answer's words and the part of them to read aloud, once
   *  the answer is in the log; onInterim each "let me look" the moment it is said.
   *  photo = a data URL sent with the line (the line may then be empty). */
  say: (text: string, onReply?: (reply: string, speak: string, said: boolean) => void, photo?: string, onInterim?: (text: string) => void, stream?: AnswerStream) => Promise<boolean>
  /** The owner stopped the reading of the last answer: what of it they heard ('' = none). */
  hush: (heard: string) => Promise<void>
  saveLook: (patch: { name?: string; look?: AssistantLook; voiceChoice?: AssistantVoice }) => Promise<boolean>
}

/** Plain words for a refused or failed line, by the server's reason. */
export interface AssistantWords {
  failed: string
  busy: string
  tooLong: string
  workMode: string
  photoType: string
  photoTooLarge: string
  proposalGone: string
}

/** The part read aloud as it is written (phoneLink's say route, `{say}` / `{hush}` lines):
 *  each piece the moment it is sure; hush = a look-up started after some went out, stop them.
 *  The answer then carries `said` — those pieces were its reading. */
export interface AnswerStream {
  say?: (piece: string) => void
  hush?: () => void
}

/** The answer of a streamed say: `{interim}` / `{say}` / `{hush}` lines as they come, then the answer (or `{error}`). */
const readAnswer = async (r: Response, onInterim: (t: string) => void, stream?: AnswerStream, onReplying?: () => void): Promise<Record<string, unknown>> => {
  if (!r.body) return ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let last: Record<string, unknown> = {}
  const take = (l: string) => {
    if (!l.trim()) return
    const o = JSON.parse(l) as Record<string, unknown>
    if (typeof o.interim === 'string') onInterim(o.interim)
    else if (typeof o.say === 'string') stream?.say?.(o.say)
    else if (o.hush === true) stream?.hush?.()
    else if (o.state === 'replying') onReplying?.()
    else last = o
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      take(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
    if (done) break
  }
  take(buf)
  return last
}

export const useAssistant = (open: boolean, words: AssistantWords): AssistantState => {
  const [data, setData] = useState<LogResponse | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null)
  const [pendingState, setPendingState] = useState<LineState>('sending')
  /** The window's failed lines that never reached the log (memory only, §5b). */
  const [held, setHeld] = useState<FailedLine[]>([])
  const [quiet, setQuiet] = useState(false)
  const entriesRef = useRef<AssistantLine[]>([])
  const [interim, setInterim] = useState('')
  const [error, setError] = useState('')
  const [unread, setUnread] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  // Only the newest read lands: an older poll answering late never rolls the talk back.
  const readSeq = useRef(0)
  // One line at a time, decided synchronously: two lines in the same tick (two
  // utterances heard back to back) must not both pass a stale `pending`.
  const saying = useRef(false)

  /** 'failed' = no answer worth keeping (network, 5xx, bad body) — worth asking again. */
  const load = useCallback(async (): Promise<'ok' | 'refused' | 'failed' | 'stale'> => {
    const n = ++readSeq.current
    const r = await fetch(`${API}/log`).catch(() => null)
    if (n !== readSeq.current) return 'stale'
    // Refused (signed out, not the owner): the talk leaves the screen.
    if (r?.status === 401 || r?.status === 403) {
      setData(null)
      return 'refused'
    }
    if (!r?.ok) return 'failed'
    const d = (await r.json().catch(() => null)) as LogResponse | null
    if (n !== readSeq.current) return 'stale'
    if (!d) return 'failed'
    entriesRef.current = d.entries ?? []
    setData({
      entries: d.entries ?? [],
      name: d.name ?? '',
      look: d.look ?? 'verm',
      voiceChoice: d.voiceChoice ?? 'nemo',
      voicevox: d.voicevox ?? null,
      voice: d.voice === true,
      proposals: Array.isArray(d.proposals) ? d.proposals : [],
    })
    return 'ok'
  }, [])

  // The first read: a server still starting (or a blip) must not hide the
  // assistant for good — ask again, backing off, until it answers or refuses.
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const first = async (wait: number) => {
      if ((await load()) !== 'failed' || stopped) return
      timer = setTimeout(() => void first(Math.min(wait * 2, FIRST_RETRY_MAX_MS)), wait)
    }
    void first(FIRST_RETRY_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [load])
  useEffect(() => {
    if (!open) return
    setUnread(false)
    // Start the assistant's session now, so the first line skips its start-up.
    void fetch(`${API}/warm`, { method: 'POST' }).catch(() => {})
    void load()
    const t = setInterval(() => void load(), OPEN_POLL_MS)
    return () => clearInterval(t)
  }, [open, load])

  const say = useCallback(
    async (text: string, onReply?: (reply: string, speak: string, said: boolean) => void, photo?: string, onInterim?: (text: string) => void, stream?: AnswerStream) => {
      const line = text.trim()
      if ((!line && !photo) || saying.current) return false
      saying.current = true
      const clientId = crypto.randomUUID()
      const at = Date.now()
      /** Where it got to when it did not get through ('' = it did). */
      let lost: '' | 'notSent' | 'noReply' = ''
      /** The server's reason, when there was one. */
      let why = ''
      const stop = new AbortController()
      let clock: ReturnType<typeof setTimeout> | undefined
      setPending(line)
      setPendingPhoto(photo ?? null)
      setPendingState('sending')
      setError('')
      setQuiet(false)
      setInterim('')
      let reply = ''
      let speak = ''
      let said = false
      try {
        lost = 'notSent'
        const r = await fetch(`${API}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: line, stream: true, clientId, ...(photo ? { photo: photo.slice(photo.indexOf(',') + 1) } : {}) }),
          signal: stop.signal,
        })
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string; detail?: string }
          const reason: Record<string, string> = {
            busy: words.busy,
            'too-long': words.tooLong,
            'work-mode': words.workMode,
            'photo-type': words.photoType,
            'photo-too-large': words.photoTooLarge,
          }
          why = j.error ?? ''
          setError(j.detail || reason[j.error ?? ''] || words.failed)
          if (GIVE_BACK.has(j.error ?? '')) {
            lost = ''
            return false
          }
          return true
        }
        // The server took it (the stream is open): delivered, until its turn begins.
        lost = 'noReply'
        setPendingState('delivered')
        const a = await readAnswer(
          r,
          (t) => {
            setInterim(t)
            onInterim?.(t)
          },
          stream,
          () => {
            setPendingState('replying')
            // The answer's clock runs from its turn, not from a wait in the queue.
            clock ??= setTimeout(() => stop.abort(), ANSWER_WAIT_MS)
          },
        )
        if (typeof a.error === 'string') {
          why = a.error
          setError((typeof a.detail === 'string' && a.detail) || (a.error === 'busy' ? words.busy : words.failed))
          if (a.error === 'busy') lost = 'notSent'
          return true
        }
        lost = ''
        reply = typeof a.reply === 'string' ? a.reply : ''
        speak = typeof a.speak === 'string' && a.speak ? a.speak : reply
        said = a.said === true
        if (!openRef.current) setUnread(true)
        return true
      } catch {
        setError(words.failed)
        return true
      } finally {
        clearTimeout(clock)
        // The log first, then drop the pending line: the line never blinks out.
        await load()
        // A kept failed line says it itself; only "wait" / "work mode" add something worth reading.
        if (lost) setQuiet(why !== 'busy' && why !== 'work-mode')
        // Not through and not in the log (refused, lost, work mode): held here as a
        // failed line — one the log has is shown from the log (failedLines).
        if (lost && !entriesRef.current.some((e) => e.clientId === clientId))
          setHeld((h) => [...h, { key: clientId, text: line, ...(photo ? { photo } : {}), at, kind: lost as 'notSent' | 'noReply' }].slice(-FAILED_MAX))
        setPending(null)
        setPendingPhoto(null)
        setInterim('')
        saying.current = false
        if (reply) onReply?.(reply, speak, said)
      }
    },
    [load, words],
  )

  const [pressing, setPressing] = useState(false)
  /** A frame's button: the answer's list replaces the frames, then the log is read (it holds the app's line). */
  const button = useCallback(
    async (id: string, action: 'approve' | 'drop', body: object = {}) => {
      setPressing(true)
      setError('')
      try {
        const r = await fetch(`${API}/proposals/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => null)
        const j = ((await r?.json().catch(() => null)) ?? {}) as { proposals?: AssistantProposalView[]; error?: string }
        // Already carried out (the other end, or a second press of this one): no error.
        const done = j.error === 'closed' && j.proposals?.some((p) => p.id === id && p.state === 'done')
        if (!r?.ok && !done) setError(j.error === 'work-mode' ? words.workMode : r && r.status < 500 ? words.proposalGone : words.failed)
        if (Array.isArray(j.proposals)) setData((d) => (d ? { ...d, proposals: j.proposals } : d))
        await load()
      } finally {
        setPressing(false)
      }
    },
    [load, words],
  )
  const approve = useCallback((id: string, hash: string) => button(id, 'approve', { hash }), [button])
  const drop = useCallback((id: string) => button(id, 'drop'), [button])

  const forget = useCallback(
    async (f: FailedLine) => {
      setHeld((h) => h.filter((x) => x.key !== f.key))
      setError('')
      if (!f.entryId) return
      // Only that line: never the whole-talk delete (it would end a turn running now).
      await fetch(`${API}/failed/${encodeURIComponent(f.entryId)}`, { method: 'DELETE' }).catch(() => null)
      await load()
    },
    [load],
  )

  const hush = useCallback(async (heard: string) => {
    await fetch(`${API}/hush`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ heard }) }).catch(() => null)
  }, [])

  const saveLook = useCallback(
    async (patch: { name?: string; look?: AssistantLook; voiceChoice?: AssistantVoice }) => {
      const r = await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => null)
      await load()
      return !!r?.ok
    },
    [load],
  )

  return {
    ready: data !== null,
    lines: data?.entries ?? [],
    name: data?.name ?? '',
    look: data?.look ?? 'verm',
    voiceChoice: data?.voiceChoice ?? 'nemo',
    voicevox: data?.voicevox ?? null,
    pending,
    pendingPhoto,
    pendingState,
    failed: failedLines(data?.entries ?? [], held, Date.now()),
    forget,
    quiet,
    interim,
    error,
    unread,
    voice: data?.voice === true,
    proposals: data?.proposals ?? [],
    pressing,
    approve,
    drop,
    say,
    hush,
    saveLook,
  }
}
