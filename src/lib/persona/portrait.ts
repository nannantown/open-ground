// Persona portrait — the few lines that answer 「で、私はどういう人?」 without
// making the owner read every node.
//
// COMPOSED, NOT GENERATED. Every line is assembled from a scored result or a
// counted fact, and every line carries the instrument + number it came from.
// No model writes this, for the reason the whole surface exists: a portrait
// that can drift from its evidence is a horoscope. Three rules follow from
// that and are pinned by portrait.test.ts:
//
//   1. NOTHING WITHOUT EVIDENCE. A course that was never taken contributes no
//      line — it never guesses, and it never pads with a line that would be
//      true of anyone ("あなたは状況に応じて判断する人").
//   2. A CLOSE CALL NEVER BECOMES A CLAIM. A five-factor score inside the
//      middle band, or a type axis the scorer itself called ほぼ半々, is
//      SKIPPED rather than rounded into a confident sentence.
//   3. STALENESS IS PART OF THE PORTRAIT. A line knows how old its evidence is
//      (the caller renders it); a portrait built from a course taken months ago
//      must not read as today's fact.
//
// The digest is deliberately SHORT (PORTRAIT_MAX_LINES). "全部は見せなくてOK"
// — the figure holds everything; this is the glance.

import type { PersonaCourseId, PersonaCourseRecord, PersonaPortrait, PersonaPortraitLine } from '../types'

/** At most this many lines — a glance, not a report. */
export const PORTRAIT_MAX_LINES = 5

/** Five-factor bands that count as SAYING something. 中くらい is excluded on
 *  purpose: it is the band the scorer prints when the answers did not lean. */
const DECISIVE_BIG5_BANDS = ['高め', 'やや高め', 'やや低め', '低め']

/** The type scorer's own words for a margin worth stating. ほぼ半々 is not one. */
const DECISIVE_AXIS_NOTES = ['はっきり', 'ややはっきり']

/** Order the lines are considered in — most identity-bearing first, so the cap
 *  drops the least characteristic line rather than an arbitrary one. */
const COURSE_ORDER: PersonaCourseId[] = ['values', 'big5', 'type', 'work']

export interface PortraitInput {
  /** The LAST record per course; a course never taken is simply absent. */
  records: Partial<Record<PersonaCourseId, PersonaCourseRecord>>
  /** How many things the stand-in knows overall (corpus notes + findings). */
  nodeCount: number
  /** How many of those arrived in the last 7 days. */
  recentCount?: number
  /** THE OTHER HALF OF THE EVIDENCE (2026-08-14). The courses above are what
   *  the owner SAYS about themselves; this is what their stand-in DID against
   *  real work — answered on their behalf, asked them instead, or abstained.
   *  Absent (or all-zero) ⇒ no work line, by rule 1: a stand-in that has not
   *  acted yet must not be described as if it had. */
  work?: { answered: number; asked: number; abstained: number }
  /** Now, injected so the age of a record is testable. */
  now?: number
}

const daysSince = (iso: string, now: number): number | null => {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}

/** Compose the portrait. Returns `{ lines: [], … }` when there is nothing
 *  evidenced to say — the caller shows its own empty state rather than being
 *  handed a sentence nobody earned. */
