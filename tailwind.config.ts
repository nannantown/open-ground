import type { Config } from 'tailwindcss'

const config: Config = {
  // UI class scanning must NOT reach server-side code: files under
  // src/lib/server carry no className usage, only backend logic — and a bare
  // regex character class there (e.g. `/[-:.]/` in homeBackup.ts) is misread by
  // the JIT as an arbitrary-property utility, emitting invalid CSS (`.[-:.]{-: .}`)
  // that lightningcss then rejects at minify, breaking `npm run build`
  // (regression landed 2026-07-19). Excluding the server tree is safe: none of
  // OPEN GROUND's own utility classes originate there.
  content: ['./src/**/*.{ts,tsx}', '!./src/lib/server/**'],
  theme: {
    extend: {
      // 2026-08-03 (第三弾「計器盤」): every token reads a CSS variable so the
      // whole app switches palette on html[data-theme] — the actual channel
      // values (light paper / dark instrument, with their WCAG rationale) live
      // in src/app/globals.css, pinned by src/themePalette.test.ts. The
      // `rgb(var() / <alpha-value>)` form keeps Tailwind opacity modifiers
      // (bg-accent/10, ring-accent/40 …) working.
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--og-bg) / <alpha-value>)',
          elevated: 'rgb(var(--og-bg-elevated) / <alpha-value>)',
          card: 'rgb(var(--og-bg-card) / <alpha-value>)',
          inset: 'rgb(var(--og-bg-inset) / <alpha-value>)',
          cardHover: 'rgb(var(--og-bg-card-hover) / <alpha-value>)',
          glow: 'rgb(var(--og-bg-glow) / <alpha-value>)',
          deep: 'rgb(var(--og-bg-deep) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--og-ink) / <alpha-value>)',
          muted: 'rgb(var(--og-ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--og-ink-subtle) / <alpha-value>)',
          faint: 'rgb(var(--og-ink-faint) / <alpha-value>)',
          inverse: 'rgb(var(--og-ink-inverse) / <alpha-value>)',
        },
        /** The LIFT a hover puts on top of a surface — the opposite of bg-inset,
         *  which is a well pressed INTO one. They look alike on paper and
         *  invert at night, which is why `hover:bg-bg-inset` made dark-mode
         *  hovers sink into a hole. */
        plane: 'rgb(var(--og-plane) / <alpha-value>)',
        /** Vermillion FILL (the 高 chip). Never used as text, so it carries no
         *  text-contrast obligation — that is what `accent` is for. */
        verm: 'rgb(var(--og-verm) / <alpha-value>)',
        line: {
          DEFAULT: 'rgb(var(--og-line) / <alpha-value>)',
          soft: 'rgb(var(--og-line-soft) / <alpha-value>)',
          strong: 'rgb(var(--og-line-strong) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--og-accent) / <alpha-value>)',
          hover: 'rgb(var(--og-accent-hover) / <alpha-value>)',
          soft: 'rgb(var(--og-accent-soft) / <alpha-value>)',
          deeper: 'rgb(var(--og-accent-deeper) / <alpha-value>)',
        },
        moss: {
          DEFAULT: 'rgb(var(--og-moss) / <alpha-value>)',
          /** Text-grade running colour (the lamp's fill is too dark to read). */
          text: 'rgb(var(--og-moss-text) / <alpha-value>)',
          soft: 'rgb(var(--og-moss-soft) / <alpha-value>)',
        },
        azure: {
          DEFAULT: 'rgb(var(--og-azure) / <alpha-value>)',
          soft: 'rgb(var(--og-azure-soft) / <alpha-value>)',
        },
        ochre: {
          DEFAULT: 'rgb(var(--og-ochre) / <alpha-value>)',
          soft: 'rgb(var(--og-ochre-soft) / <alpha-value>)',
          deep: 'rgb(var(--og-ochre-deep) / <alpha-value>)',
          deeper: 'rgb(var(--og-ochre-deeper) / <alpha-value>)',
        },
        // Shared/invited semantic accent — a folder-less collab project shared
        // WITH the user wears this (and only this) so it reads at a glance as
        // shared, distinct from the user's own (local) cards.
        invite: {
          DEFAULT: 'rgb(var(--og-invite) / <alpha-value>)',
          soft: 'rgb(var(--og-invite-soft) / <alpha-value>)',
        },
      },
      fontFamily: {
        display: ['var(--font-fraunces)', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-serif', 'Georgia', 'serif'],
        body: ['var(--font-instrument-sans)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-instrument-sans)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        'tightest': '-0.04em',
        'cartographic': '0.18em',
      },
      boxShadow: {
        /** The instrument lamps GLOW. Without this they are just dots, and the
         *  whole 計器盤 reading of the board goes with them. */
        'lamp-moss': '0 0 7px rgb(var(--og-moss) / 0.55)',
        'lamp-ochre': '0 0 7px rgb(var(--og-ochre) / 0.55)',
        card: '0 1px 0 rgb(var(--og-shadow) / 0.04), 0 1px 2px rgb(var(--og-shadow) / 0.06)',
        'card-hover': '0 1px 0 rgb(var(--og-shadow) / 0.06), 0 6px 14px rgb(var(--og-shadow) / 0.08)',
        'card-active': '0 1px 0 rgb(var(--og-accent) / 0.20), 0 8px 24px rgb(var(--og-accent) / 0.18)',
        'ink-inset': 'inset 0 0 0 1px rgb(var(--og-shadow) / 0.06)',
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
        // Hosted custom-tab iframes (CustomFrameHost): drawn OVER the panel's
        // tab body (the panel is one stacking context, so any in-panel z would
        // sit below it) but UNDER app modals — panel popups that must beat the
        // frame are portaled to <body> at overlay-modal.
        'overlay-frame': '45',
        'overlay-modal': '50', // app-level centred modal (opens above the panel)
        'overlay-top': '60', // top-most full-screen surface (manual)
        'overlay-gate': '70', // first-run gate above everything (onboarding)
      },
    },
  },
  plugins: [],
}

export default config
