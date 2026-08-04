// Build an iframe `srcdoc` string for a Canvas **screen** element.
//
// Screens used to resolve an on-disk module (`src/designs/<slug>/<id>.tsx`)
// through Vite's `import.meta.glob`, which is baked at BUILD time. In the
// shipped Electron app there is no dev server to re-scan, so any screen
// authored after the build rendered as a blank "module not found" tile.
//
// This module makes a screen render the same runtime way a `mock` does: its
// source code is a plain string that we transpile in-browser (Babel) and mount
// inside a sandboxed iframe. The difference from a mock is richness — a screen
// gets the project's full design system so a Claude-authored, token-using,
// lucide-icon component renders faithfully with no rebuild:
//   • Tailwind Play CDN + the same `theme.extend` as tailwind.config.ts, so
//     project tokens (bg-bg-card / text-ink / accent / moss / ochre / shadow-card …)
//     resolve to the right values.
//   • The project's display / body / mono fonts (Google Fonts) wired to the
//     `--font-*` CSS vars the token config references, plus the `.label-cap` /
//     `.coord-label` custom utilities.
//   • A `lucide-react` shim (built from the vanilla `lucide` icon data) so
//     `import { Check } from 'lucide-react'` works without a bundler.
//   • TypeScript + JSX transpilation (so a `.tsx` component pasted verbatim
//     renders), with `import`/`export` rewritten to a tiny module registry.
//
// The iframe is sandboxed `allow-scripts` (no same-origin), so a screen can't
// reach the host page's DOM / cookies / storage. Network is allowed — that's
// how the CDN + fonts load (cached after first online load, like mocks).

import { hash32, buildLockdownPlaceholderSrcdoc, type SrcdocOpts } from './mockSrcdoc'
import { buildInspectScript } from './canvasInspect'
import { messages, type Lang } from '@/i18n/messages'

export { hash32 }

// This module builds iframe srcDoc HTML strings — it is a plain module, not a
// React component, so it can't call useT(). The starter source below is shown
// to the user, so we resolve the persisted UI language ('og-lang', the same key
// I18nProvider writes) directly and fall back to English.
function currentLang(): Lang {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('og-lang') : null
    if (saved === 'ja') return 'ja'
  } catch {
    /* storage unavailable (private mode / non-browser) — default to English */
  }
  return 'en'
}

function st(key: string): string {
  const lang = currentLang()
  return messages[lang][key] ?? messages.en[key] ?? key
}

export type ScreenFramework = 'react' | 'html'
export type ScreenTheme = 'light' | 'dark' | 'auto'

// ── Tailwind config mirrored from tailwind.config.ts (theme.extend) ──────────
// Kept in sync by hand — these are the only tokens generated UIs reference.
// Play CDN reads `tailwind.config` and regenerates utilities at runtime, so
// arbitrary values (e.g. `tracking-[0.14em]`) work too.
const TAILWIND_CONFIG = {
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
          subtle: '#9A8B76',
          faint: '#C2B6A0',
          inverse: '#F8F4E8',
        },
        line: { DEFAULT: '#D6C9AC', soft: '#E2D8BE', strong: '#B8A988' },
        accent: { DEFAULT: '#B23A2C', hover: '#9A2F22', soft: '#E8D5CE', deeper: '#7A2519' },
        moss: { DEFAULT: '#5C6B3D', soft: '#DCE0CC' },
        ochre: { DEFAULT: '#9A6E20', soft: '#E9DFC4' },
      },
      fontFamily: {
        display: ['var(--font-fraunces)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-serif', 'Georgia', 'serif'],
        body: ['var(--font-instrument-sans)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-instrument-sans)', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Mirrored from tailwind.config.ts — see the note at the top of this
      // block. src/screenSrcdocMirror.test.ts fails if the two drift.
      fontSize: {
        plate: ['11px', { lineHeight: '14px' }],
        micro: ['12px', { lineHeight: '16px', letterSpacing: '0.005em' }],
        meta: ['13px', { lineHeight: '18px', letterSpacing: '0' }],
        ui: ['14px', { lineHeight: '20px', letterSpacing: '-0.006em' }],
        read: ['16px', { lineHeight: '24px', letterSpacing: '-0.011em' }],
        title: ['20px', { lineHeight: '26px', letterSpacing: '-0.02em' }],
        head: ['26px', { lineHeight: '32px', letterSpacing: '-0.025em' }],
        hero: ['34px', { lineHeight: '40px', letterSpacing: '-0.03em' }],
      },
      letterSpacing: { tightest: '-0.04em', cartographic: '0.18em' },
      boxShadow: {
        card: '0 1px 0 rgba(42,31,26,0.04), 0 1px 2px rgba(42,31,26,0.06)',
        'card-hover': '0 1px 0 rgba(42,31,26,0.06), 0 6px 14px rgba(42,31,26,0.08)',
        'card-active': '0 1px 0 rgba(178,58,44,0.20), 0 8px 24px rgba(178,58,44,0.18)',
        'ink-inset': 'inset 0 0 0 1px rgba(42,31,26,0.06)',
      },
    },
  },
}

