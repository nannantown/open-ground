import { X } from 'lucide-react'
import { Btn, type BtnSize } from '@/components/ui/Btn'

/** The single "✕ close" affordance for overlay headers — always top-right, an
 *  icon button on the shared `Btn variant="icon"` base (so hover / active /
 *  disabled / focus-visible states match every other icon button). Replaces the
 *  per-surface hand-rolled `<button><X/></button>` blocks that each picked their
 *  own padding + hover colour. Provide a translated `label` for the
 *  aria-label/title (defaults are intentionally absent so callers stay i18n'd). */
export function CloseButton({
  onClick,
  label,
  size = 'sm',
  className,
  disabled,
}: {
  onClick: () => void
  /** aria-label + title — pass the translated "Close" string. */
  label: string
  size?: BtnSize
  className?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <Btn
      variant="icon"
      size={size}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={className}
      disabled={disabled}
    >
      <X size={16} />
    </Btn>
  )
}
