#!/usr/bin/env node
// openground-canvas-shot.mjs - managed-by: openground - auto-deployed on
// launch, hand edits overwritten. Canonical: scripts/openground-canvas-shot.mjs
// in the OPEN GROUND repo. Remove marker -> treated as user-authored, stops
// updating.
//
// Screenshot ONE project Canvas as the running OPEN GROUND app actually draws
// it, in the light AND the dark theme, so whoever built it can look before
// calling it done (owner decision 2026-09-24: a design canvas was delivered
// unreadable because nobody had looked at it).
//
//   node ~/.claude/openground-canvas-shot.mjs --path <project> \
//        [--canvas <id or name>] [--task <card id>] [--out <dir>]
//
// - Drives the real SPA on $OG (default http://127.0.0.1:47776) in headless
//   Chromium: opens the project on its Canvas tab, stamps the theme (app
//   html[data-theme] + prefers-color-scheme, which `theme:'auto'` mocks
//   follow), fits all content (Shift+1), waits for mock iframes, shoots.
// - READ-ONLY: every non-GET /api request from the headless page is aborted
//   (the fit would otherwise save the viewport). The canvas to shoot is
//   selected INSIDE the headless page only (its canvases-list response gets
//   index.activeId rewritten), so the owner's active canvas is never touched.
// - --task attaches both PNGs to that Board card (task-asset upload + CAS PUT
//   of the card's `attachments`), so the owner sees them on the card.
// - Playwright is not bundled with the app: it is resolved from the cwd, then
//   from each registered project (the OPEN GROUND checkout has it).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const OG = (process.env.OG || 'http://127.0.0.1:47776').replace(/\/$/, '')
const args = {}
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
if (!args.path) {
  console.error('usage: openground-canvas-shot.mjs --path <project> [--canvas <id|name>] [--task <card id>] [--out <dir>]')
  process.exit(2)
}
const projectPath = fs.realpathSync(args.path)
const out = path.resolve(args.out || `/tmp/og-canvas-shot-${Date.now()}`)
fs.mkdirSync(out, { recursive: true })

const api = async (method, url, body) => {
  const res = await fetch(OG + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`)
  return { status: res.status, json }
}
const q = (p) => `path=${encodeURIComponent(p)}`

const { json: projectsRes } = await api('GET', '/api/projects')
const projects = projectsRes.projects ?? projectsRes
const project = projects.find((p) => {
  try {
    return fs.realpathSync(p.path) === projectPath
  } catch {
    return false
  }
})
if (!project) throw new Error(`not a registered OPEN GROUND project: ${projectPath}`)

const loadPlaywright = () => {
  for (const dir of [process.cwd(), ...projects.map((p) => p.path)]) {
    try {
      return createRequire(path.join(dir, 'noop.js'))('playwright')
    } catch {
      // try the next place
    }
  }
  throw new Error('Playwright not found (cwd or any registered project). Run from a checkout that has it (npm i -D playwright).')
}
const { chromium } = loadPlaywright()

const { json: list } = await api('GET', `/api/project/canvases?${q(projectPath)}`)
const wanted = args.canvas
  ? list.canvases.find((c) => c.id === args.canvas || c.name === args.canvas)
  : (list.canvases.find((c) => c.id === list.index?.activeId) ?? list.canvases[0])
if (!wanted) throw new Error(`canvas not found: ${args.canvas ?? '(active)'} — have: ${list.canvases.map((c) => c.name).join(', ') || '(none)'}`)

const shots = []
const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: theme })
    await ctx.addInitScript(
      ([id, t]) => {
        localStorage.setItem('openground:onboarded', '1')
        localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'canvas' }))
        localStorage.setItem('og-theme', t)
      },
      [project.id, theme],
    )
    await ctx.route('**/api/**', async (route) => {
      const req = route.request()
      if (req.method() !== 'GET') return route.abort()
      const url = new URL(req.url())
      // The canvases LIST (no `id`) is where the app reads which canvas to
      // open — point it at ours in this page only; nothing is written.
      if (url.pathname !== '/api/project/canvases' || url.searchParams.has('id')) return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      if (body?.index) body.index.activeId = wanted.id
      return route.fulfill({ response: res, json: body })
    })
    const page = await ctx.newPage()
    await page.goto(OG, { waitUntil: 'networkidle' })
    const tab = await page.waitForSelector('[data-testid="project-tabs"] [aria-current="page"]', { timeout: 15000 })
    if (!/canvas|キャンバス/i.test(await tab.textContent())) throw new Error('the Canvas tab did not open (is Canvas visible in this view?)')
    // App re-stamps the theme from settings.json on load — override after it.
    await page.waitForTimeout(800)
    await page.evaluate((t) => {
      if (t === 'dark') document.documentElement.dataset.theme = 'dark'
      else delete document.documentElement.dataset.theme
    }, theme)
    await page.keyboard.press('Shift+1')
    // Mock iframes (React via CDN + Babel) need a moment to mount.
    await page.waitForTimeout(3000)
    const file = path.join(out, `canvas-${theme}.png`)
    await page.screenshot({ path: file })
    shots.push(file)
    await ctx.close()
  }
} finally {
  await browser.close()
}

if (args.task) {
  const attachments = []
  for (const file of shots) {
    const { json } = await api('POST', '/api/project/task-asset', {
      path: projectPath,
      name: `${wanted.name}-${path.basename(file)}`,
      mime: 'image/png',
      dataBase64: fs.readFileSync(file).toString('base64'),
    })
    attachments.push(json)
  }
  let attached = false
  for (let attempt = 0; attempt < 5 && !attached; attempt++) {
    const { json: data } = await api('GET', `/api/project?${q(projectPath)}`)
    const card = data.tasks?.find((t) => t.id === args.task)
    if (!card) throw new Error(`card not found: ${args.task}`)
    const have = new Set((card.attachments ?? []).map((a) => a.id))
    card.attachments = [...(card.attachments ?? []), ...attachments.filter((a) => !have.has(a.id))]
    const { status } = await api('PUT', `/api/project?${q(projectPath)}`, data)
    attached = status !== 409
  }
  if (!attached) throw new Error('could not attach to the card (board kept changing) — screenshots are still in ' + out)
  console.log(`attached to card ${args.task}`)
}
console.log(`canvas "${wanted.name}":`)
for (const f of shots) console.log(f)