// Self-hosted fonts (public/fonts/ — same files the app shell loads). A
// srcdoc iframe inherits the parent document's base URL, so this resolves to
// the loopback origin; the server adds Access-Control-Allow-Origin for
// /fonts/* because the sandboxed iframe is null-origin and font loads are
// CORS-gated. Deliberately NOT fonts.googleapis.com — see docs/SECURITY.md
// §8-8 / §12 (no non-Anthropic egress).
const FONTS_HREF = '/fonts/fonts.css'

// Custom utilities / CSS vars not expressible through the Tailwind config — the
// `--font-*` vars the token fontFamily references, plus the `.label-cap` /
// `.coord-label` classes from globals.css that token-using designs lean on.
const TOKEN_CSS = `
:root {
  --font-fraunces: 'Fraunces', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, 'Noto Sans JP', ui-serif, Georgia, serif;
  --font-instrument-sans: 'Instrument Sans', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, 'Noto Sans JP', ui-sans-serif, system-ui, sans-serif;
  --font-jetbrains-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
.label-cap {
  font-family: var(--font-instrument-sans), system-ui, sans-serif;
  font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 500;
}
.coord-label {
  font-family: var(--font-jetbrains-mono), ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
}
/* 和文 folds under Latin small-caps tracking — see globals.css for the full
   reasoning. This half was written on 2026-08-04 (0.11.66) and never copied
   here, so a generated UI kept stacking Japanese captions one character per
   line long after the app stopped. src/screenSrcdocMirror.test.ts now fails if
   these drift apart again. */
:lang(ja) .label-cap { letter-spacing: 0.02em; }
:lang(ja) .coord-label { letter-spacing: 0.02em; }
html .label-cap.label-cap-latin { letter-spacing: 0.16em; }
html .coord-label.label-cap-latin { letter-spacing: 0.08em; }
html .label-cap.label-cap-flat, html .coord-label.label-cap-flat { letter-spacing: 0.02em; }
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
`

const baseBodyCSS = (theme: ScreenTheme): string => {
  const base =
    'html, body, #root { margin: 0; padding: 0; min-height: 100%; font-family: var(--font-instrument-sans), system-ui, -apple-system, sans-serif; }'
  if (theme === 'dark') {
    return `${base} html, body, #root { background: #0b0c0e; color: #f3f3f3; }`
  }
  if (theme === 'auto') {
    return (
      `${base} html, body, #root { background: #F8F4E8; color: #2A1F1A; } ` +
      '@media (prefers-color-scheme: dark) { html, body, #root { background: #0b0c0e; color: #f3f3f3; } }'
    )
  }
  // Screens default to the project's paper card tone rather than pure white so
  // a component that doesn't paint its own background still reads as OPEN GROUND.
  return `${base} html, body, #root { background: #F8F4E8; color: #2A1F1A; }`
}

const ERR_CSS =
  '#__opengrnd_err { position: fixed; left: 0; right: 0; bottom: 0; max-height: 45%; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #b23a2c; background: #fff5f3; white-space: pre-wrap; overflow: auto; box-shadow: 0 -1px 0 #b23a2c; z-index: 2147483647; margin: 0; }'

const ERR_SCRIPT = `(function () {
  function show(msg) {
    var el = document.getElementById('__opengrnd_err');
    if (!el) { el = document.createElement('pre'); el.id = '__opengrnd_err'; document.body.appendChild(el); }
    el.textContent = (el.textContent ? el.textContent + '\\n\\n' : '') + msg;
  }
  window.__opengrnd_show_err = show;
  window.addEventListener('error', function (ev) { show(String((ev.error && ev.error.stack) || ev.message || ev)); });
  window.addEventListener('unhandledrejection', function (ev) { var r = ev.reason; show(String((r && r.stack) || r)); });
})();`

