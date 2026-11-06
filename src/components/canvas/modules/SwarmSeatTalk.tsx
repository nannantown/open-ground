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
// SwarmSeatSay is the send box: other seats fold to one faint link, while the
// president's conversation stays open and sends with Enter (Shift+Enter is a
// newline). Other seats keep ⌘/Ctrl+Enter; an IME composition never sends.
// It does not know
// the route: the seat passes `onSend` (manager → /api/swarm/manager/say,
// worker → /api/sdk-session/:id/input) and shows the honest answer.

import { useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2, Square } from 'lucide-react'
import { ConversationDraftOwnerContext, type ConversationSend } from '@/lib/useConversationDraft'
import { ConversationDraftStatus } from '@/components/assistant/ConversationDraftStatus'
import { useT } from '@/i18n/I18nContext'
import { groupSdkFrames } from '@/lib/sdkTranscript'
import { EventRow, ToolCard, postFailureMessage, type Frame } from './SdkWorkerPane'
import { PresidentChatTranscript, type PresidentPublicLine } from './PresidentChatTranscript'

/** How often a seat asks for new lines, and how many it keeps. */
export const FEED_POLL_MS = 2500
export const FEED_FRAMES = 80
const CONVERSATION_FRAME_CAP = 4096
const CONVERSATION_POLL_LIMIT = 200
const FEED_START_JITTER_MS = 500

type TailBody = { frames?: Frame[]; reaped?: boolean }

/** Merge a tail answer into what the seat holds: append, newest FEED_FRAMES.
 *  Pure so the ceiling and the de-dup (a frame at or below the last seq we
 *  hold is never appended twice) are testable without a timer. */
export const mergeTail = (prev: Frame[], incoming: readonly Frame[], cap = FEED_FRAMES): Frame[] => {
  const last = prev.length ? prev[prev.length - 1].seq : 0
  const fresh = incoming.filter((f) => f.seq > last)
  if (!fresh.length) return prev
  const next = [...prev, ...fresh]
  return next.length > cap ? next.slice(next.length - cap) : next
}

