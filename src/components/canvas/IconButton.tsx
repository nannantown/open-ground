// The Ground toolbar's icon button — a compact control that reads WITHOUT a
// hover. Extracted from Toolbar.tsx so sibling controls (the notification bell)
// can share the exact same 5-state styling without a Toolbar↔child import cycle.
// All five interactive states live on SEMANTIC tokens (no hardcoded colours), so
// it stays theme-agnostic:
//   default ink-muted · hover bg-inset/ink · pressed bg-inset/accent-deeper ·
//   selected(open) accent-soft/accent-deeper (AA-safe for the visible label) ·
//   disabled opacity · focus accent ring.
export const IconButton = ({
  children,
  onClick,
  title,
  label,
  active,
  disabled,
  dot,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  /** Optional permanent text label beside the icon. Present → the button reads
   *  without a hover (for icons that are ambiguous on their own: Add, the shared
   *  Join entry, Skills). Omitted → a square icon-only button for the self-evident
   *  controls (account avatar, "?" manual, settings gear, the bell). `title`/
   *  `aria-label` stay set in BOTH cases, so the tooltip/a11y name never regresses. */
  label?: string
  active?: boolean
  disabled?: boolean
  /** Small accent dot in the top-right corner — an unread/attention marker. */
  dot?: boolean
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    // Accessible name MUST contain the visible label (WCAG 2.5.3 "Label in Name")
    // — so when a label is shown it IS the a11y name; the icon-only buttons keep
    // the descriptive `title` as their name. `title` always stays the hover tooltip.
    aria-label={label ?? title}
    aria-pressed={active}
    disabled={disabled}
    className={[
      'relative flex h-7 items-center justify-center rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
      // The permanent label collapses below xl. Measured 2026-08-04: with the
      // type scale in place the Ground's right-hand cluster is 905px wide —
      // wider than a 900px window — so the gear sat 64px off-screen and the
      // app's own wordmark was squeezed to nothing. The icon and the tooltip
      // carry the meaning at narrow widths; `aria-label` is unchanged, and
      // WCAG 2.5.3 only binds when a visible label exists.
      label ? 'w-7 xl:w-auto xl:gap-1.5 xl:px-2.5' : 'w-7',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      active
        ? 'bg-accent-soft text-accent-deeper'
        : 'text-ink-muted hover:text-ink hover:bg-plane active:bg-plane active:text-accent-deeper',
    ].join(' ')}
  >
    {children}
    {label && <span className="hidden whitespace-nowrap text-ui leading-none xl:inline">{label}</span>}
    {dot && (
      <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-bg-card" />
    )}
  </button>
)
