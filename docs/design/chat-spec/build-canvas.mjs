// Draws the Canvas page 「チャットの違い」 on the OPEN GROUND project (docs/CHAT_SPEC.md §11):
// today's iPhone and Mac chat side by side (real screenshots), the owner's choices C1–C6,
// and the list of differences with the proposed action.
//   node docs/design/chat-spec/build-canvas.mjs <ios shots dir> <desktop shots dir>
// iOS shots: openground-ios scripts/current-app/shots.mjs (origin/main, Simulator, ja-JP).
// Desktop shots: docs/design/chat-spec/desktop-shots.mjs (isolated server).
// Re-running replaces the page's elements and reuses uploaded screenshots.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [IOS, MAC] = process.argv.slice(2)
if (!IOS || !MAC) throw new Error('usage: build-canvas.mjs <ios shots dir> <desktop shots dir>')
const OG = process.env.OG || 'http://127.0.0.1:47776'
const reg = await (await fetch(`${OG}/api/projects`)).json()
const PROJECT = process.env.OG_PROJECT || (reg.projects ?? reg.settings.projects).find((p) => p.path.endsWith('/OPEN GROUND')).path
const NAME = 'チャットの違い'
const FONT = 'var(--font-instrument-sans), "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans JP", ui-sans-serif, system-ui, sans-serif'
const RULE = '#9A9184' // mid grey, visible on both canvas themes

const els = []
// Free text: no textColor, so the app picks a readable ink for each canvas theme.
const text = (x, y, t, { size = 22, weight = 400, width } = {}) =>
  els.push({ id: randomUUID(), type: 'text', x, y, text: t, fontSize: size, fontWeight: weight, fontFamily: FONT, lineHeight: 1.5,
    ...(width ? { width, textSizing: 'auto-height' } : { textSizing: 'auto-width' }), opacity: 1 })
const rule = (x, y, w, h = 1) =>
  els.push({ id: randomUUID(), type: 'shape', shapeKind: 'rect', x, y, width: w, height: h, text: '', fill: RULE, strokeWidth: 0, opacity: 1 })
// Wrapped line count for a fixed-width cell (full-width glyph = 1em, ASCII ≈ .56em).
const lines = (t, width, size) =>
  t.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil([...l].reduce((w, c) => w + (c.charCodeAt(0) < 0x2e80 ? 0.56 : 1), 0) * size / (width * 0.92))), 0)

// ── canvas + screenshots ─────────────────────────────────────────────────────
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
const assets = Object.fromEntries((cur.elements ?? []).filter((e) => e.type === 'image').map((e) => [e.text, e.assetId]))
const upload = async (file, buf) => {
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), file)
  const r = await fetch(`${OG}/api/canvas/asset?path=${encodeURIComponent(PROJECT)}&canvasId=${id}`, { method: 'POST', body: form })
  if (!r.ok) throw new Error(`upload ${file}: ${r.status} ${await r.text()}`)
  return (await r.json()).assetId
}
/** A screenshot at width w; returns its drawn height. `who` = 'ios' | 'mac'. */
const shot = async (who, file, x, y, w) => {
  const buf = readFileSync(`${who === 'ios' ? IOS : MAC}/${file}`)
  const h = Math.round(w * buf.readUInt32BE(20) / buf.readUInt32BE(16))
  const key = `${who}-${file}`
  els.push({ id: randomUUID(), type: 'image', x, y, width: w, height: h, text: key, assetId: (assets[key] ??= await upload(key, buf)), opacity: 1 })
  return h
}

// ── header ───────────────────────────────────────────────────────────────────
text(0, -250, NAME, { size: 56, weight: 600 })
text(0, -160, '迷うところだけ選んでください（C1〜C6）。ほかは下の一覧の案で進めます', { size: 26 })