// The in-iframe runtime: a lucide-react shim, a tiny module registry, then
// Babel-transpile the (already import/export-stripped) user source and mount
// the resolved component. `props` is injected as the mounted element's props.
const RUNTIME_SCRIPT = `(function () {
  var show = window.__opengrnd_show_err || function (m) { console.error(m); };

  // lucide-react shim — build React icon components from the vanilla lucide
  // icon data (window.lucide.icons, keyed PascalCase). Missing icons render an
  // empty 1em box rather than crashing the whole screen.
  function makeIcon(node, name) {
    function Icon(props) {
      props = props || {};
      var size = props.size == null ? 24 : props.size;
      var color = props.color || 'currentColor';
      var sw = props.strokeWidth == null ? 2 : props.strokeWidth;
      var rest = {};
      for (var k in props) {
        if (k === 'size' || k === 'color' || k === 'strokeWidth' || k === 'absoluteStrokeWidth') continue;
        rest[k] = props[k];
      }
      var kids = (node || []).map(function (child, i) {
        var tag = Array.isArray(child) ? child[0] : 'path';
        var attrs = Array.isArray(child) ? (child[1] || {}) : {};
        var copy = { key: i };
        for (var a in attrs) copy[a] = attrs[a];
        return React.createElement(tag, copy);
      });
      var svgAttrs = {
        xmlns: 'http://www.w3.org/2000/svg', width: size, height: size,
        viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: sw,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      };
      for (var r in rest) svgAttrs[r] = rest[r];
      return React.createElement('svg', svgAttrs, kids);
    }
    Icon.displayName = name;
    return Icon;
  }
  var ICONS = (typeof window.lucide !== 'undefined' && window.lucide.icons) ? window.lucide.icons : {};
  var iconCache = {};
  var lucideReact = new Proxy({}, {
    get: function (_t, prop) {
      if (prop === '__esModule') return true;
      if (typeof prop !== 'string') return undefined;
      if (!iconCache[prop]) iconCache[prop] = makeIcon(ICONS[prop], prop);
      return iconCache[prop];
    },
  });

  // Real jsx-runtime shim (the React UMD object has no jsx/jsxs), so a screen
  // that hand-imports from 'react/jsx-runtime' works as well as compiled JSX.
  function jsxShim(type, props, key) {
    var p = Object.assign({}, props);
    if (key !== undefined) p.key = key;
    return React.createElement(type, p);
  }
  var jsxRuntime = { jsx: jsxShim, jsxs: jsxShim, Fragment: React.Fragment, __esModule: true };

  var MODS = {
    react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOM,
    'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxRuntime,
    'lucide-react': lucideReact,
  };
  function requireShim(name) {
    if (MODS[name]) return MODS[name];
    // Unknown module → inert object; property access yields undefined and the
    // error overlay reports the resulting runtime error in context.
    return {};
  }

  try {
    var src = document.getElementById('__opengrnd_src').textContent;
    var out = Babel.transform(src, {
      // Babel 8 removed isTSX/allExtensions; preset-react auto-detects .tsx.
      // runtime:'classic' keeps JSX compiling to React.createElement — the
      // default 'automatic' emits an import from react/jsx-runtime, a syntax
      // error inside the new Function() body below.
      presets: [['typescript', { onlyRemoveTypeImports: true }], ['react', { runtime: 'classic' }]],
      filename: 'screen.tsx',
    }).code;
    // Run the transpiled module body with React / ReactDOM / require in scope,
    // returning whichever component it defined. An explicit default export wins
    // over a bare \`App\` so a screen with both (App as an internal helper) mounts
    // the intended component, not the helper.
    var body = out + '\\n;return window.__SCREEN_DEFAULT || (typeof App !== "undefined" && App) || null;';
    var Comp = new Function('React', 'ReactDOM', 'require', 'exports', 'module', body)(
      React, ReactDOM, requireShim, {}, { exports: {} }
    );
    if (!Comp) throw new Error('Screen source defined no component. Export a default component, or define function App().');
    var props = window.__SCREEN_PROPS || {};
    var root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(Comp, props));
  } catch (err) {
    show(String((err && err.stack) || err));
  }
})();`

// ── Source preprocessor: rewrite ES module syntax to the require registry ────
// Babel runs inside a `new Function` body, which forbids top-level
// import/export. We strip those lines to a CommonJS-ish form first.