export const SwarmSeatFeed = ({
  sdkSessionId,
  projectPath,
  onExit,
  conversation = false,
  conversationKey,
}: {
  sdkSessionId: string
  projectPath: string
  onExit?: () => void
  conversation?: boolean
  /** Confirmed controller conversation/epoch, unchanged by a profile handoff. */
  conversationKey?: string
}) => {
  const { t } = useT()
  const owner = useContext(ConversationDraftOwnerContext)
  const historyScope = `${owner ?? ''}\n${projectPath}`
  const boundary = useRef({ scope: historyScope, key: conversationKey, generation: 0 })
  if (boundary.current.scope !== historyScope) boundary.current = { scope: historyScope, key: conversationKey, generation: boundary.current.generation + 1 }
  else if (conversationKey !== undefined && boundary.current.key !== conversationKey) {
    // Learning the first context is not a reset. A subsequent confirmed epoch
    // change revokes old words and every in-flight read before another paint.
    boundary.current = { scope: historyScope, key: conversationKey, generation: boundary.current.generation + (boundary.current.key === undefined ? 0 : 1) }
  }
  const generation = boundary.current.generation
  const [frames, setFrames] = useState<Frame[]>([])
  const sourceKey = `${historyScope}\n${sdkSessionId}\n${generation}`
  const [frameSource, setFrameSource] = useState(sourceKey)
  const [history, setHistory] = useState<{ owner: string; path: string; session: string; generation: number; lines: PresidentPublicLine[]; overflow: boolean; revision: string } | null>(null)
  const [historyDenied, setHistoryDenied] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const [drifted, setDrifted] = useState(false)
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  useEffect(() => {
    let alive = true
    const current = () => alive && boundary.current.scope === historyScope && boundary.current.generation === generation
    let timer: ReturnType<typeof setTimeout> | undefined
    let after = 0
    setFrames([])
    setFrameSource(sourceKey)
    setHistoryDenied(false)
    setDrifted(false)
    const tick = async () => {
      let done = false
      // A hidden window reads nothing; the next visible tick catches up.
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try {
          const r = await fetch(
            `/api/sdk-session/${encodeURIComponent(sdkSessionId)}/tail?path=${encodeURIComponent(projectPath)}&after=${after}&limit=${conversation ? CONVERSATION_POLL_LIMIT : FEED_FRAMES}`,
          )
          if (!current()) return
          if (r.ok) {
            const b = (await r.json().catch(() => null)) as TailBody | null
            if (!current()) return
            const got = Array.isArray(b?.frames) ? b!.frames! : []
            if (got.length) {
              after = got[got.length - 1].seq
              setFrames((prev) => mergeTail(prev, got, conversation ? CONVERSATION_FRAME_CAP : FEED_FRAMES))
            }
            // Reaped: nothing more can arrive — keep what we have, stop asking.
            done = b?.reaped === true
          } else if (r.status === 404 || r.status === 403) {
            done = true
          }
          if (conversation && owner) {
            try {
              // Read after the tail: if it says reaped, this final snapshot
              // also contains the public words captured before that reap.
              const response = await fetch(`/api/conversation/president/history?path=${encodeURIComponent(projectPath)}&sessionId=${encodeURIComponent(sdkSessionId)}`, {
                cache: 'no-store', headers: { 'X-OpenGround-Owner': owner },
              })
              if (!current()) return
              if (response.status === 403) { setHistoryDenied(true); setHistory(null) }
              else if (response.ok) {
                const data = await response.json() as { lines?: PresidentPublicLine[]; overflow?: boolean; revision?: string }
                if (!current()) return
                if (Array.isArray(data.lines) && data.lines.every(line => (line.kind === 'input' || line.kind === 'text') && typeof line.text === 'string') && typeof data.revision === 'string') {
                  setHistoryDenied(false)
                  setHistory(previous => previous?.owner === owner && previous.path === projectPath && previous.session === sdkSessionId && previous.generation === generation && previous.revision === data.revision ? previous : { owner, path: projectPath, session: sdkSessionId, generation, lines: data.lines!, overflow: data.overflow === true, revision: data.revision! })
                }
              }
              // A retired pool entry or a temporary disconnect never erases
              // the last authorized public snapshot already on screen.
            } catch { /* Keep the last authorized words while disconnected. */ }
          }
        } catch {
          // Server reloading — ask again next tick.
        }
      }
      if (current() && done) exitRef.current?.()
      if (current() && !done) timer = setTimeout(() => void tick(), FEED_POLL_MS)
    }
    // A small random start so N seats mounted together do not poll in
    // lockstep (a burst of N requests on the one spare connection).
    // ponytail: per-seat polling; one batched tail endpoint if seats get many.
    timer = setTimeout(() => void tick(), Math.floor(Math.random() * FEED_START_JITTER_MS))
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sdkSessionId, projectPath, conversation, owner, sourceKey, historyScope, generation])

  // Follow the newest line unless the reader scrolled up (SdkWorkerPane's rule:
  // judged from the reader's own scroll, never from post-growth distance).
  const onScroll = () => {
    const el = feedRef.current
    if (el) setDrifted(el.scrollHeight - el.scrollTop - el.clientHeight >= 40)
  }
  useLayoutEffect(() => {
    const el = feedRef.current
    if (el && !drifted) el.scrollTop = el.scrollHeight
  }, [frames, drifted, history])
  const hasFrames = frames.length > 0
  useEffect(() => {
    const el = feedRef.current
    if (!conversation || !el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (!drifted) el.scrollTop = el.scrollHeight })
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [conversation, drifted, hasFrames])

  // "thought (N)" rows are furniture in a narrow seat; the full log keeps them.
  const publicHistory = history && history.owner === owner && history.path === projectPath && history.generation === generation && !historyDenied ? history : null
  // An owner-bound history read authorizes this surface. A fast tail must not
  // briefly turn its bootstrap prompt into an owner message while it waits.
  const authorized = !conversation || !owner || publicHistory?.session === sdkSessionId
  const visibleFrames = frameSource === sourceKey && !historyDenied && authorized ? frames : []
  const items = groupSdkFrames(visibleFrames.filter((x) => x.ev.kind !== 'thinking'))
  const publicLines = publicHistory && !publicHistory.overflow ? publicHistory.lines : conversation && owner && !publicHistory ? [] : undefined
  const partial = conversation && (publicHistory?.overflow || (!publicHistory && visibleFrames.length > 0 && visibleFrames[0].seq > 1))
  return (
    <div className="relative min-h-0 flex-1" data-seat-feed>
      <div ref={feedRef} onScroll={onScroll} data-president-scroll={conversation || undefined}
        className={conversation ? 'h-full overflow-y-auto overscroll-contain px-4 pb-4 pt-6 sm:px-6' : 'h-full overflow-y-auto px-3 py-2 text-meta'}>
        {partial && <p role="status" className="mx-auto mb-4 max-w-[760px] text-meta text-ink-subtle">{t('projectPanel.swarm.chat.recent')}</p>}
        {items.length === 0 && !publicLines?.length ? (
          <p className="text-ink-faint">{t('projectPanel.swarm.feed.empty')}</p>
        ) : (
          conversation ? <PresidentChatTranscript items={items} publicLines={publicLines} /> : items.map((it) =>
            it.kind === 'tool' ? <ToolCard key={it.seq} item={it} /> : <EventRow key={it.seq} ev={it.ev} t={t} />,
          )
        )}
      </div>
      {drifted ? (
        <button
          type="button"
          onClick={() => setDrifted(false)}
          className={conversation ? 'absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg-card px-3 py-1.5 text-meta text-ink-muted shadow-sm transition-colors duration-150 hover:border-line-strong hover:bg-plane hover:text-ink active:bg-ink active:text-bg disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1' : 'absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg-card px-2 py-0.5 text-micro text-ink-muted shadow-sm transition-colors duration-150 hover:border-accent hover:text-accent active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1'}
        >
          <ChevronDown size={11} strokeWidth={2} className="mr-0.5 inline-block align-[-1px]" />
          {t('projectPanel.swarm.sdk.jumpLatest')}
        </button>
      ) : null}
    </div>
  )
}

