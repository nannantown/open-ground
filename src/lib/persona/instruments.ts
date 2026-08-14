// Persona instruments — the four self-report courses on the Persona tab, as
// DATA + PURE SCORING. No React, no fs: the UI renders it and the tests score
// it, so every number on the result sheet is reproducible from these items.
//
// ─── LICENSING / NAMING, THE LOAD-BEARING PART ──────────────────────────────
// MBTI® is a trademark of The Myers-Briggs Company and CliftonStrengths® /
// StrengthsFinder® of Gallup; BOTH instruments' items are proprietary. Nothing
// here reproduces either, and no course is named after them. What we ship:
//   • five-factor  → items in the style of the IPIP (International Personality
//     Item Pool), which is PUBLIC DOMAIN by its authors' explicit release;
//   • type         → the open Jungian-type tradition (OEJTS and successors),
//     freely usable, and labelled in the UI as "MBTI®とは別物";
//   • values       → Schwartz's published theory of basic values (the ten value
//     types are academic literature; the portrait items here are our wording);
//   • work style   → OPEN GROUND's own forced-choice sort, no external source.
// A course's `source` string is shown VERBATIM on its result sheet. Changing an
// instrument without changing that line is how a product starts lying about its
// provenance — personaInstruments.test.ts pins the pairing.
//
// HONEST-MEASUREMENT RULES baked into the scoring below:
//   1. reverse-keyed items exist and are scored reversed (an agree-everything
//      response set must NOT max a scale);
//   2. a bipolar axis reports its MARGIN, and a thin margin is labelled as such
//      ('ほぼ半々') rather than rounded into a confident letter;
//   3. every finding carries the number it came from, so the node minted into
//      the corpus can be traced back to this scoring.

import type { PersonaCourseId, PersonaFinding, PersonaResult } from '../types'

// ── five factors (IPIP-style) ───────────────────────────────────────────────

export const BIG5_DIMS = {
  O: { name: '開放性', hi: '新しい考え方や表現に向かう', lo: '慣れた確かなやり方を守る' },
  C: { name: '誠実性', hi: '計画を立て、最後まで詰める', lo: '状況に合わせて柔らかく動く' },
  E: { name: '外向性', hi: '人と動くことで力が出る', lo: '静かな場所で力が出る' },
  A: { name: '協調性', hi: '相手に合わせ、和を保つ', lo: '率直に言い、線を引く' },
  N: { name: '情動性', hi: '危険や不安を早く察知する', lo: '揺れにくく、落ち着いている' },
} as const

export type Big5Key = keyof typeof BIG5_DIMS

/** [factor, reverse-keyed, item]. Five items per factor, two of them reversed
 *  in most factors — the acquiescence guard. */
export const BIG5_ITEMS: readonly (readonly [Big5Key, 0 | 1, string])[] = [
  ['O', 0, '新しいやり方をまず試してみたくなる'],
  ['O', 0, '抽象的な考えについて考えるのが好きだ'],
  ['O', 1, '決まったやり方から外れるのは落ち着かない'],
  ['O', 0, '芸術や美しいものに強く心が動く'],
  ['O', 1, '想像を広げるより、目の前の事実を扱いたい'],
  ['C', 0, '始めたことは最後まで終わらせる'],
  ['C', 0, '前もって段取りを決めておきたい'],
  ['C', 1, '約束の時間にぎりぎりになりがちだ'],
  ['C', 0, '身のまわりをきちんと整えている'],
  ['C', 1, 'やるべきことを後まわしにしてしまう'],
  ['E', 0, '初対面の人にも自分から話しかける'],
  ['E', 1, '大人数の場では消耗する'],
  ['E', 0, '場の中心にいるのは心地よい'],
  ['E', 1, '一人で過ごす時間で回復する'],
  ['E', 0, '思いついたことをすぐ口に出す'],
  ['A', 0, '相手の立場を思いやってから話す'],
  ['A', 1, '議論では自分の主張を通したい'],
  ['A', 0, '困っている人がいると放っておけない'],
  ['A', 1, '厳しいことでも遠慮なく言う'],
  ['A', 0, '争いごとは避けたい'],
  ['N', 0, '先のことを考えて不安になりやすい'],
  ['N', 1, 'たいていのことでは動じない'],
  ['N', 0, '批判されると長く引きずる'],
  ['N', 1, 'ストレスのかかる場面でも冷静でいられる'],
  ['N', 0, '気分の浮き沈みがはっきりしている'],
]

