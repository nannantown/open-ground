#!/usr/bin/env node
// Regenerates every OPEN GROUND brand icon from the single source mark
// (public/brand/openground-mark.svg), so the app icon, favicon and OS icons all
// stay in sync with the in-app mark. Re-run after the mark changes.
//
//   node scripts/build-brand-icons.cjs
//
// Produces:
//   public/brand/favicon.svg        transparent, theme-adaptive (white in dark
//                                   mode / near-black in light mode)
//   public/brand/favicon-256.png    PNG fallback (dark-bg rounded icon)
//   src/app/icon.png                256px dark-bg icon (legacy reference)
//   build/icon.icns                 macOS app icon (dark bg + cream mark)
//   build/icon.ico                  Windows app icon
//
// Requires: rsvg-convert, iconutil (macOS), magick (ImageMagick).

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'public/brand/openground-mark.svg')

// ── Mark geometry (mirrors src/components/canvas/OpenGroundMark.tsx) ──────────
const INK = '#231916'
const CREAM = '#f1ece1'
const CX = 145, CY = 80, OUTER = 82, INNER = 48, NOTCH_COUNT = 8, NOTCH_SCALE = 1.7
const RING_ORDER = [0, 4, 1, 3, 7, 10, 14, 16, 19, 17, 5, 8, 6, 9, 2, 15, 18, 11, 13, 12]
const CENTROID = {
  0: [154.8, 10.5], 1: [187, 15.5], 2: [76.2, 102], 3: [193.4, 43.6], 4: [159.9, 27.7],
  5: [135, 151.5], 6: [102.6, 142.2], 7: [211.9, 60.1], 8: [132.3, 133.1], 9: [99.8, 115.3],
  10: [215.4, 90.9], 11: [79.4, 38.9], 12: [123.8, 12.3], 13: [107.5, 32.4], 14: [198.2, 96.1],
  15: [74.4, 71], 16: [206.2, 123.2], 17: [165.7, 148.1], 18: [92.7, 68.3], 19: [179.4, 126.1],
}

const SHARDS = [...fs.readFileSync(SRC, 'utf8').matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])

function notchShards() {
  const t = RING_ORDER.length
  const out = []
  for (let k = 0; k < NOTCH_COUNT; k++) out.push(RING_ORDER[Math.round((k * t) / NOTCH_COUNT) % t])
  return [...new Set(out)]
}

// The carved-ring mark as mask + circle. `fillRef` is either a colour or a CSS
// class name (when adaptive) applied to the visible ring.
function markBody(fill, useClass) {
  const holes = notchShards()
    .map((i) => {
      const [mx, my] = CENTROID[i]
      return `<path d="${SHARDS[i]}" fill="black" transform="translate(${mx} ${my}) scale(${NOTCH_SCALE}) translate(${-mx} ${-my})"/>`
    })
    .join('')
  const mask = `<mask id="ogmk"><rect x="60" y="-5" width="170" height="170" fill="white"/><circle cx="${CX}" cy="${CY}" r="${INNER}" fill="black"/>${holes}</mask>`
  const fillAttr = useClass ? `class="mk"` : `fill="${fill}"`
  return `${mask}<circle cx="${CX}" cy="${CY}" r="${OUTER}" ${fillAttr} mask="url(#ogmk)"/>`
}

// Transparent, theme-adaptive favicon.
function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="60 -5 170 170">
  <style>
    .mk { fill: ${INK}; }
    @media (prefers-color-scheme: dark) { .mk { fill: ${CREAM}; } }
  </style>
  ${markBody(null, true)}
</svg>
`
}

// Filled rounded-square app icon (dark bg + cream mark).
function appIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="230" fill="${INK}"/>
  <svg x="232" y="232" width="560" height="560" viewBox="60 -5 170 170">${markBody(CREAM, false)}</svg>
</svg>
`
}

function sh(cmd, args) { execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] }) }
function rsvg(svgPath, png, w, h) { sh('rsvg-convert', ['-w', String(w), '-h', String(h ?? w), svgPath, '-o', png]) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogicon-'))
const p = (f) => path.join(tmp, f)

// 1) favicon.svg (vector, adaptive)
const faviconSvgPath = path.join(ROOT, 'public/brand/favicon.svg')
fs.writeFileSync(faviconSvgPath, faviconSvg())
console.log('✓ public/brand/favicon.svg')

// 2) master app-icon svg
const appSvg = p('app.svg')
fs.writeFileSync(appSvg, appIconSvg())

// 3) macOS .icns via iconset
const iconset = p('icon.iconset')
fs.mkdirSync(iconset)
const icnsSizes = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'], [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'], [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]
for (const [sz, name] of icnsSizes) rsvg(appSvg, path.join(iconset, name), sz)
sh('iconutil', ['-c', 'icns', iconset, '-o', path.join(ROOT, 'build/icon.icns')])
console.log('✓ build/icon.icns')

// 4) Windows .ico (multi-size)
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoPngs = icoSizes.map((s) => { const f = p(`ico-${s}.png`); rsvg(appSvg, f, s); return f })
sh('magick', [...icoPngs, path.join(ROOT, 'build/icon.ico')])
console.log('✓ build/icon.ico')

// 5) PNG fallbacks (favicon + legacy src/app/icon.png)
rsvg(appSvg, path.join(ROOT, 'public/brand/favicon-256.png'), 256)
console.log('✓ public/brand/favicon-256.png')
rsvg(appSvg, path.join(ROOT, 'src/app/icon.png'), 256)
console.log('✓ src/app/icon.png')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('done.')