/** What a send did, in words the seat can show as-is. */
export type SeatSayResult = { ok: true; note: string; receipt?: { id?: string; state?: string } } | { ok: false; error: string; refused?: boolean }

/** A parent can retain a draft while its conversation surface is unmounted. */
export interface SeatDraftState {
  value: string
  onChange: Dispatch<SetStateAction<string>>
  pending: boolean
  onPendingChange: Dispatch<SetStateAction<boolean>>
  durable?: ReturnType<typeof import('@/lib/useConversationDraft').useConversationDraft>
}

type T = (k: string, p?: Record<string, string | number>) => string

const postJson = async (url: string, body: unknown, ownerId?: string) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ownerId ? { 'X-OpenGround-Owner': ownerId } : {}) },
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
  send?: ConversationSend,
): Promise<SeatSayResult> => {
  const { r, b } = await postJson(
    `/api/sdk-session/${encodeURIComponent(sdkSessionId)}/input?path=${encodeURIComponent(projectPath)}`,
    { text, ...(send ? { clientId: send.clientId, draftClientId: send.draftClientId, draftRevision: send.draftRevision } : {}) },
    send?.ownerId,
  )
  const receipt = b?.receipt as { id?: string; state?: string } | undefined
  if (send && r.ok && (receipt?.id !== send.clientId || typeof receipt.state !== 'string')) return { ok: false, error: t('settings.draft.pending') }
  if (send && receipt?.id === send.clientId && receipt.state === 'uncertain') return { ok: true, note: t('settings.assistant.uncertain'), receipt }
  return r.ok
    ? { ok: true, note: t(send && b?.queued === true && b.delivered !== true ? 'projectPanel.swarm.say.queued' : 'projectPanel.swarm.say.delivered'), ...(receipt ? { receipt } : {}) }
    : { ok: false, refused: r.status >= 400 && r.status < 500, error: t('projectPanel.swarm.say.failed', { error: postFailureMessage(r.status, b) }) }
}

/** The Claude president's guarded owner lane. Queueing is acceptance, even
 *  while its native input box is occupied; the server owns safe delivery. */