export const composePortrait = (input: PortraitInput): PersonaPortrait => {
  const now = input.now ?? Date.now()
  const lines: PersonaPortraitLine[] = []

  for (const id of COURSE_ORDER) {
    const rec = input.records[id]
    if (!rec) continue
    const age = daysSince(rec.takenAt, now)
    const push = (text: string, detail: string) => {
      lines.push({ text, detail, courseId: id, takenAt: rec.takenAt, ...(age === null ? {} : { ageDays: age }) })
    }
    const r = rec.result

    if (id === 'values') {
      // The top value is the single most identity-bearing thing a course can
      // say, and a ranking has no "too close to call" state — rank 1 is rank 1.
      const first = r.rows[0]
      if (first) push(`${first.desc}を、いちばん上に置く人。`, `${r.courseName} ・ 1位「${first.name}」`)
      continue
    }

    if (id === 'big5') {
      // Only the factors that actually leaned, strongest lean first, max two —
      // five bars is the sheet's job, not the glance's.
      const decisive = r.rows
        .filter((row) => row.note && DECISIVE_BIG5_BANDS.includes(row.note) && typeof row.pct === 'number')
        .sort((a, b) => Math.abs((b.pct ?? 50) - 50) - Math.abs((a.pct ?? 50) - 50))
        .slice(0, 2)
      for (const row of decisive) push(`${row.desc}人。`, `${r.courseName} ・ ${row.name} ${row.pct}%(${row.note})`)
      continue
    }

    if (id === 'type') {
      // The four letters are worth showing whole, but only the axes the scorer
      // called decisive get spelled out in words.
      const decisive = r.rows.filter((row) => row.note && DECISIVE_AXIS_NOTES.includes(row.note))
      if (r.badge && decisive.length > 0) {
        push(
          `${r.badge} — ${decisive.map((row) => row.desc.split(' ・ ')[1]?.replace(/\(.*$/, '') ?? row.name).join('、')}。`,
          `${r.courseName} ・ ${decisive.length}/4 軸ではっきり出た`,
        )
      } else if (r.badge) {
        // Every axis was a coin flip: say THAT, because it is a real finding.
        push(`型は ${r.badge} だが、どの軸も差は小さい。`, `${r.courseName} ・ 4軸とも「ほぼ半々」`)
      }
      continue
    }

    // work
    const top = r.rows[0]
    if (top) push(`仕事では「${top.name}」— ${top.desc}。`, `${r.courseName} ・ 1位(${top.score})`)
  }

  // THE WORK LINE goes LAST and is never dropped by the cap — it is the only
  // line built from what actually happened rather than what was self-reported,
  // so if something has to go, a self-report goes first. It states the RATIO
  // in plain words and never flatters: a stand-in that mostly asks is described
  // as mostly asking, because that is the number that tells the owner whether
  // any of this is working yet.
  const w = input.work
  const acted = w ? w.answered + w.asked + w.abstained : 0
  if (w && acted > 0) {
    const share = w.answered / acted
    const text =
      w.answered === 0
        ? 'まだ、あなたの代わりに答えられていない。'
        : share >= 0.6
          ? '判断の多くを、あなたを待たずに引き受けている。'
          : share >= 0.3
            ? '半分ほどを引き受け、迷ったらあなたに聞いている。'
            : 'まだ多くをあなたに聞いている — 分かっていない領域が残っている。'
    const line: PersonaPortraitLine = {
      text,
      detail: `実際の判断 ${acted}件 ・ 代わりに答えた${w.answered} / 聞いた${w.asked} / 棄権${w.abstained}`,
      courseId: 'work',
      takenAt: new Date(now).toISOString(),
      ageDays: 0,
    }
    return {
      lines: [...lines.slice(0, PORTRAIT_MAX_LINES - 1), line],
      nodeCount: input.nodeCount,
      ...(input.recentCount === undefined ? {} : { recentCount: input.recentCount }),
      takenCount: COURSE_ORDER.filter((id) => input.records[id]).length,
      courseCount: COURSE_ORDER.length,
    }
  }

  return {
    lines: lines.slice(0, PORTRAIT_MAX_LINES),
    nodeCount: input.nodeCount,
    ...(input.recentCount === undefined ? {} : { recentCount: input.recentCount }),
    takenCount: COURSE_ORDER.filter((id) => input.records[id]).length,
    courseCount: COURSE_ORDER.length,
  }
}

/** How a line's age should READ. Exported so the UI never invents its own
 *  wording for the same fact (and so the thresholds are testable). */
export const portraitAgeLabel = (ageDays: number | undefined): string | null => {
  if (ageDays === undefined) return null
  if (ageDays <= 1) return '今日'
  if (ageDays < 14) return `${ageDays}日前`
  if (ageDays < 60) return `${Math.floor(ageDays / 7)}週間前`
  return `${Math.floor(ageDays / 30)}か月前`
}
