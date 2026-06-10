import { useEffect, useRef } from 'react'
import {
  CheckCircle2,
  MessageSquareText,
  RotateCcw,
} from 'lucide-react'
import type { CanvasElement } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'

interface Props {
  element: CanvasElement
  selected: boolean
  editing: boolean
  /** Forwarded to the pin so the canvas can drag it like any other element. */
  onPointerDown: (e: React.PointerEvent) => void
  onChangeText: (text: string) => void
  onEditDone: () => void
  /** Toggle the resolved flag — resolved pins dim out so the canvas isn't
   *  cluttered with stale feedback, but stay clickable to revisit. */
  onToggleResolved?: () => void
  /** Short label for the element this comment is attached to, if any —
   *  shown in the popup so the user can see what they're commenting on
   *  without zooming out. */
  anchorLabel?: string | null
}

// Pin geometry, in world units. Comments are placed at (x, y) in canvas
// space; the pin's visual centre is offset upward-left so the tip of the
// drop sits exactly on the click point, like a map pin.
const PIN_W = 28
const PIN_H = 28
const POPUP_W = 280

// World-space comment pin: small circular badge plus, when open, an inline
// popup card with a textarea and a "Resolve" action. Drops into the
// CanvasElement render path so it inherits hit-testing, drag, selection,
// deletion (Backspace) and persistence for free. (Comments are annotation
// data only — the old "Run this comment" path went with the batch runner.)
export const CommentPin = ({
  element,
  selected,
  editing,
  onPointerDown,
  onChangeText,
  onEditDone,
  onToggleResolved,
  anchorLabel,
}: Props) => {
  const { t } = useT()
  const ta = useRef<HTMLTextAreaElement>(null)
  const open = editing || (selected && !!element.text)

  useEffect(() => {
    if (editing && ta.current) {
      ta.current.focus()
      ta.current.select()
    }
  }, [editing])

  const resolved = !!element.resolved

  return (
    <div
      // Pin coordinates frame the popup too; use a relative wrapper so the
      // popup can absolute-position next to the pin without escaping the
      // element's left/top placement set by InfiniteCanvas.
      className="relative"
      style={{ width: PIN_W, height: PIN_H }}
    >
      <button
        type="button"
        onPointerDown={onPointerDown}
        title={element.text ? element.text : 'Comment'}
        className={[
          'group flex h-full w-full items-center justify-center rounded-full border shadow-card transition-colors',
          // Bottom-left corner is the anchor point — round-bottom-left = 0
          // makes it look like the pin's tip points at the spot it was
          // dropped on (offset is applied at the InfiniteCanvas render).
          'rounded-bl-[2px]',
          resolved
            ? 'border-line bg-bg-card/85 text-ink-faint opacity-65'
            : 'border-accent/70 bg-accent text-bg-card hover:bg-accent/90',
          selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : '',
          editing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
        ].join(' ')}
      >
        {resolved ? (
          <CheckCircle2 size={13} strokeWidth={2.25} />
        ) : (
          <MessageSquareText size={13} strokeWidth={2.25} />
        )}
      </button>

      {open && (
        <div
          // Stop pointer events from bubbling so dragging across the popup
          // doesn't kick off a canvas marquee or pan.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute left-[34px] top-0 z-20 flex flex-col gap-2 rounded-[6px] border border-line bg-bg-card p-2.5 shadow-card"
          style={{ width: POPUP_W }}
        >
          <div className="flex items-center gap-1.5 label-cap text-ink-muted">
            <MessageSquareText size={11} strokeWidth={2} />
            <span>Comment</span>
            {anchorLabel ? (
              <span
                title={`Attached to ${anchorLabel}`}
                className="ml-1 truncate rounded-[3px] bg-bg-inset px-1.5 py-[1px] font-mono text-[9.5px] normal-case tracking-normal text-ink-faint"
              >
                ↳ {anchorLabel}
              </span>
            ) : null}
            {onToggleResolved && (
              <button
                type="button"
                onClick={onToggleResolved}
                title={resolved ? 'Reopen this comment' : 'Mark as resolved'}
                className={[
                  'ml-auto flex h-5 items-center gap-1 rounded-[3px] px-1.5 text-[10.5px] normal-case tracking-normal transition-colors',
                  resolved
                    ? 'bg-bg-inset text-ink-muted hover:bg-bg-inset/80 hover:text-ink'
                    : 'text-ink-faint hover:bg-bg-inset hover:text-ink',
                ].join(' ')}
              >
                {resolved ? (
                  <>
                    <RotateCcw size={10} strokeWidth={2} /> Reopen
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={10} strokeWidth={2} /> Resolve
                  </>
                )}
              </button>
            )}
          </div>

          {editing ? (
            <textarea
              ref={ta}
              value={element.text}
              onChange={(e) => onChangeText(e.target.value)}
              onBlur={onEditDone}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                  e.preventDefault()
                  onEditDone()
                }
              }}
              placeholder={t('canvasEl.comment.placeholder')}
              rows={3}
              className="block w-full resize-none rounded-[3px] border border-line bg-bg px-2 py-1.5 text-[12.5px] leading-snug text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          ) : (
            <div className="whitespace-pre-wrap rounded-[3px] bg-bg/70 px-2 py-1.5 text-[12.5px] leading-snug text-ink">
              {element.text || <span className="text-ink-faint">No content yet</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

CommentPin.PIN_W = PIN_W
CommentPin.PIN_H = PIN_H
