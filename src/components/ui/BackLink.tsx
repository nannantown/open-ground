import { ChevronLeft } from 'lucide-react'

/** The single "back / close / cancel" affordance — always rendered top-left,
 *  matching the "Ground に戻る" button in the project header. Every full-screen
 *  panel (project settings, manual, share) uses this so "go back" lives in one
 *  consistent place and style (a ChevronLeft + label-cap accent link), instead
 *  of each surface inventing its own (bottom-right Cancel, top-right ✕, …).
 *
 *  Style mirrors the header's Ground-return link verbatim, with a focus-visible
 *  ring added for keyboard users (per the interactive-states rules).
 *
 *  ⚠ `tone` EXISTS SO THE STAGE DOES NOT HAVE TO INVENT ITS OWN WAY BACK.
 *  `bg-deep` is the one surface in the palette that does not invert, and
 *  `ink-muted` on it falls to ~1.5:1 in light mode (src/labelPlates.test.ts) —
 *  so the persona stage used to put this link inside a bordered chip to give it
 *  a surface that does invert. It was the same component wearing a box nothing
 *  else in the app wears, which is the very thing this file exists to prevent
 *  (owner, 2026-08-16: 「groundに戻るのデザインも他のところと違うよね なぜ同じに
 *  しない?」). `tone="onDeep"` swaps the INK for the token made for that surface
 *  and changes nothing else, so the way back is one shape everywhere. */
export function BackLink({
  label,
  onClick,
  className,
  disabled,
  tone = 'default',
}: {
  label: string
  onClick: () => void
  className?: string
  disabled?: boolean
  /** `onDeep` for the non-inverting `bg-deep` slab. Ink only — same geometry. */
  tone?: 'default' | 'onDeep'
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        // 案C `.back`: 11px / .08em / weight 400 / ink-muted. It was `label-cap`
        // in ACCENT — a red, uppercased, 10px/.18em stamp — which made the way
        // back the loudest thing in the header.
        'flex items-center gap-1 text-meta tracking-[0.08em] transition-colors',
        tone === 'onDeep'
          ? 'text-ink-onDeep/55 hover:text-ink-onDeep disabled:hover:text-ink-onDeep/55'
          : 'text-ink-muted hover:text-ink disabled:hover:text-ink-muted',
        'disabled:cursor-not-allowed disabled:opacity-40',
        'rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ChevronLeft size={11} strokeWidth={2.5} />
      {label}
    </button>
  )
}
