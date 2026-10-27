// Read-only close-up shots of the stories canvas, light + dark, so the text can
// actually be read (openground-canvas-shot.mjs fits the whole page, which makes
// a 6000px-tall table unreadable). Same mechanism as that tool: real SPA on :47776,
// non-GET /api aborted; the canvas GET is answered with our viewport instead.
//   node docs/research/assistant-stories/zoom-shots.mjs <outDir>
import { createRequire } from 'node:module'
import path from 'node:path'

const OG = process.env.OG || 'http://127.0.0.1:47776'
const out = process.argv[2] || '/tmp/ogzoom'
const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright')
const projects = await (await fetch(`${OG}/api/projects`)).json()
const project = (projects.projects ?? projects.settings.projects).find((p) => p.path.endsWith('/OPEN GROUND'))
const PROJECT = project.path
const list = await (await fetch(`${OG}/api/project/canvases?path=${encodeURIComponent(PROJECT)}`)).json()
const wanted = list.canvases.find((c) => c.name === 'アシスタント: 使う場面と困りごと')

// [name, world x, world y, zoom] — the canvas pane starts ~240px from the left.
const VIEWS = [['mocks-a', -40, 40, 0.75], ['mocks-b', 1050, 40, 0.75], ['table-1', -40, 840, 0.5], ['table-1r', 1500, 840, 0.5], ['table-2', -40, 2350, 0.5], ['table-2r', 1500, 2350, 0.5], ['table-3', -40, 3850, 0.5], ['table-3r', 1500, 3850, 0.5], ['notes', -40, 5100, 0.5]]
const browser = await chromium.launch()
for (const theme of ['light', 'dark']) {
  for (const [name, wx, wy, zoom] of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: theme })
    await ctx.addInitScript(([id, t]) => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'canvas' }))
      localStorage.setItem('og-theme', t)
    }, [project.id, theme])
    await ctx.route('**/api/**', async (route) => {
      const req = route.request()
      if (req.method() !== 'GET') return route.abort()
      const url = new URL(req.url())
      if (url.pathname !== '/api/project/canvases') return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      if (body?.index) body.index.activeId = wanted.id
      if (url.searchParams.get('id') === wanted.id) body.viewport = { x: -wx * zoom, y: -wy * zoom, zoom }
      return route.fulfill({ response: res, json: body })
    })
    const page = await ctx.newPage()
    await page.goto(OG, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    await page.evaluate((t) => { if (t === 'dark') document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme }, theme)
    await page.waitForTimeout(2500)
    await page.screenshot({ path: path.join(out, `${theme}-${name}.png`) })
    await ctx.close()
  }
}
await browser.close()
console.log('shots in', out)
