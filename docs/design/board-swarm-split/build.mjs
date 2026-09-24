// Creates the owner-review Canvas 「Board と Swarm を1画面に（案）」 through the
// running app's Canvas API (create → one OCC save). Never touches other canvases:
// refuses to run if a canvas with the same name already exists.
// Usage: node docs/design/board-swarm-split/build.mjs "<project path>" [apiBase]
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { STATES, render } from './states.mjs'

const NAME = 'Board と Swarm を1画面に(案)'
const [projectPath, base = 'http://127.0.0.1:47776'] = process.argv.slice(2)
if (!projectPath) throw new Error('usage: build.mjs <project path> [apiBase]')
const here = path.dirname(new URL(import.meta.url).pathname)
const proto = fs.readFileSync(path.join(here, 'prototype.html'), 'utf8')
const alt = fs.readFileSync(path.join(here, 'alt.html'), 'utf8')

const api = async (url, body) => {
  const r = await fetch(base + url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  if (!r.ok) throw new Error(`${url} → ${r.status} ${await r.text()}`)
  return r.json()
}

const els = []
const add = (e) => { const el = { id: randomUUID(), ...e }; els.push(el); return el }
const frame = (x, y, width, height, text) => add({ type: 'frame', x, y, width, height, text })
const sticky = (x, y, width, height, text, color, parentId) => add({ type: 'sticky', x, y, width, height, text, color, fontSize: 22, parentId })
const mock = (x, y, width, height, name, html, theme, parentId) => add({ type: 'mock', x, y, width, height, name, text: html, framework: 'html', theme, parentId })

const YELLOW = '#ECD79A', GREEN = '#CDE0B8', BLUE = '#B8D4E0', PINK = '#F4B8A8', PAPER = '#F8F4E8'

add({ type: 'text', x: 0, y: -330, text: NAME, fontSize: 56 })
sticky(0, -240, 1320, 200, '見方：①〜⑤ が、Board の中に Swarm を入れたときの画面の移り変わりです。どの見本も本物のように触れます — 見本を一度クリックすると、ボタンを押す・真ん中の境目をドラッグする・社長に書き込む、ができます。見本のいちばん上の「見本の操作」でライト／ダークを切り替えられます（この縞の帯と、黒い点線の囲みは説明用で、実際の画面には出ません）。右下の2つは、比べて見送った別の形です。', PAPER)
sticky(1400, -240, 1320, 200, '変わること：上のタブから「Swarm」がなくなり、Board の右上の「Swarm」ボタンで下の段に出します。いまの Board 右側の社長の引き出しもなくなり、下の段ひとつにまとまります。いまの Swarm タブにあった「開始／停止」なども、下の段の上の帯に全部移ります。境目の位置は覚えておくので、次に開いたときも同じ大きさで出ます。', GREEN)
sticky(2800, -240, 1320, 200, 'ボタンの小さな印：緑の点＝Swarm が動いている。黄色の「質問 2」＝あなたの答えを待っていることの数。赤い点＝うまく動いていない。Swarm をしまっていても印は見えるので、見落としがありません。', YELLOW)

sticky(4200, 0, 700, 1080, '細かい決めごと\n・Swarm ボタンは、Swarm を使える人にだけ出ます（いま Swarm タブが見えている人と同じ）。\n・「停止」は新しい仕事を配るのをやめるだけ。社長との会話は消えません。\n・カードを開いたときの詳しい画面は、上の Board の中に出ます。下の Swarm は隠れません。\n・ワーカーが多いときは横にずらして見ます。質問のあるワーカーがいちばん左に来ます。\n・しまい方は2つ：右上の Swarm ボタンか、下の段の ✕。境目をいちばん下まで下げると細い帯になり、押すと元の大きさで戻ります。', YELLOW)

const cells = [
  ['hidden', 0, 0, '① Swarm を出していないとき（Board だけ）', '上のタブから Swarm がなくなり、いつもどおり Board を広く使えます。右上の「Swarm」ボタンを押すと、下に Swarm が出ます（もう一度押すとしまえます）。'],
  ['split', 1400, 0, '② 上下に分けたとき（上 Board ／ 下 Swarm）', 'Board のカードを見ながら、下で社長・司令官・ワーカーの様子が一度に見えます。社長の欄のいちばん下に書き込めば、そのまま社長と話せます。ワーカーからの質問も社長がまとめて聞くので、答えは社長に書くだけです。'],
  ['large', 2800, 0, '③ 境目を上げて Swarm を大きくしたとき', '真ん中の境目をつまんで上に動かすと Swarm が大きくなり、社長とのやりとりやワーカーの作業の様子をたっぷり読めます。ダブルクリックで元の大きさ、いちばん下まで下げると細い帯にたためます（帯を押すと戻ります）。'],
  ['off', 0, 1200, '④ Swarm がまだオフのとき', 'Swarm をまだ一度も動かしていないときは、下の段に短い説明と「Swarm をオンにする」ボタンが出ます。押すとその場で動き出し、②の画面になります。いらなければ右上の ✕ でしまえます。'],
]
for (const [k, x, y, label, can] of cells) {
  const s = STATES[k]
  const f = frame(x, y, 1320, 1080, label)
  mock(x + 20, y + 40, s.w, s.h, label, render(proto, s.cfg), s.cfg.theme, f.id)
  sticky(x + 20, y + 860, 1280, 190, 'できること：' + can, BLUE, f.id)
}
{
  const s = STATES.narrow
  const f = frame(1400, 1200, 760, 1170, '⑤ 狭い画面のとき')
  mock(1420, 1240, s.w, s.h, '⑤ 狭い画面のとき', render(proto, s.cfg), s.cfg.theme, f.id)
  sticky(1420, 2160, 720, 190, 'できること：下の段が「社長／司令官／ワーカー」の切り替えになり、ひとつずつ大きく見られます。いつも社長が最初に出るので、狭くてもすぐ話せます。', BLUE, f.id)
}
{
  const f = frame(2240, 1200, 2640, 1380, '比べて見送った形（代案）')
  mock(2260, 1240, 1280, 800, '代案A 左右に分ける', render(alt, { kind: 'side' }), 'light', f.id)
  mock(3580, 1240, 1280, 800, '代案B 下から重ねて出す', render(alt, { kind: 'overlay' }), 'light', f.id)
  sticky(2260, 2060, 1280, 230, '代案A 左右に分ける → 見送り。Board はカードの列が横に5つ並び、社長・司令官・ワーカーも横に並びます。左右に分けると両方が細くなり、題名や社長の返事が途中で切れます。上下に分ければ、どちらも横幅をまるごと使えます。', PINK, f.id)
  sticky(3580, 2060, 1280, 230, '代案B 下から重ねて出す → 見送り。いまの右の引き出しと同じく Board の上にかぶさるので、下の方のカードが隠れます。「Board を見ながら社長と話す」ができず、開け閉めの手間も残ります。上下に分ければ隠れる所がありません。', PINK, f.id)
  sticky(2260, 2310, 2600, 230, '採用した形：上下に分ける（上 Board ／ 下 Swarm）。ボタンの場所も比べました — 上のタブの並びに置く案もありますが、タブは「別の画面に切り替える所」です。Swarm は同じ画面の中で出し入れするものなので、Board の中（右上の「設定」のとなり）に置く方が迷いません。', GREEN, f.id)
}

const list = await api(`/api/project/canvases?path=${encodeURIComponent(projectPath)}`)
if (list.canvases.some((c) => c.name === NAME)) {
  console.log('canvas already exists — not touching it:', NAME)
  process.exit(1)
}
const created = await api('/api/project/canvases?action=create', { path: projectPath, name: NAME })
const canvas = created.canvas
const saved = await api('/api/project/canvases', {
  path: projectPath,
  canvas: { ...canvas, elements: els, viewport: { x: 60, y: 150, zoom: 0.4 } },
})
console.log(JSON.stringify({ id: saved.id, name: saved.name, rev: saved.rev, elements: saved.elements.length }))
