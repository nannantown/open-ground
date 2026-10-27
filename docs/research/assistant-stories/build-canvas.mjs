// Draws the Canvas page 「アシスタント: 使う場面と困りごと」 on the OPEN GROUND
// project from stories.mjs, through the running app's canvas API (:47776).
//   node docs/research/assistant-stories/build-canvas.mjs
// Re-running replaces the page's elements (same canvas id, OCC rev respected).
// Layout follows the iPhone page (openground-ios scripts/usage-stories/canvas.mjs):
// plain text cells + thin rules, mocks with theme:'auto' (prefers-color-scheme).
import { randomUUID } from 'node:crypto'
import { GROUPS, STORIES, SOURCES, priority, iosCell } from './stories.mjs'

const OG = process.env.OG || 'http://127.0.0.1:47776'
// The registered project whose folder is named "OPEN GROUND" (or OG_PROJECT=<path>).
const reg = await (await fetch(`${OG}/api/projects`)).json()
const PROJECT = process.env.OG_PROJECT || (reg.projects ?? reg.settings.projects).find((p) => p.path.endsWith('/OPEN GROUND')).path
const NAME = 'アシスタント: 使う場面と困りごと'
const FONT = 'var(--font-instrument-sans), "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans JP", ui-sans-serif, system-ui, sans-serif'
const RULE = '#9A9184' // mid grey, visible on both canvas themes

const els = []
const text = (x, y, t, { size = 22, weight = 400, width } = {}) =>
  els.push({ id: randomUUID(), type: 'text', x, y, text: t, fontSize: size, fontWeight: weight, fontFamily: FONT, lineHeight: 1.5,
    ...(width ? { width, textSizing: 'auto-height' } : { textSizing: 'auto-width' }), opacity: 1 })
const rule = (x, y, w, h = 1) =>
  els.push({ id: randomUUID(), type: 'shape', shapeKind: 'rect', x, y, width: w, height: h, text: '', fill: RULE, strokeWidth: 0, opacity: 1 })
const mock = (x, y, w, h, name, html) =>
  els.push({ id: randomUUID(), type: 'mock', x, y, width: w, height: h, name, theme: 'auto', framework: 'html', text: html, opacity: 1 })

// Wrapped line count for a fixed-width cell (full-width glyph = 1em, ASCII ≈ .56em).
const lines = (t, width, size) =>
  t.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil([...l].reduce((w, c) => w + (c.charCodeAt(0) < 0x2e80 ? 0.56 : 1), 0) * size / (width * 0.92))), 0)

// ── mocks ────────────────────────────────────────────────────────────────────
const CSS = `<style>
:root{--page:#F2EDDE;--bg:#F8F4E8;--plane:#E8E1D0;--ink:#2A1F1A;--muted:#4C3D30;--faint:#705E4C;--line:#D6C9AC;--lstrong:#B8A988;--acc:#B23A2C;--onacc:#FFFFFF;
 --run:#2C5E9F;--done:#256B3B;--ask:#765C00;--asksoft:#F1E6C4}
@media (prefers-color-scheme:dark){:root{--page:#2A1F1A;--bg:#362A22;--plane:#413631;--ink:#F8F4E8;--muted:#DDD8CC;--faint:#C9BDAA;--line:#4A3A2E;--lstrong:#5F4C3C;--acc:#F29580;--onacc:#2A1F1A;
 --run:#86B6EE;--done:#86CC8E;--ask:#E8C14A;--asksoft:#3E3120}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--page);color:var(--ink);font:14px/1.55 "Instrument Sans","Hiragino Sans","Hiragino Kaku Gothic ProN",system-ui,sans-serif;line-break:strict;word-break:auto-phrase;overflow:hidden}
.win{position:absolute;inset:14px;display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 14px 34px rgba(0,0,0,.18)}
.hd{display:flex;align-items:center;gap:8px;font-weight:600}
.mk{position:relative;width:22px;height:22px;border-radius:50%;background:var(--acc);flex:none}
.mk i{position:absolute;right:-3px;top:-3px;width:10px;height:10px;border-radius:50%;background:var(--ask);border:2px solid var(--bg)}
.feed{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.me{align-self:flex-end;max-width:82%;background:var(--plane);padding:6px 10px;border-radius:12px 12px 4px 12px}
.re{align-self:flex-start;max-width:92%}
.cap{font-size:12px;font-weight:600;color:var(--faint)}
.box{border:1px solid var(--lstrong);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.row{display:flex;align-items:center;gap:8px}.row .t{flex:1;min-width:0}.row .s{color:var(--muted);font-size:13px}
.dot{width:9px;height:9px;border-radius:50%;flex:none}.run{background:var(--run)}.ask{background:var(--ask)}
.ok{color:var(--done);flex:none}
.cv{color:var(--faint);flex:none}
.nm{font-weight:600}
.btns{display:flex;gap:8px;justify-content:flex-end}
.b{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--lstrong);background:transparent;color:var(--ink);font:inherit;font-weight:500;display:flex;align-items:center}
.b.p{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.askbox{border:1.5px solid var(--ask);background:var(--asksoft)}
.wide{justify-content:flex-start;width:100%}
.cmp{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:7px 10px;color:var(--faint)}
.cmp .f{flex:1}svg{display:block}
</style>`
const CHECK = '<svg class="ok" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>'
const CHEV = '<svg class="cv" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
const ICON = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const COMPOSER = `<div class="cmp"><span class="f">話しかける…</span>${ICON('<path d="M12 5v14M5 12h14"/>')}${ICON('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>')}${ICON('<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>')}</div>`
const page = (body, { badge = false } = {}) =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8">${CSS}</head><body><div class="win"><div class="hd"><span class="mk">${badge ? '<i></i>' : ''}</span>アシスタント</div><div class="feed">${body}</div>${COMPOSER}</div></body></html>`
const lamp = (k) => (k === 'done' ? CHECK : `<span class="dot ${k}"></span>`)
const row = (k, name, t, chev = false) => `<div class="row">${lamp(k)}<span class="t"><span class="nm">${name}</span>　<span class="s">${t}</span></span>${chev ? CHEV : ''}</div>`

