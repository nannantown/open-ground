// The OPEN GROUND wordmark, inlined so it inherits currentColor (the shipped
// SVG carries a fixed near-black fill, which disappears on the dark instrument
// theme). Imported at build time (?raw) with the root fill swapped for
// currentColor, so both light/dark render it in the surrounding text colour
// (callers pass text-ink).
//
// ⚠ The asset lives HERE (src/…/brand/), not in public/brand/: Vite REFUSES
// `?raw` imports from the public dir in dev — the Toolbar crashed on every dev
// boot while `vite build` shipped fine, which is exactly the packaged-vs-dev
// split the 掟 warns about (caught 2026-08-03 on the dev server, invisible in
// the green build). public/brand/openground-wordmark.svg still exists for
// URL consumers (landing, docs); a wordmark redesign must update BOTH copies.
import raw from './brand/openground-wordmark.svg?raw'

const INLINE = raw.replace('fill="#231916"', 'fill="currentColor"')

export const OpenGroundWordmark = ({ className = '' }: { className?: string }) => (
  <span
    aria-hidden
    className={className}
    // Static build-time asset (our own repo file), never user content.
    dangerouslySetInnerHTML={{ __html: INLINE }}
  />
)
