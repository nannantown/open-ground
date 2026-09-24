// SwarmSeatTalk — what an Agent Team seat is saying, and a quiet way to say
// one thing back (owner request 2026-09-24: 「働いてても何言ってるか見えない」 /
// 「命令とかも一応念のため。普段使わないけど」).
//
// SwarmSeatFeed shows an SDK desk's recent conversation — what it was told
// ('input' events), what it said, which tools it ran — and follows the newest
// line while it runs. It POLLS GET /api/sdk-session/:id/tail instead of holding
// an EventSource: every seat on the bar shows its feed at once, and one stream
// per seat is exactly the six-connection freeze streamBudget.ts documents
// (「ターミナル6枚で固まる」). A poll holds a connection for milliseconds.
//
// SwarmSeatSay is the send box: folded to one faint link, opened on purpose,
// sent only by the Send button or ⌘/Ctrl+Enter (plain Enter is a newline and
// an IME composition never sends) — hard to fire by accident. It does not know
// the route: the seat passes `onSend` (manager → /api/swarm/manager/say,
// worker → /api/sdk-session/:id/input) and shows the honest answer.

import { useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { groupSdkFrames } from '@/lib/sdkTranscript'
import { EventRow, ToolCard, postFailureMessage, type Frame } from './SdkWorkerPane'

/** How often a seat asks for new lines, and how many it keeps. */
export const FEED_POLL_MS = 2500
export const FEED_FRAMES = 80
const FEED_START_JITTER_MS = 500

type TailBody = { frames?: Frame[]; reaped?: boolean }

/** Merge a tail answer into what the seat holds: append, newest FEED_FRAMES.
 *  Pure so the ceiling and the de-dup (a frame at or below the last seq we
 *  hold is never appended twice) are testable without a timer. */
export const mergeTail = (prev: Frame[], incoming: readonly Frame[]): Frame[] => {
  const last = prev.length ? prev[prev.length - 1].seq : 0
  const fresh = incoming.filter((f) => f.seq > last)
  if (!fresh.length) return prev
  const next = [...prev, ...fresh]
  return next.length > FEED_FRAMES ? next.slice(next.length - FEED_FRAMES) : next
}

export const SwarmSeatFeed = ({
  sdkSessionId,
  projectPath,
}: {
  sdkSessionId: string
  projectPath: string
}) => {
  const { t } = useT()
  const [frames, setFrames] = useState<Frame[]>([])
  const feedRef = useRef<HTMLDivElement>(null)
  const [drifted, setDrifted] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let after = 0
    setFrames([])
    setDrifted(false)
    const tick = async () => {
      let done = false
      // A hidden window reads nothing; the next visible tick catches up.
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try {
          const r = await fetch(
            `/api/sdk-session/${encodeURIComponent(sdkSessionId)}/tail?path=${encodeURIComponent(projectPath)}&after=${after}&limit=${FEED_FRAMES}`,
          )
          if (!alive) return
          if (r.ok) {
            const b = (await r.json().catch(() => null)) as TailBody | null
            if (!alive) return
            const got = Array.isArray(b?.frames) ? b!.frames! : []
            if (got.length) {
              after = got[got.length - 1].seq
              setFrames((prev) => mergeTail(prev, got))
            }
            // Reaped: nothing more can arrive — keep what we have, stop asking.
            done = b?.reaped === true
          } else if (r.status === 404 || r.status === 403) {
            done = true
          }
        } catch {
          // Server reloading — ask again next tick.
        }
      }
      if (alive && !done) timer = setTimeout(() => void tick(), FEED_POLL_MS)
    }
    // A small random start so N seats mounted together do not poll in
    // lockstep (a burst of N requests on the one spare connection).
    // ponytail: per-seat polling; one batched tail endpoint if seats get many.
    timer = setTimeout(() => void tick(), Math.floor(Math.random() * FEED_START_JITTER_MS))
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sdkSessionId, projectPath])

  // Follow the newest line unless the reader scrolled up (SdkWorkerPane's rule:
  // judged from the reader's own scroll, never from post-growth distance).
  const onScroll = () => {
    const el = feedRef.current
    if (el) setDrifted(el.scrollHeight - el.scrollTop - el.clientHeight >= 40)
  }
  useEffect(() => {
    const el = feedRef.current
    if (el && !drifted) el.scrollTop = el.scrollHeight
  }, [frames, drifted])

  // "thought (N)" rows are furniture in a narrow seat; the full log keeps them.
  const items = groupSdkFrames(frames.filter((x) => x.ev.kind !== 'thinking'))
  return (
    <div className="relative min-h-0 flex-1" data-seat-feed>
      <div ref={feedRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-2 text-meta">
        {items.length === 0 ? (
          <p className="text-ink-faint">{t('projectPanel.swarm.feed.empty')}</p>
        ) : (
          items.map((it) =>
            it.kind === 'tool' ? <ToolCard key={it.seq} item={it} /> : <EventRow key={it.seq} ev={it.ev} t={t} />,
          )
        )}
      </div>
      {drifted ? (
        <button
          type="button"
          onClick={() => setDrifted(false)}
          className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg-card px-2 py-0.5 text-micro text-ink-muted shadow-sm transition-colors duration-150 hover:border-accent hover:text-accent active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          ↓ {t('projectPanel.swarm.sdk.jumpLatest')}
        </button>
      ) : null}
    </div>
  )
}

