// PersonaPanel — the Ground-level address of the Persona surface.
//
// WHY GROUND AND NOT A PROJECT TAB (2026-08-14). The Persona surface is about
// the OWNER, not a repo: its data lives in `~/.openground/` (you-corpus.md,
// persona-courses.json, persona-interview.json), so the old tab rendered the
// SAME screen on every project. It sat in the per-project tab row only because
// that is where the tab machinery was. Ground is where app-wide / owner-wide
// things live — Settings, Manual, Skills — so that is where its door belongs;
// this panel is the room behind it. (Door: the Toolbar's PersonaMark entry,
// gated in App.tsx by src/lib/persona/gate.ts.)
//
// FULL-BLEED, ON PURPOSE. PersonaModule is drawn edge-to-edge — a figure on a
// dark stage with its own corner furniture (the mark, the day's question, the
// course rail) — so this panel hands it the whole surface rather than wrapping
// it in a DialogHeader that would eat the top of the stage. What it does NOT
// give up are the two affordances every Ground panel has: Escape closes (the
// shared Overlay's own wiring, which also claims the key so the Ground
// selection beneath is not cleared as well) and a visible way back.
//
// THE WAY BACK IS THE SHARED ONE (2026-08-15). It used to be a ✕ chip in the
// TOP RIGHT, which is precisely the thing BackLink exists to stop — its own
// doc says so: "instead of each surface inventing its own (bottom-right
// Cancel, top-right ✕, …)". Every other full-screen surface in OPEN GROUND —
// the project panel, settings, the manual, a shared project — puts
// 「Ground に戻る」 top-left as a ChevronLeft + label. This one was the exception
// for no reason beyond the order things were built in, so the owner had to
// learn a second habit for one room.

import { useT } from '@/i18n/I18nContext'
import { Overlay } from '@/components/ui/overlay'
import { BackLink } from '@/components/ui/BackLink'
import { PersonaModule } from '@/components/canvas/modules/PersonaModule'

interface Props {
  open: boolean
  onClose: () => void
}

export const PersonaPanel = ({ open, onClose }: Props): JSX.Element | null => {
  const { t } = useT()
  if (!open) return null
  return (
    <Overlay
      placement="fill"
      position="fixed"
      // Top-most full-screen surface, like the Manual — the other Ground panel
      // that takes over the whole window rather than floating a card over it.
      layer="top"
      // The module paints its own `bg-deep` stage once loaded; `surface` gives
      // the brief loading state an opaque, theme-correct backdrop underneath
      // (its text is `ink-subtle`, which is made for a surface that inverts).
      backdrop="surface"
      onClose={onClose}
      aria-label={t('toolbar.persona')}
      data-testid="persona-panel"
    >
      {/* Top-LEFT, above the surface's own mark — the same place and the same
          component every other full-screen surface uses.

          ⚠ It sits on a CARD rather than bare on the stage, and that is not
          decoration: `bg-deep` is the one surface that does NOT invert with the
          theme, so BackLink's `ink-muted` would fall to ~1.5:1 in light mode
          (the measurement pinned in src/labelPlates.test.ts). The chip gives it
          a surface that does invert, so the shared affordance stays shared
          instead of being redrawn here with its own colours.
          z-30 clears the surface's own layers (its furniture is z-10 / z-20 and
          the result sheet's scrim is z-overlay-local). */}
      <div className="absolute left-4 top-4 z-30 rounded-[3px] border border-line bg-bg-card px-2.5 py-1.5 shadow-card">
        <BackLink label={t('projectPanel.backToGround')} onClick={onClose} />
      </div>
      <PersonaModule />
    </Overlay>
  )
}
