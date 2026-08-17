// regions.ts — WHERE A NOTE SITS ON THE FIGURE, as pure functions.
//
// The figure (src/components/canvas/modules/PersonaFigure.tsx) is an armature:
// four regions ON the body and one halo AROUND it. This module owns the
// vocabulary and the seating rule; the figure owns the geometry and the pixels.
// Nothing here touches the DOM, a canvas, or a clock, so every rule below is
// measurable without rendering anything (regions.test.ts).
//
// THE UNION LIVES IN types.ts, EVERY RECORD LIVES HERE. `PersonaRegion` crosses
// the wire and rides in corpus tags, so it belongs to the shared contract; the
// runtime tables keyed BY it belong next to the rule that reads them. Each table
// is an exhaustive `Record<PersonaRegion, …>` / `Record<…, PersonaRegion>`, so a
// new region — or a new course, or a new question kind — is a COMPILE ERROR here
// rather than a note seated nowhere at run time.
//
// ─── THE SEATING RULE, four tiers, first hit wins ───────────────────────────
//
//   1. an explicit `region:<id>` tag  → that region,        placed
//   2. a course tag (or the course name in the provenance line)
//                                     → the course's region, placed
//   3. an interview question's kind tag → that question's region, placed
//   4. nothing above                  → a BODY region by hash,  NOT placed
//
// WHAT `placed` MEANS, and why tier 4 does not set it. Tier 4 is a spread, not a
// reading: we do not know what a free-form note is "about", and guessing would
// print a wrong label under the owner's own words in an append-only store where
// it could only ever be superseded, never removed. So the note still gets a seat
// and still lights a point — 159 things known IS 159 lit points — but the screen
// says 「場所はまだ決めていません」 instead of naming a region, and the region
// probe counts it under `unplaced`, never under `placed`. A count that mixes the
// two would claim evidence that does not exist.
//
// WHY THE HALO IS NOT IN THE TIER-4 POOL. Seating an unknown note on the body
// asserts only "this is part of you", which every corpus entry is by
// construction. Seating it in the halo asserts "this is about someone else",
// which is a CLAIM. The halo is therefore reachable only from evidence — an
// explicit `region:people` tag — and `QUESTION_REGION` maps no kind to it,
// because none of the nine interview detectors reads relationships. When the
// halo is empty the probe must say 「ここはまだ何もありません」, not imply the
// owner has no one around them.

import { COURSES } from './instruments'
import type {
  ManualJudgment,
  PersonaCourseId,
  PersonaQuestion,
  PersonaQuestionKind,
  PersonaRegion,
} from '../types'

/** Every region, in reading order down the figure, halo last. */
export const PERSONA_REGIONS: readonly PersonaRegion[] = [
  'head',
  'chest',
  'arms',
  'legs',
  'people',
]

/** The regions a note may be seated in WITHOUT evidence — the four ON the body.
 *  `people` is deliberately absent; see the header. */
export const PERSONA_BODY_REGIONS: readonly PersonaRegion[] = ['head', 'chest', 'arms', 'legs']

/** The i18n key that names each region to the owner. A Record rather than a
 *  template string so a region with no copy is a build error, not a raw key on
 *  screen. */
export const REGION_LABEL_KEY: Record<PersonaRegion, string> = {
  head: 'persona.region.head',
  chest: 'persona.region.chest',
  arms: 'persona.region.arms',
  legs: 'persona.region.legs',
  people: 'persona.region.people',
}

/** Which region each course grows. Keyed off the course ID UNION (not the
 *  catalogue array), so adding a course fails the build until it is seated. */
export const COURSE_REGION: Record<PersonaCourseId, PersonaRegion> = {
  big5: 'head',
  type: 'head',
  values: 'chest',
  work: 'arms',
}

/** Which region the day's question is digging in. Driven by the question's KIND
 *  (a durable, enumerable fact — see PersonaQuestionKind) rather than its
 *  wording, so the pulsing patch is stable for the life of the question.
 *
 *  NOTHING maps to 'people': none of the nine detectors reads relationships,
 *  and a kind seated in the halo would put a claim about other people on
 *  material that never mentioned them. */
export const QUESTION_REGION: Record<PersonaQuestionKind, PersonaRegion> = {
  'decision-speed-contrast': 'head',
  'escalation-answer-rule': 'chest',
  'escalation-dismissed': 'chest',
  'escalation-long-open': 'head',
  'corpus-gap': 'head',
  'card-rework': 'arms',
  'card-approved': 'arms',
  'card-stale-blocked': 'legs',
  'todo-passed-over': 'legs',
}

/** The tag a WRITER stamps on a judgment to seat it deliberately (tier 1). One
 *  spelling, in one place: the distiller, the importer and the course minter all
 *  call this rather than formatting the string themselves. */
