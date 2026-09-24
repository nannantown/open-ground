// Render every mock of a saved canvas JSON through the REAL buildMockSrcdoc (work-mode CSP on)
// and screenshot it. Usage: npx tsx check-srcdoc.mts <canvas.json> <outDir>
import fs from 'node:fs'
import { buildMockSrcdoc } from '../../../src/lib/mockSrcdoc.ts'
import { chromium } from 'playwright'
const canvas = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const b = await chromium.launch()
let i = 0
for (const e of canvas.elements.filter((e: any) => e.type === 'mock')) {
  const p = await b.newPage({ viewport: { width: e.width, height: e.height } })
  const errs: string[] = []
  p.on('pageerror', (x) => errs.push(String(x)))
  await p.setContent(buildMockSrcdoc(e.text, e.framework, e.theme, { lockdown: true }))
  await p.waitForTimeout(150)
  const overlay = await p.$('#__opengrnd_err')
  await p.screenshot({ path: `${process.argv[3]}/real-${i++}.png` })
  console.log(e.name, e.theme, errs.length ? errs : 'no errors', overlay ? 'ERR-OVERLAY' : '')
}
await b.close()
