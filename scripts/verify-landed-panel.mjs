#!/usr/bin/env node
// scripts/verify-landed-panel.mjs — 実機の「着地 / 週」パネル検証(read-only)
//
// あなたの Mac で、起動中の OPEN GROUND に対して:
//   1) GET /api/swarm/kpi/landed を叩いて集計(週次バケット・self/external・
//      perProject)を人間が読める形で表示する — これはいつでも動く。
//   2) --project <カード名> を渡すと Playwright で実 UI を歩き
//      (Ground → プロジェクト → Swarm → MANAGER)、着地パネルの
//      スクリーンショットを保存してパスを表示する。
//
// 使い方(アプリ起動中に、リポジトリのルートで):
//   node scripts/verify-landed-panel.mjs                       # API 集計のみ
//   node scripts/verify-landed-panel.mjs --project "MyApp"     # + UI スクショ
//   node scripts/verify-landed-panel.mjs --project "MyApp" --dark   # ダークも強制
//   node scripts/verify-landed-panel.mjs --port 5174 ...       # dev サーバ相手
//
// 方針: READ-ONLY。エンジンの Start は押さない — エンジン停止中は Swarm タブが
// オンボーディング表示になり MANAGER ビュー(パネルの住処)へ入れないので、
// その場合は「エンジンを起動してから再実行」を案内して終わる(状態は変えない)。
// 認証はサーバ側セッション(単一ユーザー)なので、アプリにオーナーで入れて
// いれば Playwright 側の追加ログインは不要。403 が返るならサインイン
// (または OPENGROUND_LOCAL_OWNER=1)を確認する。

import { tmpdir } from 'os'
import { join } from 'path'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name) => process.argv.includes(name)

const port = Number(arg('--port') ?? '47776')
const project = arg('--project')
const dark = has('--dark')
const origin = `http://127.0.0.1:${port}`

// ── 1) API 集計 ───────────────────────────────────────────────────────────────
const res = await fetch(`${origin}/api/swarm/kpi/landed`).catch(() => null)
if (!res) {
  console.error(`✗ ${origin} に届きません — アプリは起動していますか?(prod: 47776 / dev: 5174)`)
  process.exit(1)
}
if (res.status === 403) {
  console.error('✗ 403 — オーナーでサインインしていないか、ローカル解錠(OPENGROUND_LOCAL_OWNER=1)がありません。')
  process.exit(1)
}
if (!res.ok) {
  console.error(`✗ API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  process.exit(1)
}
const kpi = await res.json()
console.log('── 着地 / 週(API・全プロジェクト)──')
console.log(`合計: 外部 ${kpi.totals.external} ・ OG 自身 ${kpi.totals.self}`)
const tail = kpi.weeks.slice(-6)
for (const w of tail) console.log(`  ${w.weekStart}: 外部 ${w.external} / 自身 ${w.self}`)
if (kpi.perProject.length === 0) {
  console.log('  (まだ着地の記録なし — 台帳は promote → done で自動的に増えます)')
} else {
  console.log('プロジェクト別(多い順):')
  for (const p of kpi.perProject.slice(0, 8))
    console.log(`  ${p.self ? '[OG] ' : ''}${p.name}: 累計 ${p.total}(直近28日 ${p.recent})`)
}

// ── 2) UI スクリーンショット(--project 指定時のみ)────────────────────────────
if (!project) {
  console.log('\nUI の目視まで行うには: node scripts/verify-landed-panel.mjs --project "<カード名>"')
  process.exit(0)
}

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error('✗ playwright が読めません — リポジトリのルートで実行していますか?(npm ci 済みが前提)')
  process.exit(1)
}
const launch = async () => {
  const tries = [
    () => chromium.launch(), // playwright 自身のブラウザ(e2e を回した機体には入っている)
    () => chromium.launch({ channel: 'chrome' }), // 無ければ OS の Chrome で代用
    ...(process.env.OPENGROUND_CHROMIUM
      ? [() => chromium.launch({ executablePath: process.env.OPENGROUND_CHROMIUM })]
      : []),
  ]
  for (const t of tries) {
    try {
      return await t()
    } catch {
      /* 次の手へ */
    }
  }
  console.error(
    '✗ ブラウザを起動できません — `npx playwright install chromium` を一度実行するか、' +
      'OPENGROUND_CHROMIUM=<chromium 実体のパス> を付けて再実行してください。',
  )
  process.exit(1)
}
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const out = (name) => join(tmpdir(), `og-landed-${name}-${Date.now()}.png`)
const saved = []
const shot = async (name) => {
  const p = out(name)
  await page.screenshot({ path: p })
  saved.push(p)
}

await page.goto(origin, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)

// 歓迎画面はブラウザプロファイル毎(localStorage)なので、Playwright の
// 新規コンテキストでは既存ユーザーの機体でも毎回出る — 通過して Ground へ。
const getStarted = page.getByText(/GET STARTED|はじめる/i).first()
if (await getStarted.count()) {
  await getStarted.click().catch(() => {})
  await page.waitForTimeout(1200)
}

const card = page.getByText(project, { exact: false }).first()
if (!(await card.count())) {
  console.error(`✗ Ground に「${project}」のカードが見つかりません(表示名で指定してください)`)
  await shot('ground')
  console.log(`  現状のスクリーンショット: ${saved.at(-1)}`)
  await browser.close()
  process.exit(1)
}
await card.click()
await page.waitForTimeout(500)
await card.dblclick().catch(() => {})
await page.waitForTimeout(1500)

await page.getByText(/^(swarm|スウォーム)$/i).first().click()
await page.waitForTimeout(1200)

const mgr = page.locator('button, [role=tab]').filter({ hasText: /^\s*(manager|マネージャー)\s*$/i }).first()
if (!(await mgr.count())) {
  await shot('swarm-idle')
  console.log('△ MANAGER ビューが見つかりません — エンジン停止中でオンボーディング表示のはずです。')
  console.log('  エンジンを起動(Swarm タブ右上の Start)してから再実行してください(このスクリプトは押しません)。')
  console.log(`  スクリーンショット: ${saved.at(-1)}`)
  await browser.close()
  process.exit(0)
}
await mgr.click()
await page.waitForTimeout(1200)
if (dark) {
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForTimeout(400)
}
const heading = page.getByText(/着地 \/ 週|Landed \/ week/).first()
const visible = await heading.isVisible().catch(() => false)
await shot(dark ? 'manager-dark' : 'manager')
console.log(`\n着地パネルの見出し: ${visible ? '✓ 表示されています' : '✗ 見えていません(サーバ未回答 or 旧ビルド?)'}`)
console.log(`スクリーンショット: ${saved.at(-1)}`)
await browser.close()
process.exit(visible ? 0 : 1)
