// useAssistant — the floating assistant's talk, read from and written to the
// one log on this Mac (src/lib/server/assistantMemory.ts, the same log the
// iPhone reads). The state lives in the always-mounted floating character, so
// closing the talk window never drops a line still being answered.
import { useCallback, useEffect, useRef, useState } from 'react'

export type AssistantLook = 'verm' | 'moss' | 'ochre' | 'ink'
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
  /** A plain-words reason the last line failed; '' when none. */
  error: string
  /** An answer came while the window was closed. */
  unread: boolean
  /** This Mac can listen: the mic button is offered. */
  voice: boolean
  /** true = the line is in the log now (answered, or failed after it was logged);
   *  false = it was refused before reaching the log — give it back to the input.
   *  onReply gets the answer's words, once the answer is in the log.
   *  photo = a data URL sent with the line (the line may then be empty). */
  say: (text: string, onReply?: (reply: string) => void, photo?: string) => Promise<boolean>
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
}

export const useAssistant = (open: boolean, words: AssistantWords): AssistantState => {
  const [data, setData] = useState<LogResponse | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null)
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
    setData({ entries: d.entries ?? [], name: d.name ?? '', look: d.look ?? 'verm', voice: d.voice === true })
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
    void load()
    const t = setInterval(() => void load(), OPEN_POLL_MS)
    return () => clearInterval(t)
  }, [open, load])

  const say = useCallback(
    async (text: string, onReply?: (reply: string) => void, photo?: string) => {
      const line = text.trim()
      if ((!line && !photo) || saying.current) return false
      saying.current = true
      setPending(line)
      setPendingPhoto(photo ?? null)
      setError('')
      let reply = ''
      try {
        const r = await fetch(`${API}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(photo ? { text: line, photo: photo.slice(photo.indexOf(',') + 1) } : { text: line }),
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
        reply = ((await r.json().catch(() => ({}))) as { reply?: unknown }).reply as string
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
        saying.current = false
        if (typeof reply === 'string' && reply) onReply?.(reply)
      }
    },
    [load, words],
  )

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
    error,
    unread,
    voice: data?.voice === true,
    say,
    saveLook,
  }
}