/** The 5-point agreement scale, low → high. */
export const LIKERT_AGREE = ['まったくちがう', 'あまりちがう', 'どちらともいえない', 'すこしそう', 'とてもそう']
export const LIKERT_IMPORTANT = ['まったく大切でない', 'あまり', 'ふつう', '大切', 'とても大切']

// ── type (open Jungian scales) ──────────────────────────────────────────────

export const TYPE_AXES = [
  { k: 'EI', a: 'E', b: 'I', an: '外向', bn: '内向', q: 'エネルギーの向き' },
  { k: 'SN', a: 'S', b: 'N', an: '感覚', bn: '直観', q: '情報の受け取り方' },
  { k: 'TF', a: 'T', b: 'F', an: '思考', bn: '感情', q: '決めるときの基準' },
  { k: 'JP', a: 'J', b: 'P', an: '判断', bn: '知覚', q: '外の世界への構え' },
] as const

export type TypeAxisKey = (typeof TYPE_AXES)[number]['k']

/** [axis, stem, choice-A (= the axis's `a` pole), choice-B]. Six per axis. */
export const TYPE_ITEMS: readonly (readonly [TypeAxisKey, string, string, string])[] = [
  ['EI', '休みの日、力が戻るのは', '人と会って過ごしたとき', 'ひとりで過ごしたとき'],
  ['EI', '考えがまとまるのは', '話しながら', '書きながら'],
  ['EI', '初対面の集まりで', '自分から輪に入る', '様子を見て待つ'],
  ['EI', '長い会議のあと', 'まだ話し足りない', '静かにしたい'],
  ['EI', '新しい環境では', 'まず人に聞く', 'まず自分で調べる'],
  ['EI', '連絡は', '電話や対面が早い', '文字のほうが楽'],
  ['SN', '説明を受けるとき知りたいのは', '具体的な手順', '全体の狙い'],
  ['SN', '信じるのは', '自分が見た事実', 'そこから読める流れ'],
  ['SN', '得意なのは', '細部に気づくこと', '関係を見つけること'],
  ['SN', '手順書があると', 'そのとおりにやる', '自分なりに変える'],
  ['SN', '話は', '順を追ってしたい', '結論から入りたい'],
  ['SN', '興味があるのは', '今そこにあるもの', 'まだないもの'],
  ['TF', '判断で重いのは', '筋が通っているか', '関わる人がどう感じるか'],
  ['TF', '指摘するとき', '正確さを優先する', '言い方を優先する'],
  ['TF', '評価は', '基準に沿って一律に', '事情を汲んで個別に'],
  ['TF', '議論で心地よいのは', '率直にぶつかること', '合意を探ること'],
  ['TF', '自分を説明するなら', '公平な人', '思いやりのある人'],
  ['TF', '間違いを見つけたら', 'すぐ指摘する', 'タイミングを選ぶ'],
  ['JP', '旅行は', '予定を決めてから', '行ってから決める'],
  ['JP', '締切は', '前倒しで終わらせる', '間際に力が出る'],
  ['JP', '決まっていない状態は', '早く決めたい', '開けておきたい'],
  ['JP', '机の上は', '片づいている', '使いかけが並ぶ'],
  ['JP', '計画が変わると', '落ち着かない', 'むしろ面白い'],
  ['JP', '仕事の進め方は', '手順を決めて進む', '流れで組み替える'],
]

export const TYPE_DESC: Record<string, string> = {
  E: '外に向かって考える', I: '内で考えてから出す',
  S: '事実から積み上げる', N: '意味とつながりを見る',
  T: '筋で決める', F: '人への影響で決める',
  J: '決めて進みたい', P: '開けておきたい',
}

// ── values (Schwartz's ten basic values) ────────────────────────────────────

export const VALUE_TYPES = {
  self: { name: '自分で決める', d: '進む道を自分で選べること' },
  stim: { name: '刺激', d: '新しさと変化があること' },
  hedo: { name: '楽しさ', d: '心地よさや喜びがあること' },
  achv: { name: '達成', d: '力を発揮して認められること' },
  powr: { name: '影響力', d: '資源や場を動かせること' },
  secu: { name: '安全', d: '暮らしと関係が安定すること' },
  conf: { name: '秩序', d: '規範や約束が守られること' },
  trad: { name: '受け継ぐ', d: '積み重ねを大切にすること' },
  bene: { name: '身近な人', d: '近い人の幸せに尽くすこと' },
  univ: { name: '公正と自然', d: 'すべての人と自然を守ること' },
} as const

export type ValueKey = keyof typeof VALUE_TYPES

