#!/usr/bin/env node
// scripts/verify-landed-panel.mjs — 「着地 / 週」の読み出し(read-only)
//
// 起動中の OPEN GROUND に対して GET /api/swarm/kpi/landed を叩き、集計(週次
// バケット・self/external・perProject)を人間が読める形で表示する。
//
// 使い方(アプリ起動中に、リポジトリのルートで):
//   node scripts/verify-landed-panel.mjs               # prod(47776)
//   node scripts/verify-landed-panel.mjs --port 5174   # dev サーバ相手
//
// (2026-09-23: 画面の「着地 / 週」パネルはマネージャー席の計器盤ごと撤去された
// ので、以前の --project による画面スクショ(Playwright)は削除。オーナーは社長に
// 「着地は?」と聞けば、社長が同じ API を読んで答える — docs/OUTWARD_TRIAL.md。)
// 403 が返るならサインイン(または OPENGROUND_LOCAL_OWNER=1)を確認する。

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const port = Number(arg('--port') ?? '47776')
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