/** What a send did, in words the seat can show as-is. */
export type SeatSayResult = { ok: true; note: string } | { ok: false; error: string }

type T = (k: string, p?: Record<string, string | number>) => string

const postJson = async (url: string, body: unknown) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { r, b: (await r.json().catch(() => null)) as Record<string, unknown> | null }
}

/** A worker: the SDK input path (the same one the engine's rework uses). */
export const sayToWorker = async (
  projectPath: string,
  sdkSessionId: string,
  text: string,
  t: T,
): Promise<SeatSayResult> => {
  const { r, b } = await postJson(
    `/api/sdk-session/${encodeURIComponent(sdkSessionId)}/input?path=${encodeURIComponent(projectPath)}`,
    { text },
  )
  return r.ok
    ? { ok: true, note: t('projectPanel.swarm.say.delivered') }
    : { ok: false, error: t('projectPanel.swarm.say.failed', { error: postFailureMessage(r.status, b) }) }
}

/** The manager: POST /api/swarm/manager/say — the president's relay path, so
 *  an absent manager is woken exactly as a relayed sentence wakes it. */
export const sayToManager = async (projectPath: string, text: string, t: T): Promise<SeatSayResult> => {
  const { r, b } = await postJson('/api/swarm/manager/say', { path: projectPath, text })
  if (!r.ok) return { ok: false, error: t('projectPanel.swarm.say.failed', { error: postFailureMessage(r.status, b) }) }
  // held (a PTY desk mid-turn) ≠ refused (the desk closed under us): say
  // which, and keep the words either way.
  if (b?.delivered !== true) {
    return b?.heldBecause
      ? { ok: false, error: t('projectPanel.swarm.say.held') }
      : { ok: false, error: t('projectPanel.swarm.say.failed', { error: typeof b?.error === 'string' ? b.error : 'not accepted' }) }
  }
  return { ok: true, note: t(b.woke === true ? 'projectPanel.swarm.say.woke' : 'projectPanel.swarm.say.delivered') }
}

const LINK_BTN =
  'rounded-[3px] px-1 py-0.5 text-micro text-ink-faint underline-offset-2 transition-colors duration-150 hover:text-ink-muted hover:underline active:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1'
const SMALL_BTN =
  'shrink-0 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors duration-150 enabled:hover:border-accent enabled:hover:text-accent enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1'

export const SwarmSeatSay = ({
  placeholder,
  onSend,
}: {
  placeholder: string
  onSend: (text: string) => Promise<SeatSayResult>
}) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<SeatSayResult | null>(null)

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setOutcome(null)
    const r = await onSend(text).catch(
      (e: unknown): SeatSayResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
    setSending(false)
    setOutcome(r)
    // Delivered ⇒ fold back. Refused ⇒ the words stay, to re-send or copy.
    if (r.ok) {
      setDraft('')
      setOpen(false)
    }
  }

  const note = outcome ? (
    <p role="status" className={`text-micro ${outcome.ok ? 'text-ink-faint' : 'text-error'}`}>
      {outcome.ok ? outcome.note : outcome.error}
    </p>
  ) : null

  if (!open) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-line-soft px-2 py-1">
        <button type="button" className={LINK_BTN} onClick={() => setOpen(true)}>
          {t('projectPanel.swarm.say.open')}
        </button>
        <div className="min-w-0 flex-1 truncate">{note}</div>
      </div>
    )
  }
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-line-soft bg-bg-card px-2 py-1.5">
      <textarea
        autoFocus
        rows={2}
        value={draft}
        disabled={sending}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value)
          if (outcome && !outcome.ok) setOutcome(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            return
          }
          // Only ⌘/Ctrl+Enter sends; never mid-IME-composition.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
        className="w-full resize-none rounded-[3px] border border-line bg-bg-inset px-1.5 py-1 text-meta text-ink placeholder:text-ink-faint transition-colors duration-150 hover:border-line-strong focus:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
      />
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-micro text-ink-faint">{t('projectPanel.swarm.say.keyHint')}</span>
        <button type="button" className={SMALL_BTN} onClick={() => setOpen(false)} disabled={sending}>
          {t('projectPanel.swarm.say.cancel')}
        </button>
        <button
          type="button"
          className={SMALL_BTN}
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          aria-busy={sending}
        >
          {t('projectPanel.swarm.say.send')}
        </button>
      </div>
      {note}
    </div>
  )
}
