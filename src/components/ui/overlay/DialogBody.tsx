import { ReactNode } from 'react'

function cx(...cs: (string | false | null | undefined)[]) {
  return cs.filter(Boolean).join(' ')
}

/**
 * The scrolling content region beneath a `DialogHeader`. Owns ONLY the
 * load-bearing scroll mechanics — `min-h-0 flex-1 overflow-y-auto` — which are
 * easy to get subtly wrong (drop `min-h-0` and the body refuses to scroll inside
 * a flex column, pinning the header off-screen). Padding stays per-surface: pass
 * it via `className` (e.g. `px-6 py-4`) so each body keeps its own rhythm.
 */
export function DialogBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return <div className={cx('min-h-0 flex-1 overflow-y-auto', className)}>{children}</div>
}