export const VALUE_ITEMS: readonly (readonly [ValueKey, string])[] = [
  ['self', '自分のやり方で進められること'], ['self', '何をするか自分で決められること'],
  ['stim', '刺激のある毎日を送ること'], ['stim', '未知のことに挑めること'],
  ['hedo', '人生を楽しむこと'], ['hedo', '自分を甘やかす時間があること'],
  ['achv', '力を発揮して成果を出すこと'], ['achv', '人から有能だと認められること'],
  ['powr', '人や資源を動かせる立場にあること'], ['powr', '豊かさを持っていること'],
  ['secu', '安全な暮らしが守られること'], ['secu', '健康であること'],
  ['conf', '約束と規則を守ること'], ['conf', '出過ぎたことをしないこと'],
  ['trad', '受け継がれてきたやり方を尊ぶこと'], ['trad', '身の丈をわきまえること'],
  ['bene', '身近な人の役に立つこと'], ['bene', '誠実であること'],
  ['univ', '不公平をなくすこと'], ['univ', '自然を守ること'],
]

// ── work style (OPEN GROUND's own forced-choice sort) ───────────────────────

export const WORK_THEMES = {
  build: { name: '組み立てる', d: '仕組みや順序を作って解く' },
  dig: { name: '掘り下げる', d: '原因まで潜って確かめる' },
  ship: { name: '出し切る', d: '形にして世に出しきる' },
  care: { name: '整える', d: '細部と質感を最後まで見る' },
  lead: { name: '巻き込む', d: '人を集めて動かす' },
  learn: { name: '学び直す', d: '新しい道具と考えを取り込む' },
  focus: { name: '絞る', d: '要らないものを捨てる' },
  guard: { name: '守る', d: '壊れない形にしておく' },
} as const

export type WorkKey = keyof typeof WORK_THEMES

/** Balanced pair list: every theme appears exactly five times. */
export const WORK_ITEMS: readonly (readonly [WorkKey, WorkKey])[] = [
  ['build', 'dig'], ['ship', 'care'], ['lead', 'focus'], ['learn', 'guard'],
  ['build', 'ship'], ['dig', 'care'], ['lead', 'learn'], ['focus', 'guard'],
  ['build', 'lead'], ['dig', 'ship'], ['care', 'learn'], ['focus', 'ship'],
  ['guard', 'build'], ['learn', 'dig'], ['care', 'lead'], ['guard', 'focus'],
  ['build', 'care'], ['dig', 'focus'], ['ship', 'lead'], ['learn', 'guard'],
]

// ── the course catalogue ────────────────────────────────────────────────────

export interface PersonaCourse {
  id: PersonaCourseId
  name: string
  sub: string
  /** Which region of the figure this course grows. */
  zone: 'mind' | 'values' | 'craft' | 'core' | 'ground'
  itemCount: number
  /** Shown VERBATIM on the result sheet — the provenance promise. */
  source: string
  /** 'agree' / 'important' = 5-point Likert; 'pick' = two-choice. */
  scale: 'agree' | 'important' | 'pick'
}

export const COURSES: readonly PersonaCourse[] = [
  { id: 'big5', name: '性格の5因子', sub: 'ビッグファイブ', zone: 'mind', itemCount: BIG5_ITEMS.length,
    source: 'IPIP(公有ドメインの項目プール)に基づく25問・逆転項目を含む', scale: 'agree' },
  { id: 'type', name: '16タイプ', sub: 'ユング的タイプ論・オープン版', zone: 'values', itemCount: TYPE_ITEMS.length,
    source: 'OEJTS 系のオープン設問に基づく24問(MBTI® とは別の指標です)', scale: 'pick' },
  { id: 'values', name: '価値観の順位', sub: 'シュワルツの価値観理論', zone: 'core', itemCount: VALUE_ITEMS.length,
    source: 'Schwartz の10価値類型に基づく20問', scale: 'important' },
  { id: 'work', name: '仕事の強み', sub: '二択カードソート', zone: 'craft', itemCount: WORK_ITEMS.length,
    source: 'OPEN GROUND 独自設計の20問(CliftonStrengths® とは別の指標です)', scale: 'pick' },
]

export const courseById = (id: string): PersonaCourse | null =>
  COURSES.find((c) => c.id === id) ?? null

/** One question, in the shape the UI renders. `index` is 0-based. */
export interface PersonaItemView {
  index: number
  total: number
  /** The statement (Likert) or the stem (two-choice). */
  stem: string
  /** Present only for 'pick' courses. */
  choices?: readonly [string, string]
  /** Present only for Likert courses, low → high. */
  scale?: readonly string[]
  /** Extra line above the stem (e.g. 「どのくらい大切？」). */
  lead?: string
}