const MOCKS = [
  { ids: 'M01・M02・M20', title: '開いたら、全体と離れていた間のこと', html: page(
    `<div class="cap">離れていた間に</div>
     <div class="box">${row('done', 'NENE', '送料の表示の直しが終わりました')}${row('ask', 'OPEN GROUND', '社長から質問が1件')}${row('run', 'LastBox', '採寸の画面を作り始めました')}</div>
     <div class="cap">プロジェクト</div>
     <div class="box">${row('ask', 'OPEN GROUND', '質問1・作業中2', true)}${row('run', 'LastBox', '作業中1', true)}${row('done', 'NENE', '終わった1', true)}</div>`, { badge: true }) },
  { ids: 'M15・M16・M17', title: '社長と司令官のやりとりを要約して伝える', html: page(
    `<div class="me">OPEN GROUNDどうなってる？</div>
     <div class="re">差し戻しが1件あって、いま直しています。ほかは順調です。</div>
     <div class="box"><div class="row"><span class="t nm">OPEN GROUND・社長と司令官</span><span class="s">直近2時間</span></div>
       ${row('done', '', '通知の色の直しが入りました')}${row('run', '', 'Canvas の写真の件は差し戻し、直し中')}${row('ask', '', '公開してよいか、あなたの答え待ち')}
       <div class="row"><span class="t s">やりとり 12件</span>${CHEV}</div></div>
     <div class="me">差し戻しの理由は？</div>
     <div class="re">写真が暗い画面で読めなかったためです。司令官が直し方を伝えました。</div>`) },
  { ids: 'M07・M08', title: '話すだけで、どのプロジェクトにも頼む', html: page(
    `<div class="me">NENEで、注文画面の送料を地域ごとに分けて出すよう頼んで</div>
     <div class="re">大きめなので、NENEの社長に送る案にしました。</div>
     <div class="box"><div class="cap">社長への頼みごとの案</div>
       <div class="row"><span class="s">宛先</span><span class="nm">NENEの社長</span></div>
       <div class="nm">送料を地域ごとに出す</div>
       <div>注文画面で、送料を地域ごとに分けて出す。離島は別の料金。</div>
       <div><span class="s">完了の条件：</span>3つの地域で画面を確かめる</div>
       <div class="btns"><span class="b">やめる</span><span class="b p">送る</span></div></div>`) },
  { ids: 'M19・M20', title: '質問に、アシスタントの画面から答える', html: page(
    `<div class="re">質問が1件来ています。</div>
     <div class="box askbox"><div class="cap">OPEN GROUNDの社長から質問</div>
       <div class="nm">今日のうちに新しい版を公開してよいですか？</div>
       <div class="s">公開すると、使っている人のアプリが今夜更新されます。A 今日公開する、B 明日の朝にする、のどちらかで答えてください。</div>
       <span class="b wide">A　今日公開する</span><span class="b wide">B　明日の朝にする</span>
       <span class="b wide s">ほかの答えを書く</span></div>`, { badge: true }) },
  { ids: 'M21・M22', title: '終わったことと出したカードを知らせる', html: page(
    `<div class="me">LastBoxで採寸の説明文を直して</div>
     <div class="re">出しました。動きがあればここでお知らせします。</div>
     <div class="cap">出したカード</div>
     <div class="box">${row('done', 'NENE', '送料を地域ごとに出す・完了')}${row('ask', 'OPEN GROUND', '公開の準備・質問1')}${row('run', 'LastBox', '採寸の説明文を直す・作業中')}</div>
     <div class="row">${CHECK}<span class="t">NENEの「送料を地域ごとに出す」が終わりました。</span>${CHEV}</div>`) },
]