function transformImportClause(clause: string, mod: string): string {
  const q = JSON.stringify(mod)
  const c = clause.trim()
  // `import type { ... }` / `import type X` — types vanish at runtime.
  if (/^type[\s{]/.test(c)) return ''
  const parts: string[] = []
  // namespace: `* as NS`
  const ns = c.match(/^\*\s+as\s+([A-Za-z0-9_$]+)$/)
  if (ns) return `var ${ns[1]} = require(${q});`
  // default + named: `Default, { a, b }`  /  default only: `Default`
  let defaultName: string | null = null
  const namedMatch = c.match(/\{([^}]*)\}/)
  const beforeBrace = c.split('{')[0].replace(/,$/, '').trim()
  if (beforeBrace && beforeBrace !== '*') defaultName = beforeBrace.replace(/,/g, '').trim() || null
  if (defaultName) {
    parts.push(`var ${defaultName} = (require(${q}).default !== undefined ? require(${q}).default : require(${q}));`)
  }
  if (namedMatch) {
    // strip inline `type ` specifiers, normalise `a as b`
    const names = namedMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !/^type\s/.test(s))
      .map((s) => s.replace(/\s+as\s+/g, ': '))
      .join(', ')
    if (names) parts.push(`var { ${names} } = require(${q});`)
  }
  return parts.join(' ')
}

// Turn one `export { a, b as default }` specifier list into runtime statements.
// `from` is the optional re-export module; when present each name is read from
// require(mod), otherwise the local binding already exists (plain re-exports
// just need the default captured).
function transformExportClause(names: string, mod?: string): string {
  const q = mod ? JSON.stringify(mod) : null
  const parts: string[] = []
  for (const spec of names.split(',').map((s) => s.trim()).filter(Boolean)) {
    const s = spec.replace(/^type\s+/, '')
    if (/^type$/.test(s)) continue
    const asMatch = s.match(/^(\S+)\s+as\s+(\S+)$/)
    const local = asMatch ? asMatch[1] : s
    const exported = asMatch ? asMatch[2] : s
    if (exported === 'default') {
      parts.push(`window.__SCREEN_DEFAULT = ${q ? `require(${q}).${local}` : local};`)
    } else if (q) {
      parts.push(`var ${exported} = require(${q}).${local};`)
    }
    // plain local `export { Foo }` (no module, not default): the binding already
    // exists in scope — nothing to emit.
  }
  return parts.join(' ')
}

export function preprocessScreenSource(src: string): string {
  let out = src
  // Side-effect imports first (`import 'mod'`) so the from-import scan below
  // can't span across one into a later statement. Tolerates trailing comments.
  out = out.replace(/^[ \t]*import\s+['"][^'"]+['"][ \t]*;?/gm, '')
  // `import ... from 'mod'` — NOT anchored at end-of-line, so a trailing `//`
  // comment or same-line code after the import survives instead of leaving a
  // bare `import` that crashes the new Function() body.
  out = out.replace(
    /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, clause, mod) => transformImportClause(String(clause), String(mod)),
  )
  // `export { a, b as default } from 'mod'` (re-export) — must run before the
  // local `export { ... }` rule below so the `from` clause isn't left dangling.
  out = out.replace(
    /^[ \t]*export\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, names, mod) => transformExportClause(String(names), String(mod)),
  )
  // `export { a, b as default }` (local list export)
  out = out.replace(
    /^[ \t]*export\s*\{([^}]*)\}[ \t]*;?/gm,
    (_m, names) => transformExportClause(String(names)),
  )
  // `export default function Name` / `export default class Name`
  const named: string[] = []
  out = out.replace(
    /^[ \t]*export\s+default\s+(function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, name) => {
      named.push(String(name))
      return `${kw} ${name}`
    },
  )
  // `export default <expr>` (anonymous fn / arrow / object / identifier)
  out = out.replace(/^[ \t]*export\s+default\s+/gm, 'window.__SCREEN_DEFAULT = ')
  // `export function|const|let|var|class|async` → strip the `export ` keyword
  out = out.replace(/^[ \t]*export\s+(?=(function|const|let|var|class|async)\b)/gm, '')
  // Re-export named default-export functions after their (hoisted) declaration.
  if (named.length) {
    out += '\n' + named.map((n) => `try { window.__SCREEN_DEFAULT = ${n}; } catch (e) {}`).join('\n')
  }
  return out
}

