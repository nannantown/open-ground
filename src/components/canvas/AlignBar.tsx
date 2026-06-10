import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
} from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { AlignOp } from '@/lib/canvasAlign'

interface Props {
  /** How many elements are selected — distribute needs ≥3, align needs ≥2. */
  count: number
  onAlign: (op: AlignOp) => void
}

// Floating align / distribute toolbar, shown when 2+ canvas elements are
// selected. Mounted top-centre so it clears the Layers panel (top-left) and the
// Selection Inspector (top-right). Distribute (last two) is disabled until 3+
// are selected. Each button follows the house 5-state rule (default / hover /
// active / disabled / focus-visible).
export const AlignBar = ({ count, onAlign }: Props) => {
  const { t } = useT()
  const canDistribute = count >= 3
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-[7px] border border-line bg-bg-card/95 p-1 shadow-card-hover backdrop-blur"
    >
      <Btn title={t('canvas.align.left')} onClick={() => onAlign('left')}>
        <AlignStartVertical size={15} strokeWidth={1.9} />
      </Btn>
      <Btn title={t('canvas.align.hcenter')} onClick={() => onAlign('hcenter')}>
        <AlignCenterVertical size={15} strokeWidth={1.9} />
      </Btn>
      <Btn title={t('canvas.align.right')} onClick={() => onAlign('right')}>
        <AlignEndVertical size={15} strokeWidth={1.9} />
      </Btn>

      <span className="mx-0.5 h-5 w-px bg-line-soft" />

      <Btn title={t('canvas.align.top')} onClick={() => onAlign('top')}>
        <AlignStartHorizontal size={15} strokeWidth={1.9} />
      </Btn>
      <Btn title={t('canvas.align.vmiddle')} onClick={() => onAlign('vmiddle')}>
        <AlignCenterHorizontal size={15} strokeWidth={1.9} />
      </Btn>
      <Btn title={t('canvas.align.bottom')} onClick={() => onAlign('bottom')}>
        <AlignEndHorizontal size={15} strokeWidth={1.9} />
      </Btn>

      <span className="mx-0.5 h-5 w-px bg-line-soft" />

      <Btn
        title={t('canvas.align.hdistribute')}
        onClick={() => onAlign('hdistribute')}
        disabled={!canDistribute}
      >
        <AlignHorizontalDistributeCenter size={15} strokeWidth={1.9} />
      </Btn>
      <Btn
        title={t('canvas.align.vdistribute')}
        onClick={() => onAlign('vdistribute')}
        disabled={!canDistribute}
      >
        <AlignVerticalDistributeCenter size={15} strokeWidth={1.9} />
      </Btn>
    </div>
  )
}

const Btn = ({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
    className={[
      'flex h-7 w-7 items-center justify-center rounded-[4px] text-ink-muted transition-colors',
      'hover:bg-bg-inset hover:text-ink active:bg-bg-elevated',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-muted',
    ].join(' ')}
  >
    {children}
  </button>
)
