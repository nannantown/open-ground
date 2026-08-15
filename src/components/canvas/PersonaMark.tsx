// PersonaMark — the Ground entry to the Persona screen.
//
// A FIGURE MADE OF POINTS, because that is literally what the screen behind it
// is: a person drawn by the things known about them, each one a lit point. The
// mark and the surface it opens are the same idea at two sizes, so the button
// tells you where it goes before you read the label.
//
// It replaced a `Fingerprint` glyph (2026-08-15). A fingerprint says identity in
// the passport sense — a thing you ARE, fixed, on file. This screen is the
// opposite: something that accumulates, and that the owner is building. It also
// looked like every other 13px line icon in the row, which is exactly the
// prominence problem the owner raised.
//
// IT FOLLOWS THE ARMATURE, or the door stops describing the room. The dots below
// are the joints of src/lib/persona/armature.ts, in the same order down the
// figure — head, neck, shoulders, the torso's shoulder→waist→hip taper, elbows,
// hands held a little away from the body, hips, knees, feet — plus the loose
// halo of `people`, which is the one part that is NOT on the body. When the
// armature's proportions change, this changes with them.
//
// Drawn at 24×24 with a handful of dots rather than an outline: at 18px an
// outlined body turns to mush, while a constellation stays legible — and the
// constellation is the honest picture.

interface PersonaMarkProps {
  size?: number
  /** Points that read as "known" (accent). The rest sit in the current text
   *  colour at low opacity, the same lit/unlit grammar the screen uses. */
  className?: string
}

export const PersonaMark = ({ size = 18, className }: PersonaMarkProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    className={className}
  >
    {/* head — the only shape that is not a plain dot, so the figure has a top */}
    <circle cx="12" cy="4.3" r="2.4" fill="currentColor" />
    {/* neck */}
    <circle cx="12" cy="7.2" r="0.7" fill="currentColor" opacity="0.8" />
    {/* shoulders — the widest point of the body */}
    <circle cx="9.6" cy="8.7" r="1.1" fill="currentColor" opacity="0.9" />
    <circle cx="14.4" cy="8.7" r="1.1" fill="currentColor" opacity="0.9" />
    {/* the torso taper: shoulders wide → waist in → hips out */}
    <circle cx="12" cy="9.3" r="1.2" fill="currentColor" />
    <circle cx="12" cy="11.5" r="0.95" fill="currentColor" opacity="0.88" />
    {/* elbows */}
    <circle cx="7.9" cy="11.9" r="0.9" fill="currentColor" opacity="0.7" />
    <circle cx="16.1" cy="11.9" r="0.9" fill="currentColor" opacity="0.7" />
    {/* hips */}
    <circle cx="10.4" cy="14.3" r="1" fill="currentColor" opacity="0.85" />
    <circle cx="13.6" cy="14.3" r="1" fill="currentColor" opacity="0.85" />
    {/* hands, held a little away from the body */}
    <circle cx="7.2" cy="14.7" r="0.85" fill="currentColor" opacity="0.62" />
    <circle cx="16.8" cy="14.7" r="0.85" fill="currentColor" opacity="0.62" />
    {/* knees */}
    <circle cx="10.2" cy="18" r="0.9" fill="currentColor" opacity="0.78" />
    <circle cx="13.8" cy="18" r="0.9" fill="currentColor" opacity="0.78" />
    {/* feet */}
    <circle cx="10.1" cy="21.3" r="0.85" fill="currentColor" opacity="0.62" />
    <circle cx="13.9" cy="21.3" r="0.85" fill="currentColor" opacity="0.62" />
    {/* the halo: people, which stand AROUND you rather than in you. Faint and
        off the silhouette, exactly as the figure draws them. */}
    <circle cx="3.1" cy="8.4" r="0.62" fill="currentColor" opacity="0.34" />
    <circle cx="20.9" cy="8.4" r="0.62" fill="currentColor" opacity="0.34" />
    <circle cx="2.5" cy="15.4" r="0.62" fill="currentColor" opacity="0.34" />
    <circle cx="21.5" cy="15.4" r="0.62" fill="currentColor" opacity="0.34" />
    <circle cx="4.6" cy="20.8" r="0.62" fill="currentColor" opacity="0.34" />
    <circle cx="19.4" cy="20.8" r="0.62" fill="currentColor" opacity="0.34" />
  </svg>
)