export const itemAt = (course: PersonaCourse, index: number): PersonaItemView | null => {
  if (index < 0 || index >= course.itemCount) return null
  const base = { index, total: course.itemCount }
  switch (course.id) {
    case 'big5':
      return { ...base, stem: BIG5_ITEMS[index][2], scale: LIKERT_AGREE }
    case 'type': {
      const it = TYPE_ITEMS[index]
      return { ...base, stem: it[1], choices: [it[2], it[3]] }
    }
    case 'values':
      return { ...base, lead: 'あなたにとって、どのくらい大切？', stem: VALUE_ITEMS[index][1], scale: LIKERT_IMPORTANT }
    case 'work': {
      const it = WORK_ITEMS[index]
      return {
        ...base, lead: '力が出るのはどちら？',
        stem: '',
        choices: [
          `${WORK_THEMES[it[0]].name} — ${WORK_THEMES[it[0]].d}`,
          `${WORK_THEMES[it[1]].name} — ${WORK_THEMES[it[1]].d}`,
        ],
      }
    }
  }
}

// ── scoring ─────────────────────────────────────────────────────────────────

/** Answers are indices: 0..4 for a Likert item, 0|1 for a two-choice item. */
export type PersonaAnswers = readonly number[]

const band = (pct: number): string =>
  pct >= 70 ? '高め' : pct >= 55 ? 'やや高め' : pct > 45 ? '中くらい' : pct > 30 ? 'やや低め' : '低め'

/** Margin wording for a bipolar axis — a thin margin must READ as thin. */
export const axisConfidence = (pct: number): string =>
  pct >= 80 ? 'はっきり' : pct >= 62 ? 'ややはっきり' : 'ほぼ半々'

export class PersonaScoringError extends Error {}

/** Score a completed course. Throws when the answer vector does not match the
 *  instrument (wrong length / out-of-range) — a half-answered course must never
 *  produce a result sheet that looks finished. */
export const scoreCourse = (course: PersonaCourse, answers: PersonaAnswers): PersonaResult => {
  if (answers.length !== course.itemCount) {
    throw new PersonaScoringError(
      `answers length ${answers.length} != ${course.itemCount} items for ${course.id}`,
    )
  }
  const max = course.scale === 'pick' ? 1 : 4
  for (const a of answers) {
    if (!Number.isInteger(a) || a < 0 || a > max) {
      throw new PersonaScoringError(`answer ${a} out of range 0..${max} for ${course.id}`)
    }
  }
  switch (course.id) {
    case 'big5':
      return scoreBig5(course, answers)
    case 'type':
      return scoreType(course, answers)
    case 'values':
      return scoreValues(course, answers)
    case 'work':
      return scoreWork(course, answers)
  }
}

const scoreBig5 = (course: PersonaCourse, answers: PersonaAnswers): PersonaResult => {
  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  BIG5_ITEMS.forEach(([k, reversed], i) => {
    // REVERSE-KEYED: an agree-everything response set must not max every scale.
    const v = reversed ? 4 - answers[i] : answers[i]
    sums[k] = (sums[k] ?? 0) + v
    counts[k] = (counts[k] ?? 0) + 1
  })
  const rows = (Object.keys(BIG5_DIMS) as Big5Key[]).map((k) => {
    const pct = Math.round((sums[k] / (counts[k] * 4)) * 100)
    const d = BIG5_DIMS[k]
    return { key: k, name: d.name, pct, note: band(pct), desc: pct >= 50 ? d.hi : d.lo, bipolar: false }
  })
  const findings: PersonaFinding[] = rows.map((r) => ({
    text: r.desc,
    detail: `${course.name} ・ ${r.name} ${r.pct}%`,
  }))
  const top = [...rows].sort((a, b) => Math.abs(b.pct - 50) - Math.abs(a.pct - 50))[0]
  return {
    courseId: course.id, courseName: course.name, source: course.source, itemCount: course.itemCount,
    kind: 'bars', rows, findings,
    headline: `5つのうち、いちばんはっきり出たのは「${top.name}」。${top.desc}傾向が${top.note}です。`,
  }
}

