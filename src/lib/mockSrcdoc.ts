// Build an iframe `srcdoc` string for a Canvas mock element.
//
// 'react': load React 18 + ReactDOM + Babel UMD from a CDN inside the iframe,
//   transform the user's code as type="text/babel" with the React preset, and
//   auto-mount a component named `App` into #root. Users only have to write a
//   plain `function App() { return <div>… </div> }` and it shows up.
//
// 'html': inline the user's code as the entire <body> contents — the same
//   pattern Claude Artifacts uses for plain HTML/CSS/JS sketches.
//
// The iframe is sandboxed (allow-scripts only, no same-origin), so the mock
// can't reach the host page's DOM, cookies, or storage. Network is allowed —
// that's how the CDN load works in v1.
//
// WORK MODE (lockdown — docs/SECURITY.md §12): while Settings.lockdownMode is
// on, srcdoc iframes are the one renderer surface that can still dial
// arbitrary hosts (the code they run is user/marketplace-supplied and there
// is no CSP by default). So every builder takes `{ lockdown }`:
//   - a template that NEEDS an external CDN runtime (mock 'react', every
//     screen/custom-tab template) is replaced by an explicit placeholder —
//     never a silently broken frame;
//   - a template that doesn't (mock 'html') keeps rendering, with a CSP
//     <meta> injected so the code inside cannot fetch/beacon out.
// The Electron webRequest floor (electron/main.js) enforces the same policy
// at the network layer; the CSP keeps browser-tab usage (dev / non-Electron)
// covered too.

import { buildInspectScript } from './canvasInspect'
import { messages, type Lang } from '@/i18n/messages'

// FNV-1a 32-bit. Stable string hash used by ElementView to key the iframe on
// the rendered srcdoc *content*, not its length, so equally-sized code edits
// still trigger a remount instead of silently sticking on the old preview.
export const hash32 = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

type Theme = 'light' | 'dark' | 'auto'

// ── Work-mode (lockdown) pieces shared by mock + screen srcdoc builders ─────

/** The CSP injected into srcdoc iframes while work mode is on: inline
 *  script/style keep the template runtime working, data:/blob: keep pasted
 *  images working, and there is NO network source at all — no connect-src, no
 *  external script/img/font — so third-party code rendered inside (e.g. a
 *  marketplace module) cannot exfiltrate. Enforced by the iframe's own
 *  document, so it also covers non-Electron (plain browser) usage. */
export const LOCKDOWN_IFRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'"

export const LOCKDOWN_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${LOCKDOWN_IFRAME_CSP}" />`

/** Options every srcdoc builder accepts. `lockdown` mirrors
 *  Settings.lockdownMode (src/lib/lockdownClient.ts on the client). */
export interface SrcdocOpts {
  lockdown?: boolean
}

// srcdoc builders are plain modules (no useT()) — resolve the persisted UI
// language the same way screenSrcdoc's starter strings do.
const srcdocLang = (): Lang => {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('og-lang') : null
    if (saved === 'ja') return 'ja'
  } catch {
    /* storage unavailable — default to English */
  }
  return 'en'
}
const srcdocMsg = (key: string): string => {
  const lang = srcdocLang()
  return messages[lang][key] ?? messages.en[key] ?? key
}

/** The explicit "blocked by work mode" frame shown instead of any CDN-backed
 *  template while lockdown is on. Zero external references, CSP'd anyway. */
export function buildLockdownPlaceholderSrcdoc(theme: Theme = 'light'): string {
  const dark = 'background: #0b0c0e; color: #8a8f98;'
  const light = 'background: #f6f3ea; color: #6b6459;'
  const themeCSS =
    theme === 'dark'
      ? `html, body { ${dark} }`
      : theme === 'auto'
        ? `html, body { ${light} } @media (prefers-color-scheme: dark) { html, body { ${dark} } }`
        : `html, body { ${light} }`
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    ${LOCKDOWN_CSP_META}
    <style>
      html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; }
      ${themeCSS}
      .wrap { box-sizing: border-box; height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .note { max-width: 42ch; text-align: center; }
      .title { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
      .dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; opacity: 0.7; }
      .body { margin: 8px 0 0; font-size: 11px; line-height: 1.6; opacity: 0.75; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="note">
        <span class="title"><span class="dot"></span>${srcdocMsg('srcdoc.lockdown.title')}</span>
        <p class="body">${srcdocMsg('srcdoc.lockdown.body')}</p>
      </div>
    </div>
  </body>
</html>`
}

// Body / #root background and color. Mock elements with theme: 'dark' render
// on a near-black background so dark UI mocks aren't washed out. 'auto' tracks
// the host OS via prefers-color-scheme; 'light' (default) keeps the old look.
const bodyCSS = (theme: Theme): string => {
  const base =
    'html, body, #root { margin: 0; padding: 0; height: 100%; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans JP", system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }'
  if (theme === 'dark') {
    return `${base} html, body, #root { background: #0b0c0e; color: #f3f3f3; }`
  }
  if (theme === 'auto') {
    return (
      `${base} html, body, #root { background: #fff; color: #111; } ` +
      '@media (prefers-color-scheme: dark) { html, body, #root { background: #0b0c0e; color: #f3f3f3; } }'
    )
  }
  return `${base} html, body, #root { background: #fff; color: #111; }`
}

