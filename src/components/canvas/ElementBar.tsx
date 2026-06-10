import { BringToFront, Copy, SendToBack, Trash2, X } from 'lucide-react'
import type { CanvasElement } from '@/lib/types'

// Sticky-note palette — muted tones tuned to the warm paper theme.
export const STICKY_COLORS = [
  '#ECD79A', // amber (default)
  '#E3B7A4', // clay
  '#C9D2AC', // sage
  '#A9C2C9', // dusty blue
  '#D4BBCF', // mauve
  '#E2DAC6', // parchment
]

interface Props {
  element: CanvasElement
  onColor: (color: string) => void
  onBringFront: () => void
  onSendBack: () => void
  onDuplicate: () => void
  onDelete: () => void
  onClear: () => void
}

const TYPE_LABEL: Record<CanvasElement['type'], string> = {
  text: 'Text',
  sticky: 'Sticky note',
  frame: 'Frame',
  mock: 'Mock',
  comment: 'Comment',
  image: 'Image',
  screen: 'Screen',
  shape: 'Shape',
  group: 'Group',
}

// Floating bar shown when exactly one canvas element is selected: recolour
// (stickies only), duplicate (⌘D) or delete it.
export const ElementBar = ({
  element,
  onColor,
  onBringFront,
  onSendBack,
  onDuplicate,
  onDelete,
  onClear,
}: Props) => {
  const current = element.color ?? STICKY_COLORS[0]
  return (
    <div className="pointer-events-none fixed bottom-0 left-1/2 z-30 -translate-x-1/2 p-5">
      <div className="pointer-events-auto flex items-center gap-1 rounded-[3px] border border-line bg-bg-card/95 px-2 py-1.5 shadow-card-hover backdrop-blur">
        <span className="px-2 label-cap text-ink-muted">{TYPE_LABEL[element.type]}</span>

        {element.type === 'sticky' && (
          <>
            <span className="h-4 w-px bg-line-soft" />
            <div className="flex items-center gap-1 px-1">
              {STICKY_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => onColor(c)}
                  title="Note colour"
                  style={{ background: c }}
                  className={[
                    'h-[18px] w-[18px] rounded-full transition-transform hover:scale-110',
                    current === c
                      ? 'ring-2 ring-ink ring-offset-1 ring-offset-bg-card'
                      : 'ring-1 ring-black/15',
                  ].join(' ')}
                />
              ))}
            </div>
          </>
        )}

        <span className="h-4 w-px bg-line-soft" />
        <IconBtn onClick={onBringFront} title="Bring to front">
          <BringToFront size={13} />
        </IconBtn>
        <IconBtn onClick={onSendBack} title="Send to back">
          <SendToBack size={13} />
        </IconBtn>

        <span className="h-4 w-px bg-line-soft" />
        <BarButton onClick={onDuplicate} icon={<Copy size={12} />}>
          Duplicate
        </BarButton>
        <BarButton onClick={onDelete} icon={<Trash2 size={12} />} danger>
          Delete
        </BarButton>
        <span className="h-4 w-px bg-line-soft" />
        <button
          onClick={onClear}
          title="Clear selection"
          className="flex h-7 w-7 items-center justify-center rounded-sm text-ink-muted hover:bg-bg-inset hover:text-ink transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

const IconBtn = ({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
}) => (
  <button
    onClick={onClick}
    title={title}
    className="flex h-7 w-7 items-center justify-center rounded-sm text-ink-muted hover:bg-bg-inset hover:text-ink transition-colors"
  >
    {children}
  </button>
)

const BarButton = ({
  children,
  icon,
  onClick,
  danger,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  onClick: () => void
  danger?: boolean
}) => (
  <button
    onClick={onClick}
    className={[
      'flex items-center gap-1.5 rounded-[2px] px-2.5 py-1.5 label-cap transition-colors',
      danger
        ? 'text-ink-muted hover:bg-accent-soft hover:text-accent'
        : 'text-ink-muted hover:bg-bg-inset hover:text-ink',
    ].join(' ')}
  >
    {icon}
    {children}
  </button>
)
