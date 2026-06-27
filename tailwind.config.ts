import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#F2EDDE',
          elevated: '#EDE6D2',
          card: '#F8F4E8',
          inset: '#E6DEC6',
          deep: '#2A1F1A',
        },
        ink: {
          DEFAULT: '#2A1F1A',
          muted: '#6B5847',
          // subtle/faint darkened so every text usage clears WCAG AA (4.5:1) on
          // the paper bg — they were 2.84:1 / 1.71:1 (decorative-only). The
          // ink > muted > subtle > faint ordering is preserved; the gap is just
          // compressed because there's little room between AA (4.5:1) and muted
          // (5.77:1). Contrast on paper #F2EDDE: subtle 4.92:1, faint 4.56:1.
          subtle: '#756351',
          faint: '#7A6856',
          inverse: '#F8F4E8',
        },
        line: {
          DEFAULT: '#D6C9AC',
          soft: '#E2D8BE',
          strong: '#B8A988',
        },
        accent: {
          DEFAULT: '#B23A2C',
          hover: '#9A2F22',
          soft: '#E8D5CE',
          deeper: '#7A2519',
        },
        moss: {
          DEFAULT: '#5C6B3D',
          soft: '#DCE0CC',
        },
        azure: {
          DEFAULT: '#3A6B8C',
          soft: '#D2DEE6',
        },
        ochre: {
          DEFAULT: '#9A6E20',
          soft: '#E9DFC4',
        },
        // Shared/invited semantic accent — a folder-less collab project shared
        // WITH the user wears this (and only this) so it reads at a glance as
        // shared, distinct from the user's own (local) cards. A dusty indigo-
        // violet, maximally separable from accent(red)/azure(blue)/moss(green)/
        // ochre(amber). DEFAULT clears WCAG AA on the paper card bg #F8F4E8
        // (6.81:1) and on its own soft tint (5.63:1); soft is the badge/icon fill.
        invite: {
          DEFAULT: '#5E4A87',
          soft: '#E4DCEF',
        },
      },
      fontFamily: {
        display: ['var(--font-fraunces)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-serif', 'Georgia', 'serif'],
        body: ['var(--font-instrument-sans)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-instrument-sans)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        'tightest': '-0.04em',
        'cartographic': '0.18em',
      },
      boxShadow: {
        card: '0 1px 0 rgba(42,31,26,0.04), 0 1px 2px rgba(42,31,26,0.06)',
        'card-hover': '0 1px 0 rgba(42,31,26,0.06), 0 6px 14px rgba(42,31,26,0.08)',
        'card-active': '0 1px 0 rgba(178,58,44,0.20), 0 8px 24px rgba(178,58,44,0.18)',
        'ink-inset': 'inset 0 0 0 1px rgba(42,31,26,0.06)',
      },
      // Overlay layer scale — the single source of truth for the stacking order
      // of full-screen panels and modal surfaces. Consumed by <Overlay> via
      // src/components/ui/overlay/layers.ts (OVERLAY_LAYER). The numbers preserve
      // the historical de-facto order (8 / 20 / 40 / 50 / 60) so moving a surface
      // off its old magic number (z-[60], z-20…) onto a token is a visual no-op.
      zIndex: {
        'overlay-hint': '8', // empty-Ground hint — below every overlay
        'overlay-local': '20', // surface inside the project module's stacking context
        'overlay-panel': '40', // the owner project full-screen module panel
        'overlay-modal': '50', // app-level centred modal (opens above the panel)
        'overlay-top': '60', // top-most full-screen surface (manual)
        'overlay-gate': '70', // first-run gate above everything (onboarding)
      },
    },
  },
  plugins: [],
}

export default config
