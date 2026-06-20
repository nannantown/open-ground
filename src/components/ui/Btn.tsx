import { ButtonHTMLAttributes, forwardRef } from 'react'

export type BtnVariant = 'primary' | 'ghost' | 'icon' | 'subtle'
export type BtnSize = 'xs' | 'sm' | 'md'

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: BtnSize
  /** primary: removes border + shadow for flat inline appearance */
  flat?: boolean
  /** icon/subtle: uses accent hover instead of ink */
  danger?: boolean
}

function c(...cs: (string | false | null | undefined)[]) {
  return cs.filter(Boolean).join(' ')
}

const BASE =
  'inline-flex items-center justify-center gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

const SIZES: Record<BtnVariant, Record<BtnSize, string>> = {
  primary: { xs: 'px-2 py-1', sm: 'px-3 py-1.5', md: 'px-4 py-1.5' },
  ghost:   { xs: 'px-1.5 py-1', sm: 'px-3 py-1.5', md: 'px-4 py-1.5' },
  icon:    { xs: 'p-0.5', sm: 'p-1', md: 'h-7 w-7' },
  subtle:  { xs: 'px-1.5 py-0.5', sm: 'px-2.5 py-1', md: 'px-3 py-1.5' },
}

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(
  ({ variant = 'ghost', size = 'sm', flat, danger, className, children, ...rest }, ref) => {
    let variantCls: string

    switch (variant) {
      case 'primary':
        variantCls = c(
          'bg-accent text-bg-card label-cap rounded-[2px] hover:bg-accent-hover active:bg-accent-deeper',
          !flat && 'border border-accent-deeper shadow-card',
        )
        break
      case 'ghost':
        variantCls =
          'border border-line bg-transparent text-ink-muted label-cap rounded-[2px] hover:border-accent hover:text-accent active:bg-bg-inset active:text-accent'
        break
      case 'icon':
        variantCls = c(
          'rounded-sm',
          danger
            ? 'text-ink-muted hover:text-accent hover:bg-accent-soft'
            : 'text-ink-muted hover:text-ink hover:bg-bg-inset',
        )
        break
      case 'subtle':
        variantCls = c(
          'label-cap rounded-[2px]',
          danger
            ? 'text-ink-muted hover:text-accent hover:bg-accent-soft'
            : 'text-ink-muted hover:text-ink hover:bg-bg-inset',
        )
        break
    }

    return (
      <button
        ref={ref}
        className={c(BASE, variantCls, SIZES[variant][size], className)}
        {...rest}
      >
        {children}
      </button>
    )
  },
)
Btn.displayName = 'Btn'
