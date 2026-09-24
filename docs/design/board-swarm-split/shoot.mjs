// Screenshot every state (and its opposite theme) for visual review.
// Usage: node docs/design/board-swarm-split/shoot.mjs <outDir>
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { STATES, render } from './states.mjs'
const here = path.dirname(new URL(import.meta.url).pathname)
const out = process.argv[2] || '/tmp/bss-shots'
fs.mkdirSync(out, { recursive: true })
const tpl = fs.readFileSync(path.join(here, 'prototype.html'), 'utf8')
const browser = await chromium.launch()
for (const [k, s] of Object.entries(STATES)) {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 })
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e)))
    const f = path.join(out, `${k}-${theme}.html`)
    fs.writeFileSync(f, render(tpl, { ...s.cfg, theme }))
    await page.goto('file://' + f)
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(out, `${k}-${theme}.png`) })
    if (errs.length) console.log(k, theme, 'ERR', errs)
    await page.close()
  }
}
await browser.close()
console.log('ok', out)
{
  const alt = fs.readFileSync(path.join(here, 'alt.html'), 'utf8')
  const b2 = await chromium.launch()
  for (const kind of ['side', 'overlay']) {
    const page = await b2.newPage({ viewport: { width: 1280, height: 800 } })
    const f = path.join(out, `alt-${kind}.html`)
    fs.writeFileSync(f, render(alt, { kind }))
    await page.goto('file://' + f)
    await page.screenshot({ path: path.join(out, `alt-${kind}.png`) })
  }
  await b2.close()
}