// ── layout ───────────────────────────────────────────────────────────────────
text(0, -250, NAME, { size: 56, weight: 600 })
text(0, -160, '直すものは番号で選んでください（例：M15、M19）', { size: 26 })

text(0, 0, '優先度の高い5件の画面の案', { size: 40, weight: 600 })
MOCKS.forEach((m, i) => {
  const x = i * 540
  text(x, 80, `${m.ids}\n${m.title}`, { size: 22, weight: 600, width: 460 })
  mock(x, 170, 460, 560, `${m.ids} 案`, m.html)
})

const COLS = [
  ['番号', 90], ['場面', 460], ['今の困りごと', 560], ['Dots では', 520], ['直し方の案', 620], ['iPhone', 200], ['度合い・頻度', 170], ['優先度', 90],
]
const GAP = 30
const TABLE_W = COLS.reduce((w, [, c]) => w + c, 0) + GAP * (COLS.length - 1)
let y = 860
text(0, y, `ストーリーの一覧（${STORIES.length}件）`, { size: 40, weight: 600 })
y += 90
for (const [gi, g] of GROUPS.entries()) {
  text(0, y, g, { size: 30, weight: 600 })
  y += 60
  let x = 0
  for (const [h, w] of COLS) { text(x, y, h, { size: 22, weight: 600, width: w }); x += w + GAP }
  y += 44
  rule(0, y, TABLE_W, 2)
  y += 16
  for (const s of STORIES.filter((r) => r.g === gi)) {
    const cells = [s.id, s.scene, s.now, s.dots, s.fix, iosCell(s), `${s.deg}・${s.freq}`, priority(s)]
    let cx = 0, n = 1
    cells.forEach((c, i) => {
      const [, w] = COLS[i]
      const bold = i === 0 || i === 1 || (i === 7 && c === '高')
      text(cx, y, c, { size: 22, weight: bold ? (i === 7 ? 700 : 600) : 400, width: w })
      n = Math.max(n, lines(c, w, 22))
      cx += w + GAP
    })
    y += n * 33 + 24
    rule(0, y, TABLE_W)
    y += 16
  }
  y += 50
}

const notes = [
  ['優先度', '困る度合い（大3・中2・小1）と頻度（毎日3・週に数回2・たまに1）を掛けて、6以上が高、3〜4が中、それより下が低。度合いと頻度はオーナーの使い方からの見立てで、測ったものではありません。iPhone の一覧と同じ決め方です。'],
  ['iPhone', '「共通 S○○」は iPhone の「使う場面と困りごと」の同じ番号と同じ体験にするもの。「Macだけ」は Mac の画面だけの話。iPhone の一覧に無い共通の話は「共通（iPhone の一覧に無い）」と書きました。'],
  ['確認', '作業を頼むときは、今と同じく毎回ボタンで決めます（2026-10-21 オーナー決定）。どの案もこの決まりを変えません。'],
  ['ことば', '社長＝プロジェクトの窓口。司令官＝ワーカーをまとめる係。進み具合＝状況。右下の丸＝アシスタントを開く印。カード案・伝言の案は、ボタンを押すまで何も起きません。'],
]
for (const [h, t] of notes) {
  text(0, y, h, { size: 22, weight: 600, width: 160 })
  text(200, y, t, { size: 22, width: 1800 })
  y += lines(t, 1800, 22) * 33 + 24
}
y += 40
text(0, y, 'Dots の出典（2026-10-22 確認）', { size: 30, weight: 600 })
y += 60
for (const [k, u] of SOURCES) {
  text(0, y, k, { size: 20, weight: 600 })
  text(80, y, u, { size: 20 })
  y += 34
}

// ── save ─────────────────────────────────────────────────────────────────────
const api = async (method, qs, body) => {
  const r = await fetch(`${OG}/api/project/canvases${qs}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  if (!r.ok) throw new Error(`${method} ${qs} → ${r.status} ${await r.text()}`)
  return r.json()
}
const q = (o) => '?' + new URLSearchParams(o).toString()
const list = await api('GET', q({ path: PROJECT }))
const entries = Array.isArray(list) ? list : list.canvases ?? list.list ?? []
let id = entries.find((c) => c.name === NAME)?.id
if (!id) id = (await api('POST', q({ action: 'create' }), { path: PROJECT, name: NAME })).canvas.id
const cur = await api('GET', q({ path: PROJECT, id }))
const saved = await api('POST', '', { path: PROJECT, canvas: { ...cur, elements: els, viewport: { x: 40, y: 320, zoom: 0.2 } } })
console.log(`saved ${NAME} id=${id} rev=${saved.rev} elements=${els.length} height≈${y}`)
