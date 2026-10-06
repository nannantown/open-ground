// useAssistant — the floating assistant's talk, read from and written to the
// one log on this Mac (src/lib/server/assistantMemory.ts, the same log the
// iPhone reads). The state lives in the always-mounted floating character, so
// closing the talk window never drops a line still being answered.
import { useCallback, useEffect, useRef, useState } from 'react'

export type AssistantLook = 'verm' | 'moss' | 'ochre' | 'ink'
/** A proposal as the server lists it (assistantProposals.ts ShownProposal). */
export interface AssistantProposalView {
  id: string
  kind: 'card' | 'commander'
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
}

/** What the server takes (assistantMemory.ts ASSISTANT_PHOTO_*). */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const photoUrl = (name: string) => `/api/phone-link/assistant/photo/${encodeURIComponent(name)}`
interface LogResponse {
  entries: AssistantLine[]
  name: string
  look: AssistantLook
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
  /** The owner's line still being answered (shown at once, before the log has it). */
  pending: string | null
  /** The photo (data URL) sent with the pending line, if any. */
  pendingPhoto: string | null
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
  /** true = the line is in the log now (answered, or failed after it was logged);
   *  false = it was refused before reaching the log — give it back to the input.
   *  onReply gets the answer's words and the part of them to read aloud, once
   *  the answer is in the log; onInterim each "let me look" the moment it is said.
   *  photo = a data URL sent with the line (the line may then be empty). */
  say: (text: string, onReply?: (reply: string, speak: string, said: boolean) => void, photo?: string, onInterim?: (text: string) => void, stream?: AnswerStream) => Promise<boolean>
  /** The owner stopped the reading of the last answer: what of it they heard ('' = none). */
  hush: (heard: string) => Promise<void>
  saveLook: (patch: { name?: string; look?: AssistantLook }) => Promise<boolean>
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
const readAnswer = async (r: Response, onInterim: (t: string) => void, stream?: AnswerStream): Promise<Record<string, unknown>> => {
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
    setData({ entries: d.entries ?? [], name: d.name ?? '', look: d.look ?? 'verm', voice: d.voice === true, proposals: Array.isArray(d.proposals) ? d.proposals : [] })
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
      setPending(line)
      setPendingPhoto(photo ?? null)
      setError('')
      setInterim('')
      let reply = ''
      let speak = ''
      let said = false
      try {
        const r = await fetch(`${API}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: line, stream: true, ...(photo ? { photo: photo.slice(photo.indexOf(',') + 1) } : {}) }),
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
          setError(j.detail || reason[j.error ?? ''] || words.failed)
          // 400 / 409 / 429 are refused before the assistant runs; a failed answer
          // (502) has already logged the owner's line — giving it back would log it twice.
          return r.status >= 500
        }
        const a = await readAnswer(
          r,
          (t) => {
            setInterim(t)
            onInterim?.(t)
          },
          stream,
        )
        if (typeof a.error === 'string') {
          setError((typeof a.detail === 'string' && a.detail) || (a.error === 'busy' ? words.busy : words.failed))
          // Refused as busy it never reached the log: give it back. Otherwise it is logged.
          return a.error !== 'busy'
        }
        reply = typeof a.reply === 'string' ? a.reply : ''
        speak = typeof a.speak === 'string' && a.speak ? a.speak : reply
        said = a.said === true
        if (!openRef.current) setUnread(true)
        return true
      } catch {
        setError(words.failed)
        return false
      } finally {
        // The log first, then drop the pending line: the line never blinks out.
        await load()
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

  const hush = useCallback(async (heard: string) => {
    await fetch(`${API}/hush`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ heard }) }).catch(() => null)
  }, [])

  const saveLook = useCallback(
    async (patch: { name?: string; look?: AssistantLook }) => {
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
    pending,
    pendingPhoto,
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