// Error overlay — slides up from the bottom (max 40% height) so the working
// preview above stays visible. Old design covered the whole iframe, so any
// runtime error wiped the visible state. Captures both sync throws (in the
// boot try/catch below) and async errors via error / unhandledrejection.
const ERR_CSS =
  '#__opengrnd_err { position: fixed; left: 0; right: 0; bottom: 0; max-height: 40%; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #b23a2c; background: #fff5f3; white-space: pre-wrap; overflow: auto; box-shadow: 0 -1px 0 #b23a2c; z-index: 2147483647; margin: 0; }'

const ERR_SCRIPT = `(function () {
  function show(msg) {
    var el = document.getElementById('__opengrnd_err');
    if (!el) {
      el = document.createElement('pre');
      el.id = '__opengrnd_err';
      document.body.appendChild(el);
    }
    el.textContent = (el.textContent ? el.textContent + '\\n\\n' : '') + msg;
  }
  window.addEventListener('error', function (ev) {
    show(String((ev.error && ev.error.stack) || ev.message || ev));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    show(String((r && r.stack) || r));
  });
})();`

const REACT_TEMPLATE = (code: string, theme: Theme) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone@8/babel.min.js"></script>
    <style>
      ${bodyCSS(theme)}
      ${ERR_CSS}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>${ERR_SCRIPT}</script>
    <script>${buildInspectScript()}</script>
    <!-- Babel 8's preset-react defaults to the automatic JSX runtime, which
         emits an import from react/jsx-runtime — unresolvable here (only the
         React UMD global is loaded). Register a classic-runtime react preset
         so JSX compiles to React.createElement instead. -->
    <script>Babel.registerPreset('react-classic', { presets: [[Babel.availablePresets.react, { runtime: 'classic' }]] });</script>
    <script type="text/babel" data-presets="react-classic" data-type="module">
      try {
        ${code}
        const __root = ReactDOM.createRoot(document.getElementById('root'));
        if (typeof App !== 'undefined') {
          __root.render(React.createElement(App));
        } else {
          throw new Error('No top-level App component defined. Add: function App() { return <div>…</div> }');
        }
      } catch (err) {
        const el = document.createElement('pre');
        el.id = '__opengrnd_err';
        el.textContent = String(err && err.stack || err);
        document.body.appendChild(el);
      }
    </script>
  </body>
</html>`

const HTML_TEMPLATE = (code: string, theme: Theme, lockdown: boolean) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    ${lockdown ? LOCKDOWN_CSP_META : ''}
    <style>
      ${bodyCSS(theme)}
      ${ERR_CSS}
    </style>
  </head>
  <body>
    <script>${ERR_SCRIPT}</script>
    <script>${buildInspectScript()}</script>
${code}
  </body>
</html>`

export function buildMockSrcdoc(
  code: string,
  framework: 'react' | 'html' = 'react',
  theme: Theme = 'light',
  opts: SrcdocOpts = {},
): string {
  const lockdown = opts.lockdown === true
  // HTML mocks have no CDN runtime — they keep rendering under lockdown, with
  // the CSP sealing the user code in. React mocks NEED unpkg → placeholder.
  if (framework === 'html') return HTML_TEMPLATE(code, theme, lockdown)
  if (lockdown) return buildLockdownPlaceholderSrcdoc(theme)
  return REACT_TEMPLATE(code, theme)
}

// Starter snippets shown the moment a mock is dropped. Kept short so the user
// sees something rendered immediately, then iterates from there (via Claude
// Code chat or the inline editor).
export const DEFAULT_REACT_CODE = `function App() {
  const [n, setN] = React.useState(0)
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Hello from Canvas</h2>
      <p style={{ color: '#555' }}>Edit me, or ask Claude to.</p>
      <button
        onClick={() => setN(n + 1)}
        style={{
          padding: '8px 14px',
          borderRadius: 6,
          border: '1px solid #ddd',
          background: '#111',
          color: '#fff',
          cursor: 'pointer',
        }}
      >
        Clicked {n} times
      </button>
    </div>
  )
}
`

export const DEFAULT_HTML_CODE = `<div style="padding: 24px; font-family: system-ui, sans-serif;">
  <h2 style="margin-top: 0;">Hello from Canvas</h2>
  <p style="color: #555;">Edit me, or ask Claude to.</p>
</div>
`
