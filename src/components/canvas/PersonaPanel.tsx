// PersonaPanel — the Ground-level address of the Persona surface.
//
// WHY GROUND AND NOT A PROJECT TAB (2026-08-14). The Persona surface is about
// the OWNER, not a repo: its data lives in `~/.openground/` (you-corpus.md,
// persona-courses.json, persona-interview.json), so the old tab rendered the
// SAME screen on every project. It sat in the per-project tab row only because
// that is where the tab machinery was. Ground is where app-wide / owner-wide
// things live — Settings, Manual, Skills — so that is where its door belongs;
// this panel is the room behind it. (Door: the Toolbar's Fingerprint entry,
// gated in App.tsx by src/lib/persona/gate.ts.)
//
// FULL-BLEED, ON PURPOSE. PersonaModule is drawn edge-to-edge — a figure on a
// dark stage with its own corner furniture (the mark, the day's question, the
// course rail) — so this panel hands it the whole surface rather than wrapping
// it in a DialogHeader that would eat the top of the stage. What it does NOT
// give up are the two affordances every Ground panel has: Escape closes (the
// shared Overlay's own wiring, which also claims the key so the Ground
// selection beneath is not cleared as well) and an explicit ✕.

import { useT } from '@/i18n/I18nContext'
import { Overlay, CloseButton } from '@/components/ui/overlay'
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
      {/* The ✕ sits on a CARD rather than bare on the stage. `bg-deep` is the
          one surface that does NOT invert with the theme, so the shared
          CloseButton's `ink-muted` would fall to ~1.5:1 in light mode — the
          measurement pinned in src/labelPlates.test.ts. The chip gives it a
          surface that does invert, so the shared affordance stays shared
          instead of being re-drawn here with different hover states.
          z-30 clears the surface's own layers (its furniture is z-10 / z-20 and
          the result sheet's scrim is z-overlay-local). */}
      <div className="absolute right-4 top-4 z-30 rounded-[3px] border border-line bg-bg-card shadow-card">
        <CloseButton onClick={onClose} label={t('common.close')} />
      </div>
      <PersonaModule />
    </Overlay>
  )
}