const scoreType = (course: PersonaCourse, answers: PersonaAnswers): PersonaResult => {
  const tally: Record<string, [number, number]> = { EI: [0, 0], SN: [0, 0], TF: [0, 0], JP: [0, 0] }
  TYPE_ITEMS.forEach(([axis], i) => {
    tally[axis][answers[i] === 0 ? 0 : 1]++
  })
  let letters = ''
  const rows = TYPE_AXES.map((ax) => {
    const [aCount, bCount] = tally[ax.k]
    const total = aCount + bCount
    const aWins = aCount >= bCount
    const letter = aWins ? ax.a : ax.b
    letters += letter
    const winPct = Math.round(((aWins ? aCount : bCount) / total) * 100)
    const conf = axisConfidence(winPct)
    return {
      key: ax.k, name: `${ax.an} ↔ ${ax.bn}`,
      // The bar fills toward the B pole so the mid-line reads as "half and half".
      pct: Math.round((bCount / total) * 100), note: conf, bipolar: true,
      desc: `${ax.q} ・ ${aWins ? ax.an : ax.bn}寄り(${winPct}%)` +
        (conf === 'ほぼ半々' ? ' — 差が小さいので、日によって変わります' : ''),
    }
  })
  const findings: PersonaFinding[] = rows.map((r, i) => ({
    text: TYPE_DESC[letters[i]],
    detail: `${course.name} ・ ${r.name} ・ ${r.note}`,
  }))
  return {
    courseId: course.id, courseName: course.name, source: course.source, itemCount: course.itemCount,
    kind: 'bars', rows, findings, badge: letters,
    headline: `あなたのタイプは ${letters}。` +
      [0, 1, 2, 3].map((i) => TYPE_DESC[letters[i]]).join('、') + '。',
  }
}

const scoreValues = (course: PersonaCourse, answers: PersonaAnswers): PersonaResult => {
  const sums: Record<string, number> = {}
  VALUE_ITEMS.forEach(([k], i) => {
    sums[k] = (sums[k] ?? 0) + answers[i]
  })
  const ranked = (Object.keys(VALUE_TYPES) as ValueKey[])
    .map((k) => ({ k, v: sums[k] ?? 0 }))
    .sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
  const rows = ranked.map((r, i) => ({
    key: r.k, rank: i + 1, name: VALUE_TYPES[r.k].name,
    desc: VALUE_TYPES[r.k].d, score: `${Math.round((r.v / 8) * 100)}%`,
  }))
  const findings: PersonaFinding[] = ranked.slice(0, 3).map((r, i) => ({
    text: `${VALUE_TYPES[r.k].d}を上に置く`,
    detail: `${course.name} ・ ${i + 1}位`,
  }))
  return {
    courseId: course.id, courseName: course.name, source: course.source, itemCount: course.itemCount,
    kind: 'rank', rows, findings,
    headline: `いちばん上に来たのは「${VALUE_TYPES[ranked[0].k].name}」。` +
      `次いで「${VALUE_TYPES[ranked[1].k].name}」「${VALUE_TYPES[ranked[2].k].name}」。`,
  }
}

const scoreWork = (course: PersonaCourse, answers: PersonaAnswers): PersonaResult => {
  const wins: Record<string, number> = {}
  WORK_ITEMS.forEach((pair, i) => {
    const k = pair[answers[i] === 0 ? 0 : 1]
    wins[k] = (wins[k] ?? 0) + 1
  })
  const ranked = (Object.keys(WORK_THEMES) as WorkKey[])
    .map((k) => ({ k, v: wins[k] ?? 0 }))
    .sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
  const rows = ranked.map((r, i) => ({
    key: r.k, rank: i + 1, name: WORK_THEMES[r.k].name, desc: WORK_THEMES[r.k].d, score: `${r.v}回`,
  }))
  const findings: PersonaFinding[] = ranked.slice(0, 3).map((r, i) => ({
    text: WORK_THEMES[r.k].d,
    detail: `${course.name} ・ ${i + 1}位(${r.v}回選択)`,
  }))
  return {
    courseId: course.id, courseName: course.name, source: course.source, itemCount: course.itemCount,
    kind: 'rank', rows, findings,
    headline: `あなたの上位3つは「${WORK_THEMES[ranked[0].k].name}」「${WORK_THEMES[ranked[1].k].name}」「${WORK_THEMES[ranked[2].k].name}」。`,
  }
}

/** The caveat printed on EVERY result sheet. Exported (not inlined in the view)
 *  so a test can pin that no sheet ships without it. */
export const PERSONA_RESULT_CAVEAT =
  'これは自己申告の観測で、性格を決めつけるものではありません。実際の判断の記録とズレたときは、ズレのほうが情報です — ペルソナは両方を持ったまま、次の問いをつくります。'
