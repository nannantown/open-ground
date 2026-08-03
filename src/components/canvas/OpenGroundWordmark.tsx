// The OPEN GROUND wordmark, inlined so it inherits currentColor (the shipped
// SVG carries a fixed near-black fill, which disappears on the dark instrument
// theme). The asset itself stays canonical in public/brand/ — this component
// imports it at build time (?raw) and swaps the root fill for currentColor, so
// a wordmark change lands in ONE file and both light/dark render it in the
// surrounding text colour (callers pass text-ink).
import raw from '../../../public/brand/openground-wordmark.svg?raw'

const INLINE = raw.replace('fill="#231916"', 'fill="currentColor"')

export const OpenGroundWordmark = ({ className = '' }: { className?: string }) => (
  <span
    aria-hidden
    className={className}
    // Static build-time asset (our own repo file), never user content.
    dangerouslySetInnerHTML={{ __html: INLINE }}
  />
)