export const sayToPresidentPty = async (projectPath: string, terminalId: string, text: string, t: T, send?: ConversationSend): Promise<SeatSayResult> => {
  const { r, b } = await postJson('/api/swarm/supply/input', { path: projectPath, terminalId, text, ...(send ? { clientId: send.clientId, draftClientId: send.draftClientId, draftRevision: send.draftRevision } : {}) }, send?.ownerId)
  const receipt = b?.receipt as { id?: string; state?: string } | undefined
  if (send && r.ok && (receipt?.id !== send.clientId || typeof receipt.state !== 'string')) return { ok: false, error: t('settings.draft.pending') }
  if (send && receipt?.id === send.clientId && receipt.state === 'uncertain') return { ok: true, note: t('settings.assistant.uncertain'), receipt }
  if (!r.ok || b?.queued !== true) {
    return { ok: false, refused: r.status >= 400 && r.status < 500, error: t('projectPanel.swarm.say.failed', { error: postFailureMessage(r.status, b) }) }
  }
  return { ok: true, note: t(b.delivered === true ? 'projectPanel.swarm.say.delivered' : 'projectPanel.swarm.say.queued'), ...(receipt ? { receipt } : {}) }
}

/** The manager: POST /api/swarm/manager/say — the president's relay path, so
 *  an absent manager is woken exactly as a relayed sentence wakes it. */