// HTML framework: the source is inlined as the <body>, with the same token
// CSS / fonts / Tailwind available so a hand-written HTML sketch also gets the
// design system.
const HTML_TEMPLATE = (code: string, theme: ScreenTheme): string => `<!doctype html>
<html lang="${currentLang()}">
  <head>
    <meta charset="utf-8" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script>tailwind.config = ${JSON.stringify(TAILWIND_CONFIG)};</script>
    <link rel="stylesheet" href="${FONTS_HREF}" />
    <style>${baseBodyCSS(theme)}${TOKEN_CSS}${ERR_CSS}</style>
  </head>
  <body>
    <script>${ERR_SCRIPT}</script>
    <script>${buildInspectScript()}</script>
${code}
  </body>
</html>`

const REACT_TEMPLATE = (
  preprocessed: string,
  theme: ScreenTheme,
  propsJson: string,
): string => `<!doctype html>
<html lang="${currentLang()}">
  <head>
    <meta charset="utf-8" />
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone@8/babel.min.js"></script>
    <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>tailwind.config = ${JSON.stringify(TAILWIND_CONFIG)};</script>
    <link rel="stylesheet" href="${FONTS_HREF}" />
    <style>${baseBodyCSS(theme)}${TOKEN_CSS}${ERR_CSS}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${ERR_SCRIPT}</script>
    <script>${buildInspectScript()}</script>
    <script>window.__SCREEN_PROPS = ${propsJson};</script>
    <script type="text/plain" id="__opengrnd_src">${preprocessed.replace(/<\/(script)/gi, '<\\/$1')}</script>
    <script>${RUNTIME_SCRIPT}</script>
  </body>
</html>`

export function buildScreenSrcdoc(
  source: string,
  framework: ScreenFramework = 'react',
  theme: ScreenTheme = 'light',
  props?: Record<string, unknown>,
  opts: SrcdocOpts = {},
): string {
  // WORK MODE (lockdown): BOTH screen templates need external CDNs (Tailwind
  // Play at minimum; react/babel/lucide for 'react') — under lockdown they
  // cannot render truthfully, so show the explicit placeholder instead of a
  // silently unstyled/broken frame (docs/SECURITY.md §12). Custom-module tabs
  // route through here too, which is exactly the third-party-code surface the
  // placeholder's CSP exists for.
  if (opts.lockdown === true) return buildLockdownPlaceholderSrcdoc(theme)
  if (framework === 'html') return HTML_TEMPLATE(source, theme)
  let propsJson = '{}'
  try {
    propsJson = props && Object.keys(props).length ? JSON.stringify(props) : '{}'
  } catch {
    propsJson = '{}'
  }
  // Escape `<` so a prop value containing `</script>` (or `<!--`) can't close
  // the props <script> block early. Keeps the value valid JSON/JS.
  propsJson = propsJson.replace(/</g, '\\u003c')
  return REACT_TEMPLATE(preprocessScreenSource(source), theme, propsJson)
}

// Starter source shown the moment a screen is dropped (React framework). Uses
// project tokens so a fresh screen already looks like OPEN GROUND.
export const DEFAULT_SCREEN_SOURCE = `export default function Screen() {
  return (
    <div className="min-h-full bg-bg p-10 font-body text-ink">
      <p className="label-cap text-ink-muted">Screen</p>
      <h1 className="mt-2 font-display text-hero leading-tight text-ink">
        ${st('screen.starter.heading')}
      </h1>
      <p className="mt-3 max-w-[46ch] text-ui leading-relaxed text-ink-muted">
        ${st('screen.starter.body')}
      </p>
      <div className="mt-8 flex gap-3">
        <button className="rounded-[3px] bg-accent px-4 py-2 text-meta font-medium text-bg-card">
          Primary
        </button>
        <button className="rounded-[3px] border border-line bg-bg-card px-4 py-2 text-meta text-ink">
          Secondary
        </button>
      </div>
    </div>
  )
}
`

export const DEFAULT_SCREEN_HTML = `<div class="min-h-full bg-bg p-10 font-body text-ink">
  <p class="label-cap text-ink-muted">Screen</p>
  <h1 class="mt-2 font-display text-hero leading-tight text-ink">${st('screen.starter.heading')}</h1>
  <p class="mt-3 max-w-[46ch] text-ui leading-relaxed text-ink-muted">
    ${st('screen.starter.htmlBody')}
  </p>
</div>
`
