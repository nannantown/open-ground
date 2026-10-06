// The assistant's proposals (a card / a message for a commander), each in its
// own frame just above the input — outside the talk, never cut, shortened or
// scrolled (owner decision 2026-10-06, docs/research/voice-assistant-2026-10.md
// §3.1). Its 「出す」/「送る」 button is the ONLY way one is carried out, and it
// sends back the hash of the text the frame's elements HOLD (their
// textContent), so what is carried out is what was on screen.
//
// A frame that does not fit whole in the space it is given cannot be pressed
// (the frame tells the owner to ask the president): nothing is approved with a
// part out of sight. When the layout cannot be measured, it is not pressable
// either. Closed ones (done / dropped / expired) stay faded, without buttons.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CircleCheck } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { AssistantProposalView } from './useAssistant'

/** SHA-256 hex of the shown strings joined by "\n" (server: proposalHash). */
export const hashShown = async (parts: string[]): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n')))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export const ProposalFrames = ({
  proposals,
  room,
  busy,
  onApprove,
  onDrop,
}: {
  proposals: AssistantProposalView[]
  /** The height the window has for the frames (px). */
  room: number
  busy: boolean
  onApprove: (id: string, hash: string) => Promise<void>
  onDrop: (id: string) => void
}) => {
  const { t } = useT()
  const box = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const [fits, setFits] = useState<ReadonlySet<string>>(() => new Set())
  /** The frame whose 「出す」 was just pressed: off at once (a double click sends one press). */
  const [held, setHeld] = useState('')
  const isOpen = (p: AssistantProposalView) => p.state === 'open' && p.expiresAt > now
  // Open ones as frames; of the closed ones (added, dropped, expired) only the
  // one that closed last, as one faded line — a closed one never takes the talk's
  // room (rework 3). The list is in the order made, so "last" is by when it closed
  // (one still open on the server but past its time closed at expiresAt).
  const shown = proposals.filter(isOpen)
  const closedAt = (p: AssistantProposalView) => p.closedAt ?? p.expiresAt
  const closed = proposals.filter((p) => !isOpen(p)).reduce<AssistantProposalView | undefined>((last, p) => (!last || closedAt(p) >= closedAt(last) ? p : last), undefined)

  // An open one turns faded the moment it expires.
  useEffect(() => {
    const next = Math.min(...proposals.filter((p) => p.state === 'open' && p.expiresAt > now).map((p) => p.expiresAt))
    if (!Number.isFinite(next)) return
    const id = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50)
    return () => clearTimeout(id)
  }, [proposals, now])

  // Which frames are whole inside the box's visible area, compared on screen
  // (no offsetParent to get wrong) after every layout and resize.
  const measure = useCallback(() => {
    const el = box.current
    const room = el?.clientHeight ?? 0
    const whole = new Set<string>()
    if (el && room > 0) {
      const top = el.getBoundingClientRect().top
      for (const f of Array.from(el.querySelectorAll<HTMLElement>('[data-proposal]'))) {
        const r = f.getBoundingClientRect()
        // Inside the box AND on the screen (a window running past the screen edge hides it too),
        // and no line of it cut sideways.
        const sideways = Array.from(f.querySelectorAll<HTMLElement>('[data-part]')).some((e) => e.scrollWidth > e.clientWidth + 1)
        if (r.height > 0 && !sideways && r.top >= Math.max(top, 0) - 0.5 && r.bottom <= Math.min(top + room, window.innerHeight) + 0.5) whole.add(f.dataset.proposal ?? '')
      }
    }
    setFits((cur) => (cur.size === whole.size && Array.from(whole).every((x) => cur.has(x)) ? cur : whole))
  }, [])
  useLayoutEffect(measure)
  useEffect(() => {
    window.addEventListener('resize', measure)
    // A frame or the box changing size on its own (fonts, the room it is given) is measured again too.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
    if (box.current) {
      ro?.observe(box.current)
      for (const f of Array.from(box.current.children)) ro?.observe(f)
    }
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [measure, proposals])

  if (!shown.length && !closed) return null
  const press = async (frame: HTMLElement | null, p: AssistantProposalView) => {
    if (!frame) return
    const text = (part: string) => frame.querySelector(`[data-part="${part}"]`)?.textContent ?? ''
    setHeld(p.id)
    try {
      await onApprove(p.id, await hashShown([p.kind, p.projectId, text('project'), text('title'), text('body')]))
    } finally {
      setHeld('')
    }
  }
  // Said outside the clipped box, so it is seen even when the frame is not.
  const cut = shown.some((p) => !fits.has(p.id))
  return (
    <>
    <div ref={box} data-testid="assistant-proposals" style={{ maxHeight: room }} className="flex shrink-0 flex-col gap-2 overflow-clip">
      {shown.map((p) => {
        const whole = fits.has(p.id)
        return (
          <section
            key={p.id}
            data-proposal={p.id}
            data-state="open"
            aria-label={p.kind === 'card' ? t('misc.assistant.proposalCard') : t('misc.assistant.proposalMessage')}
            className="shrink-0 rounded-[10px] border border-line-strong bg-plane px-2.5 py-2 text-ui text-ink"
          >
            <p data-part="project" className="break-words text-ink-subtle">{p.project}</p>
            {p.kind === 'card' && <p data-part="title" className="mt-0.5 break-words font-semibold">{p.title}</p>}
            <p data-part="body" className="mt-1 whitespace-pre-wrap break-words">{p.body}</p>
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => onDrop(p.id)}
                  disabled={busy}
                  className={`rounded-full border border-line-strong px-3 py-1 text-ink-subtle transition-colors duration-150 enabled:hover:border-ink-subtle enabled:hover:bg-bg enabled:hover:text-ink enabled:active:bg-line disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
                >
                  {t('misc.assistant.proposalDrop')}
                </button>
                <button
                  type="button"
                  onClick={(e) => void press(e.currentTarget.closest('section'), p)}
                  disabled={busy || !whole || held === p.id}
                  className={`rounded-full bg-accent px-3 py-1 font-medium text-ink-inverse transition-colors duration-150 enabled:hover:bg-accent-hover enabled:active:brightness-90 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
                >
                  {p.kind === 'card' ? t('misc.assistant.proposalAdd') : t('misc.assistant.proposalSend')}
                </button>
              </div>
          </section>
        )
      })}
      {closed && (
        <p data-proposal={closed.id} data-state="closed" className="flex shrink-0 items-center gap-1 px-1 text-ui text-ink-faint">
          {closed.state === 'done' && (
            <CircleCheck size={12} strokeWidth={2} role="img" aria-label={t('misc.assistant.proposalDone')} className="shrink-0 text-status-done">
              <title>{t('misc.assistant.proposalDone')}</title>
            </CircleCheck>
          )}
          <span className="min-w-0 truncate">
            {closed.project} · {closed.title || closed.body}
          </span>
        </p>
      )}
    </div>
    {cut && <p className="shrink-0 px-1 text-ui text-ink-subtle">{t('misc.assistant.proposalTooLong')}</p>}
    </>
  )
}