export const sayToManager = async (projectPath: string, text: string, t: T): Promise<SeatSayResult> => {
  const { r, b } = await postJson('/api/swarm/manager/input', { path: projectPath, text })
  if (!r.ok) return { ok: false, refused: r.status >= 400 && r.status < 500, error: t('projectPanel.swarm.say.failed', { error: postFailureMessage(r.status, b) }) }
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
  'shrink-0 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors duration-150 enabled:hover:border-accent enabled:hover:bg-bg-hover enabled:hover:text-accent enabled:active:bg-accent enabled:active:text-bg-card disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1'

export const SwarmSeatSay = ({
  placeholder,
  onSend,
  alwaysOpen = false,
  disabled = false,
  draftState,
  appearance = 'compact',
  turnControl,
  presidentPath,
}: {
  placeholder: string
  onSend: (text: string, send?: ConversationSend) => Promise<SeatSayResult>
  /** The president's ordinary conversation; other seats stay folded. */
  alwaysOpen?: boolean
  disabled?: boolean
  draftState?: SeatDraftState
  appearance?: 'compact' | 'chat'
  turnControl?: { running: boolean; canStop: boolean; stopping: boolean; pending?: boolean; onStop: () => void; error?: string | null }
  presidentPath?: string
}) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [localDraft, setLocalDraft] = useState('')
  const draft = draftState?.value ?? localDraft
  const setDraft = draftState?.onChange ?? setLocalDraft
  const [localSending, setLocalSending] = useState(false)
  const sending = draftState?.pending ?? localSending
  const setSending = draftState?.onPendingChange ?? setLocalSending
  const [outcome, setOutcome] = useState<SeatSayResult | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const chat = appearance === 'chat'
  const showStop = chat && turnControl?.running && !draft.trim()
  const stopLabel = turnControl?.pending && !turnControl.stopping ? 'projectPanel.swarm.chat.confirmStop' : 'projectPanel.swarm.chat.stop'
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!chat || !box) return
    box.style.height = 'auto'
    box.style.height = `${Math.max(64, Math.min(box.scrollHeight, 200))}px`
  }, [chat, draft])

  const send = async () => {
    const sentDraft = draft
    const text = draft.trim()
    if (!text || sending || disabled || composingRef.current) return
    // Focus follows this explicit send action, never mounting the president.
    // A read-only pending box keeps keyboard focus for the next sentence.
    if (alwaysOpen) boxRef.current?.focus({ preventScroll: true })
    setSending(true)
    setOutcome(null)
    let attempt: ConversationSend | undefined
    const pendingSend = draftState?.durable?.prepareSend ? (async () => {
      attempt = await draftState.durable!.prepareSend!()
      return onSend(attempt.text.trim(), attempt)
    })() : onSend(text)
    const r = await pendingSend.catch(
      (e: unknown): SeatSayResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
    setSending(false)
    setOutcome(r)
    // Delivered ⇒ clear the sent words. The president stays conversational;
    // other seats fold back. Refused ⇒ keep the words for retry or copy.
    if (r.ok) {
      // A collapsed/remounted composer may already contain a newer draft when
      // this request finishes. Its acknowledgement clears only its own words.
      if (attempt) await draftState?.durable?.accepted?.(attempt, r.receipt)
      else setDraft(current => current === sentDraft ? '' : current)
      if (!alwaysOpen) setOpen(false)
    } else if (attempt && r.refused) draftState?.durable?.refused?.(attempt)
  }

  const note = outcome ? (
    <p role="status" className={`${chat ? 'mx-auto mt-2 w-full max-w-[760px]' : ''} text-micro ${outcome.ok ? 'text-ink-faint' : 'text-error'}`}>
      {outcome.ok ? outcome.note : outcome.error}
    </p>
  ) : null

  if (!open && !alwaysOpen) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-line-soft px-2 py-1">
        <button type="button" className={LINK_BTN} onClick={() => setOpen(true)} disabled={disabled}>
          {t('projectPanel.swarm.say.open')}
        </button>
        <div className="min-w-0 flex-1 truncate">{note}</div>
      </div>
    )
  }
  return (
    <div className={chat ? 'shrink-0 px-4 pb-4 pt-2 sm:px-6' : 'flex shrink-0 flex-col gap-1 border-t border-line-soft bg-bg-card px-2 py-1.5'} data-president-composer={chat || undefined}>
      <div className={chat ? 'mx-auto flex w-full min-w-0 max-w-[760px] flex-col gap-2 rounded-[24px] border border-line-soft bg-bg-elevated px-4 pb-3 pt-3 shadow-sm transition-colors duration-150 focus-within:border-line-strong' : 'contents'}>
      <textarea
        ref={boxRef}
        autoFocus={!alwaysOpen}
        rows={2}
        value={draft}
        disabled={disabled || (!alwaysOpen && sending)}
        readOnly={alwaysOpen && sending}
        aria-busy={sending}
        aria-label={placeholder}
        placeholder={placeholder}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onChange={(e) => {
          setDraft(e.target.value)
          if (outcome && !outcome.ok) setOutcome(null)
        }}
        onKeyDown={(e) => {
          if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Escape' && !alwaysOpen) {
            e.preventDefault()
            setOpen(false)
            return
          }
          if (e.key === 'Enter' && (alwaysOpen ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send()
          }
        }}
        className={chat ? 'max-h-[200px] w-full resize-none rounded-xl border-0 bg-transparent py-1 text-ui leading-relaxed text-ink placeholder:text-ink-faint transition-colors duration-150 hover:bg-plane/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40' : 'w-full resize-none rounded-[3px] border border-line bg-bg-inset px-1.5 py-1 text-meta text-ink placeholder:text-ink-faint transition-colors duration-150 hover:border-line-strong focus:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40'}
      />
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-micro text-ink-faint">{alwaysOpen ? null : t('projectPanel.swarm.say.keyHint')}</span>
        {!alwaysOpen && <button type="button" className={SMALL_BTN} onClick={() => setOpen(false)} disabled={sending}>
          {t('projectPanel.swarm.say.cancel')}
        </button>}
        <button
          type="button"
          className={chat ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-bg transition-colors duration-150 enabled:hover:bg-ink-muted enabled:hover:text-bg enabled:active:bg-accent enabled:active:text-bg-card disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2' : SMALL_BTN}
          onClick={() => showStop ? turnControl?.onStop() : void send()}
          disabled={showStop ? disabled || !turnControl?.canStop || turnControl?.stopping : disabled || sending || !draft.trim()}
          aria-busy={showStop ? turnControl?.stopping : sending}
          aria-label={chat ? t(showStop ? stopLabel : draftState?.durable?.attempt ? 'settings.draft.retryMessage' : 'projectPanel.swarm.say.send') : undefined}
          title={chat ? t(showStop ? stopLabel : 'projectPanel.swarm.say.send') : undefined}
        >
          {chat ? (sending || turnControl?.stopping ? <Loader2 size={17} className="animate-spin" aria-hidden /> : showStop ? <Square size={13} fill="currentColor" strokeWidth={0} aria-hidden /> : <ChevronUp size={22} strokeWidth={2.25} aria-hidden />) : t(draftState?.durable?.attempt ? 'settings.draft.retryMessage' : 'projectPanel.swarm.say.send')}
        </button>
      </div>
      </div>
      {note}
      {chat && turnControl?.error && <p role="status" className="mx-auto mt-2 max-w-[760px] text-meta text-error">{turnControl.error}</p>}
      <ConversationDraftStatus draft={draftState?.durable} presidentPath={presidentPath} />
    </div>
  )
}