// ── 1. today's screens ───────────────────────────────────────────────────────
const IOS_SHOTS = [['chat', '会話'], ['empty', '空のとき'], ['typing', '入力中'], ['proposal', '案の枠'], ['partners', '話す相手'], ['call', '通話'], ['offline', 'Macが停止中']]
const MAC_SHOTS = [['chat', '会話'], ['empty', '空のとき'], ['typing', '入力中'], ['proposal', '案の枠'], ['call', '通話'], ['error', '答えられなかったとき']]
const IW = 260, MW = 340, SG = 40
let y = 0
text(0, y, '今の画面', { size: 40, weight: 600 })
y += 80
for (const [theme, label] of [['light', '明るい画面'], ['dark', '暗い画面']]) {
  text(0, y, label, { size: 30, weight: 600 })
  y += 60
  text(0, y, 'iPhone', { size: 26, weight: 600 })
  let x = 160, h = 0
  for (const [f, cap] of IOS_SHOTS) {
    text(x, y, cap, { size: 22 })
    h = Math.max(h, await shot('ios', `${theme}-${f}.png`, x, y + 44, IW))
    x += IW + SG
  }
  y += h + 90
  text(0, y, 'Mac', { size: 26, weight: 600 })
  x = 160; h = 0
  for (const [f, cap] of MAC_SHOTS) {
    text(x, y, cap, { size: 22 })
    h = Math.max(h, await shot('mac', `${theme}-${f}.png`, x, y + 44, MW))
    x += MW + SG
  }
  y += h + 120
}

// ── 2. choices ───────────────────────────────────────────────────────────────
const CHOICES = [
  { id: 'C1', title: '色', ios: 'light-chat.png', mac: 'light-chat.png',
    a: '両方をiPhoneの白と黒にする（強調は青）。Macではチャットの窓だけ周りの画面と色が変わる',
    b: '両方をMacの生成りと焦げ茶にする（強調は朱）。iPhoneの見た目が変わる',
    rec: 'A（「iPhoneの仕様に合わせる」というオーナーの方針に沿う）' },
  { id: 'C2', title: '通話ボタンの場所', ios: 'light-empty.png', mac: 'light-empty.png',
    a: 'iPhoneと同じ。上の段の右に通話。入力欄の右はマイクと送信が入れ替わる',
    b: 'Macと同じ。入力欄の右が、空のときは通話、書いたら送信になる',
    rec: 'A' },
  { id: 'C3', title: 'Macでも社長とチャットする', ios: 'light-partners.png', mac: 'light-chat.png',
    a: 'Macの窓にも「話す相手」を付け、プロジェクトの社長ともこの窓で話せる（iPhoneと同じ）',
    b: 'Macの窓はアシスタントだけ。社長とは今のまま下の社長の席で話す',
    rec: 'A' },
  { id: 'C4', title: 'ボタンに言葉を添えるか', ios: 'dark-call.png', mac: 'dark-call.png',
    a: '両方に出す（通話のキーの下の「話す」「終了」「消音」、聞き取り中の「タップで入力欄へ」）。Macの「ボタンに名前を書かない」決まりを、チャットだけ変えることになる',
    b: '両方とも出さない。アイコンだけにし、名前はマウスを乗せたときと読み上げで分かる。iPhoneの今の画面から言葉が減る',
    rec: 'B（ボタンに名前を書かない、今の決まりに沿う）' },
  { id: 'C5', title: '読み上げの声', ios: 'light-settings.png', mac: null,
    a: '両方をVOICEVOX（Nemoなど）にして、同じ声にする。Macのアプリが重くなる',
    b: '声は端末ごとのまま。iPhoneはNemoなど、MacはMacの声',
    rec: 'B（同じ声にする利点より、Macが重くなる損が大きい）' },
  { id: 'C6', title: '返事の吹き出し', ios: 'light-chat.png', mac: 'light-chat.png',
    a: '両方とも、返事も吹き出しに入れる（iPhoneと同じ）',
    b: '両方とも、返事は吹き出しなしの文字だけ（Macと同じ）',
    rec: 'A' },
]
text(0, y, '選んでほしいところ', { size: 40, weight: 600 })
y += 90
const CW = 240, MCW = 340, OX = CW + 40 + MCW + 60
for (const c of CHOICES) {
  text(0, y, `${c.id}　${c.title}`, { size: 30, weight: 600 })
  y += 64
  text(0, y, 'iPhone', { size: 20, weight: 600 })
  let h = await shot('ios', c.ios, 0, y + 36, CW)
  text(CW + 40, y, 'Mac', { size: 20, weight: 600 })
  if (c.mac) h = Math.max(h, await shot('mac', c.mac, CW + 40, y + 36, MCW))
  else text(CW + 40, y + 36, '声は選べない', { size: 22, width: MCW })
  let oy = y
  for (const [k, t] of [['A', c.a], ['B', c.b]]) {
    text(OX, oy, k, { size: 28, weight: 600 })
    text(OX + 60, oy, t, { size: 26, width: 900 })
    oy += lines(t, 900, 26) * 39 + 30
  }
  text(OX, oy + 10, `おすすめ　${c.rec}`, { size: 24, weight: 600, width: 960 })
  y += Math.max(h + 36, oy - y + 60) + 70
  rule(0, y - 35, OX + 960)
}