export const REGION_TAG = (region: PersonaRegion): string => `region:${region}`

/** FNV-1a. Any hash would do; what matters is that it is DETERMINISTIC — a note
 *  must sit in the same place on every mount, on every machine. `Math.random()`
 *  here would make the figure reshuffle itself each time it is opened, and a
 *  body that rearranges itself is not a mirror of anything. */
export const personaHash = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const COURSE_IDS = new Set<string>(COURSES.map((c) => c.id))

const REGION_IDS = new Set<string>(PERSONA_REGIONS)

/** Which course minted this note, if any. The server tags a course finding with
 *  the course id; the exact prefix it uses is its own business, so every
 *  separator-delimited token of every tag is checked ('big5', 'persona:big5',
 *  'course-big5' all read the same). The course NAME appearing in the note's
 *  `context` is accepted as a fallback because a finding's provenance line is
 *  `<course name> ・ <the number it came from>` — see PersonaFinding.detail. */
export const courseIdFromJudgment = (j: {
  tags?: string[]
  context?: string
}): PersonaCourseId | null => {
  for (const tag of j.tags ?? []) {
    for (const part of tag.toLowerCase().split(/[\s:/\-_.]+/)) {
      if (COURSE_IDS.has(part)) return part as PersonaCourseId
    }
  }
  const named = j.context ? COURSES.find((c) => j.context?.includes(c.name)) : undefined
  return named ? named.id : null
}

/** The region a question is digging in, or null when there is no question. */
export const regionForQuestion = (q: PersonaQuestion | null): PersonaRegion | null =>
  // The `??` is unreachable through the type system and deliberate anyway: a
  // question is READ BACK FROM DISK, so a kind written by a newer build must
  // land somewhere rather than seating the pulse at `undefined`.
  q ? QUESTION_REGION[q.kind] ?? 'head' : null

/** Where a note sits, and whether that seat was DECIDED or merely assigned.
 *  `placed: false` is not a lesser region — it is the absence of a reading, and
 *  every reader (provenance line, region probe) must keep the two apart. */
export interface RegionPlacement {
  region: PersonaRegion
  placed: boolean
}

/** Read the explicit tier-1 tag, if the writer left one. Exact match on the
 *  lowercased tag — a tag that merely CONTAINS "region:" is not a claim. */
const taggedRegion = (tags: readonly string[]): PersonaRegion | null => {
  for (const tag of tags) {
    const lowered = tag.trim().toLowerCase()
    if (!lowered.startsWith('region:')) continue
    const id = lowered.slice('region:'.length)
    if (REGION_IDS.has(id)) return id as PersonaRegion
  }
  return null
}

/** THE SEATING RULE. See the four tiers in the header. */
export const placeJudgment = (j: ManualJudgment): RegionPlacement => {
  const tags = j.tags ?? []

  const explicit = taggedRegion(tags)
  if (explicit) return { region: explicit, placed: true }

  const courseId = courseIdFromJudgment(j)
  if (courseId) return { region: COURSE_REGION[courseId], placed: true }

  for (const tag of tags) {
    const asked = QUESTION_REGION[tag as PersonaQuestionKind]
    if (asked) return { region: asked, placed: true }
  }

  // Tier 4 — a spread, not a reading. BODY regions only, and `placed: false`.
  return {
    region:
      PERSONA_BODY_REGIONS[personaHash(`${j.id}|${tags.join(',')}`) % PERSONA_BODY_REGIONS.length],
    placed: false,
  }
}

/** One lit point: one note, its seat, and enough of the note to show without
 *  going back to the list. */
export interface PersonaNode {
  id: string
  region: PersonaRegion
  /** False ⇒ the region is a spread, not a reading (see RegionPlacement). */
  placed: boolean
  text: string
  addedAt: string
  tags: string[]
  context?: string
  /** The owner's own words this line was distilled from, when they were kept
   *  (ManualJudgment.source). Carried through so the note card can show them —
   *  a distilled sentence nobody can check against its material is the one kind
   *  of line this surface must not present as his. */
  source?: string
  correctsId?: string
  courseId: PersonaCourseId | null
}

export const buildPersonaNodes = (judgments: ManualJudgment[]): PersonaNode[] =>
  judgments.map((j) => {
    const seat = placeJudgment(j)
    return {
      id: j.id,
      region: seat.region,
      placed: seat.placed,
      text: j.text,
      addedAt: j.addedAt,
      tags: j.tags ?? [],
      ...(j.context ? { context: j.context } : {}),
      ...(j.source ? { source: j.source } : {}),
      ...(j.correctsId ? { correctsId: j.correctsId } : {}),
      courseId: courseIdFromJudgment(j),
    }
  })
