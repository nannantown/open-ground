// knownGroups.ts — how the corpus is split up so a person can read it back.
//
// ⚠ THE GROUPING AXIS IS SOURCE, AND THAT IS THE LOAD-BEARING DECISION HERE.
// Source is a fact that is ALREADY RECORDED, in the tags every writer stamps
// (`chat` / `import` / `interview` / `persona`+a course id) and in `correctsId`.
// Grouping by it therefore invents nothing — which is the whole constraint on
// this surface: not one line of it may be a claim about the owner that nobody
// made.
//
// The two axes that were rejected, and why, so nobody re-litigates them:
//
//   REGION (the body part a note sits in) is wrong as the PRIMARY axis. Notes
//   written before the seating rules existed carry `placed:false`, so on a real
//   corpus the largest group would be 「場所はまだ決めていません」 — a bucket that
//   says nothing whatsoever about its contents. Region stays where it already
//   works: as the per-row provenance line.
//
//   TOPIC is forbidden outright. There is no recorded topic, so the groups would
//   have to be generated — a machine's opinion about what the owner's own words
//   are "about", presented as an index of them.
//
// Source is also the axis every comparable product collapses: an AI memory list
// mixes "you said this" and "this was concluded about you" into one
// undifferentiated column. Separating them is simultaneously the honest choice
// and the one nothing else does.

import type { ManualJudgment } from '../types'
import { COURSES } from './instruments'

export type KnownGroupId =
  | 'interview'
  | 'chat'
  | 'import'
  | 'course'
  | 'corrected'
  | 'unrecorded'
  /** ⚠ NOT A SOURCE — A STATE, and the one exception to this file's axis. The
   *  lines the owner TOOK BACK do not belong under the source they came from:
   *  filed there they would read as things he still holds, in a list whose whole
   *  job is to say what he holds. They are still shown, because a record you
   *  cannot see is a record you cannot get back. Last, greyed, uncounted. */
  | 'retired'

/** ⚠ FIXED ORDER, NOT BY SIZE. A screen whose sections reshuffle as the corpus
 *  grows cannot be read back — the owner's memory of "it was near the top" is
 *  the fastest index there is, and sorting by count destroys it every week.
 *
 *  The order is an argument about trust. Interview answers come first: they are
 *  the only lines written in the owner's own words in response to a real
 *  recorded event. Course results sit late because they are self-report. What
 *  has no recorded source sits last — it is the least accountable material here,
 *  and it should look like it. */
export const KNOWN_GROUP_ORDER: readonly KnownGroupId[] = [
  'interview',
  'chat',
  'import',
  'course',
  'corrected',
  'unrecorded',
  'retired',
] as const

export const KNOWN_GROUP_LABEL: Record<KnownGroupId, string> = {
  interview: 'persona.known.group.interview',
  chat: 'persona.known.group.chat',
  import: 'persona.known.group.import',
  course: 'persona.known.group.course',
  corrected: 'persona.known.group.corrected',
  unrecorded: 'persona.known.group.unrecorded',
  retired: 'persona.known.group.retired',
}

const COURSE_IDS: ReadonlySet<string> = new Set(COURSES.map((c) => c.id))

/** Which bucket one judgment belongs in.
 *
 *  ⚠ `correctsId` WINS OVER EVERY TAG. A correction inherits the tags of
 *  whatever it was written from, so a correction to a chat line carries `chat`.
 *  But the most important fact about a correction is that it IS one — it is the
 *  owner overruling something, which is the single most accountable act
 *  available on this screen. Filing it under the source it happens to quote
 *  would hide the only group he can use to audit his own edits. */
export const groupOf = (j: ManualJudgment): KnownGroupId => {
  if (j.correctsId) return 'corrected'
  const tags = j.tags ?? []
  if (tags.includes('interview')) return 'interview'
  if (tags.includes('import')) return 'import'
  if (tags.includes('chat')) return 'chat'
  // Course findings are stamped `persona` plus the course id. Either is enough:
  // the pair has been written together since the first take, and accepting
  // either means a hand-written `persona` note still lands somewhere truthful.
  if (tags.includes('persona') || tags.some((t) => COURSE_IDS.has(t))) return 'course'
  return 'unrecorded'
}

export interface KnownGroup {
  id: KnownGroupId
  items: ManualJudgment[]
}

/** Split the corpus into the fixed groups, NEWEST FIRST within each.
 *
 *  ⚠ EMPTY GROUPS ARE DROPPED, NOT ZEROED. A row reading 「話したこと 0」 is worse
 *  than absent twice over: it is noise on a screen the owner keeps asking to
 *  quieten, and it invites reading an absence as a measurement — the shape this
 *  app spends most of its guards refusing. A group that has nothing simply is
 *  not there.
 *
 *  PURE, and order-preserving by construction: the caller renders exactly these
 *  arrays, so the header count and the rows it labels cannot disagree. */
export const groupJudgments = (
  all: readonly ManualJudgment[],
  /** The lines taken back. Passed SEPARATELY rather than mixed into `all`,
   *  because 'retired' is the one group `groupOf` cannot compute: whether a line
   *  was withdrawn is a fact about a DIFFERENT record (its tombstone), and the
   *  server has already resolved it. Already newest-first from the route. */
  retired: readonly ManualJudgment[] = [],
): KnownGroup[] => {
  const byId = new Map<KnownGroupId, ManualJudgment[]>()
  for (const j of all) {
    const id = groupOf(j)
    const bucket = byId.get(id)
    if (bucket) bucket.push(j)
    else byId.set(id, [j])
  }
  return KNOWN_GROUP_ORDER.filter((id) =>
    id === 'retired' ? retired.length > 0 : (byId.get(id)?.length ?? 0) > 0,
  ).map((id) => ({
    id,
    // Newest first — the same direction the thread and the judgments route
    // already use, so "recent" means one thing everywhere in this feature.
    items: id === 'retired' ? [...retired] : [...(byId.get(id) ?? [])].reverse(),
  }))
}

/** Substring filter over the owner's OWN words and his OWN tags.
 *
 *  ⚠ MACHINE TAGS ARE NOT SEARCHED. `region:head`, `take:2026-…`, `persona` and
 *  the course ids are our vocabulary, not his; matching them would surface rows
 *  for a word he never typed and cannot see. Case-folded, and empty means
 *  everything (never "no matches"). */
export const OUR_TAG_PREFIXES = ['region:', 'take:'] as const
export const isOurTag = (tag: string): boolean =>
  OUR_TAG_PREFIXES.some((p) => tag.startsWith(p)) ||
  tag === 'persona' ||
  tag === 'chat' ||
  tag === 'import' ||
  tag === 'interview' ||
  COURSE_IDS.has(tag)

export const matchesFilter = (j: ManualJudgment, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (j.text.toLowerCase().includes(q)) return true
  return (j.tags ?? []).some((t) => !isOurTag(t) && t.toLowerCase().includes(q))
}