// ── 3. the list of differences ───────────────────────────────────────────────
const ROWS = [
  ['D01', '色', '白と黒、強調は青', '生成りと焦げ茶、強調は朱', '選んでください（C1）'],
  ['D02', '吹き出し', '自分は薄い青、返事は薄い灰色。角が大きく丸い', '自分だけ吹き出し。返事は文字だけ', '選んでください（C6）'],
  ['D03', '文字の大きさ', 'iPhoneの標準の大きさ', 'iPhoneより少し小さい（Macの標準）','大きさは違っていてよい（画面の標準が違う）。行の高さは両方1.5倍にそろえる'],
  ['D04', '上の段', '左にメニュー、真ん中に印と名前、右に通話', '名前だけ', '選んでください（C2）'],
  ['D05', '通話ボタンの場所', '上の段の右', '入力欄の右（何も書いていないとき）', '選んでください（C2）'],
  ['D06', '入力欄', '「メッセージ」。＋で写真。右はマイクと送信が入れ替わる。5行まで広がる', '「話しかける…」。写真・マイク・通話が並ぶ。1行だけ', 'ことば・＋・5行はiPhoneに合わせる。右のボタンはC2で決まる'],
  ['D07', '社長と話す', 'メニューで相手を選ぶ。相手ごとに会話が分かれる', '窓はアシスタントだけ。社長は下の席', '選んでください（C3）'],
  ['D08', '名前と色を変える', 'できない（Macで決めたものを出す）', '入力欄の左の印から', 'iPhoneに合わせる（Macは設定へ移す）'],
  ['D09', 'マイク', '押すと聞き取り、もう一度で入力欄へ。90秒で止まる。聞き取れないと声で知らせる', '同じ動き。止まる時間なし。聞き取り中に打つと、打った字が優先', '両方を新しくする（90秒で止める。名前は「話す」）'],
  ['D10', '写真', '＋から「写真を選ぶ」「画像をペースト」。会話には「写真」の文字だけ', 'ボタンからファイルを選ぶだけ。会話に写真が出る', '両方を新しくする（選ぶ・貼り付けを両方に。会話に写真を出す）'],
  ['D11', '通話の画面', '全画面。話す・終了・消音。会話に戻れる\n5分黙ると切れる', '窓の中。スピーカー・終了・消音。閉じると通話も終わる', 'iPhoneに合わせる'],
  ['D12', 'スピーカー', '声の出る場所を変える（イヤホンのときだけ出る）', '読み上げのオンとオフ', 'Macのボタンをなくす（名前が同じで意味が違うため）。通話中ずっと読み上げを切る使い方はなくなり、その都度止める'],
  ['D13', '画面に書かれた言葉', '通話のキーの下の名前。聞き取り中の「タップで入力欄へ」', 'なし（マウスを乗せると名前が出る）', '選んでください（C4）'],
  ['D14', '読み上げの声', 'VOICEVOXのNemoなど3つから選ぶ', 'Macの声', '選んでください（C5）'],
  ['D15', '読み上げる時', '通話中、ロック中、ほかの画面のとき', '通話中だけ', '違っていてよい（ロック中に聞くのはiPhoneだけ）'],
  ['D16', '案の枠', '「カード案」「司令官へ」が出る。長いと枠を上下に送って読める。終わると「出しました」など', '見出しなし。長いと「長いので社長に頼んでね」。終わると印と題だけ', 'iPhoneに合わせる'],
  ['D17', '考えている間', '印が光るだけ', '印と「ちょっと待ってね」などの一言', 'Macに合わせる'],
  ['D18', '送れなかったとき', '吹き出しの下に「未送信」。入力欄は空になり、理由は声で知らせる', '赤い文字で理由。文は入力欄に戻る', '両方を新しくする（「未送信」と理由を1行。文は入力欄に戻す）'],
  ['D19', '空の会話', '「何から始めますか？」と3つのボタン', '入力欄だけ', '違っていてよい（Macはすぐ文字が打てる）'],
  ['D20', 'つながりの状態', '名前の下に「接続中」など', 'なし', '違っていてよい（Mac自身なので表示は要らない）'],
  ['D21', '会話を畳む', 'なし', '最後のやりとりだけにできる', '違っていてよい（Macの窓は作業の上に浮く）'],
  ['D22', '通話の記録', '会話に「通話 1:42」の行（電話の印つき）', '普通の自分の吹き出しとして出る', 'iPhoneに合わせる（電話の印を付ける）'],
  ['D23', 'ことば', '「送信」「写真を外す」など', '「送る」「写真を取り消す」など', '両方を新しくする（1つの表にそろえる）'],
  ['D24', 'キーボード', '改行キーで送信。Spaceでマイク', 'Enterで送信。Escで閉じる。通話中のSpaceで読み上げを止める', '両方を新しくする（Spaceは両方「話す」）'],
  ['D25', '名前の色の使いどころ', '通話中に通話ボタンが光るだけ', '通話と送信のボタンの色', 'iPhoneに合わせる'],
  ['D26', '窓と押せる大きさ', '全画面。指で押す大きさ', '小さな窓。マウスで押す大きさ', '違っていてよい（指とマウス）'],
  ['D27', '通話の話し終わり', '声が止まって1.2秒で区切る', '語尾で変える。文の終わりは0.5秒、「〜で」「〜けど」などは1.4秒、ほかは0.8秒（オーナーが10月7日に調整）', 'Macに合わせる（iPhoneも語尾で長さを変える）'],
]
const COLS = [['番号', 90], ['項目', 280], ['iPhone（今）', 600], ['Mac（今）', 600], ['案', 700]]
const GAP = 30
const TABLE_W = COLS.reduce((w, [, c]) => w + c, 0) + GAP * (COLS.length - 1)
y += 40
text(0, y, `違いの一覧（${ROWS.length}件）`, { size: 40, weight: 600 })
y += 90
let x = 0
for (const [h, w] of COLS) { text(x, y, h, { size: 22, weight: 600, width: w }); x += w + GAP }
y += 44
rule(0, y, TABLE_W, 2)
y += 16
for (const r of ROWS) {
  let cx = 0, n = 1
  r.forEach((c, i) => {
    const [, w] = COLS[i]
    text(cx, y, c, { size: 22, weight: i < 2 || c.startsWith('選んで') ? 600 : 400, width: w })
    n = Math.max(n, lines(c, w, 22))
    cx += w + GAP
  })
  y += n * 33 + 24
  rule(0, y, TABLE_W)
  y += 16
}
y += 40
text(0, y, '画面写真　iPhone＝2026-10-27時点の最新の版をシミュレータで撮影。Mac＝同じ日のアシスタントの窓。話の中身はどちらも見本', { size: 20, width: TABLE_W })

// ── save ─────────────────────────────────────────────────────────────────────
const saved = await api('POST', '', { path: PROJECT, canvas: { ...cur, elements: els, viewport: { x: 40, y: 320, zoom: 0.15 } } })
console.log(`saved ${NAME} id=${id} rev=${saved.rev} elements=${els.length} height≈${y}`)
