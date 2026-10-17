// A photo sent from the phone to the assistant (docs/PHONE_LINK.md "Photos").
// The relay takes phone frames of at most 16 KB, so the phone cuts the photo
// (a JPEG it already shrank) into sealed `photo-part` frames — 8 KB of bytes
// each, every part with its own fresh id and the `sayId` of the say it goes
// with — and then sends that say with `photoParts: n`. Here the parts are kept
// by `sayId` until their say takes them. Bounded: a few photos at a time, a
// part never larger than PHOTO_PART_MAX, a photo never over PHOTO_PARTS_MAX
// parts or ASSISTANT_PHOTO_MAX_BYTES, and parts whose say never came are
// dropped after KEEP_MS.
//
// A photo that has ENDED — taken by its say, dropped, or pushed out to make
// room — leaves its sayId behind for KEEP_MS (`ended`): its say is then refused
// at once, and its late or replayed parts are not kept. Without that, the say of
// a photo pushed out before the say began waiting (it is still being recorded
// as seen on disk) made a fresh empty photo, which pushed out the next one, and
// so on down the row until a COMPLETE photo was pushed out and its say waited
// the full PHOTO_WAIT_MS for nothing (measured 2026-10-16 under load:
// pushed out w0, w1, w2, w3, then the complete w4).
import { ASSISTANT_PHOTO_MAX_BYTES } from './assistantMemory'

/** Bytes in one part at most (the phone sends 8 KB; a little room, never more
 *  than a 16 KB relay frame could carry base64'd twice anyway). */
export const PHOTO_PART_MAX = 12 * 1024
/** Parts one photo may come in: the phone sends at most 48 (PhotoParts.maxParts); a little room. */
export const PHOTO_PARTS_MAX = 64
/** Photos being put together at once (the assistant takes one line answering and one waiting). */
const PENDING_MAX = 4
/** How long a say waits for its missing parts (they normally arrive before it). */
export const PHOTO_WAIT_MS = 30_000
/** Parts of a say that never came are dropped this long after their first part;
 *  an ended photo's sayId is remembered as long. */
const KEEP_MS = 5 * 60_000
/** Ended sayIds remembered at most (the oldest is forgotten first). */
const ENDED_MAX = 64

type Pending = { parts: number; got: Map<number, Buffer>; bytes: number; first: number; bad: boolean; wake?: () => void }
const pending = new Map<string, Pending>()
const ended = new Map<string, number>()

const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100
const isCount = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max
const complete = (p: Pending) => !p.bad && p.got.size === p.parts

/** This photo is over: forgotten, its say (if waiting) woken, its sayId kept as ended. */
const end = (sayId: string, now: number): void => {
  const p = pending.get(sayId)
  pending.delete(sayId)
  ended.delete(sayId)
  ended.set(sayId, now)
  while (ended.size > ENDED_MAX) ended.delete(ended.keys().next().value!)
  p?.wake?.()
}

const prune = (now: number): void => {
  pending.forEach((p, k) => now - p.first > KEEP_MS && end(k, now))
  ended.forEach((t, k) => now - t > KEEP_MS && ended.delete(k))
}

/** The photo kept for this say, a new one — or null once it has ended. */
const entry = (sayId: string, parts: number, now: number): Pending | null => {
  const p = pending.get(sayId)
  if (p) {
    // The say and its parts disagree on the count: the photo cannot be trusted.
    if (p.parts !== parts) p.bad = true
    return p
  }
  prune(now)
  if (ended.has(sayId)) return null
  // Full: the oldest unfinished photo goes ("oldest" = kept first, Map order —
  // never a timestamp, which can tie). A complete photo goes only when every
  // kept one is complete: its say normally follows right behind its last part.
  while (pending.size >= PENDING_MAX) end(Array.from(pending).find(([, x]) => !complete(x))?.[0] ?? pending.keys().next().value!, now)
  const fresh: Pending = { parts, got: new Map(), bytes: 0, first: now, bad: false }
  pending.set(sayId, fresh)
  return fresh
}

/** One `photo-part` frame (already opened and checked fresh). Anything malformed
 *  marks its photo bad rather than being skipped, so the say is refused plainly. */
export const takePhotoPart = (f: Record<string, unknown>, now = Date.now()): void => {
  if (!isId(f.sayId) || !isCount(f.parts, PHOTO_PARTS_MAX)) return
  const p = entry(f.sayId, f.parts, now)
  // Ended (taken, dropped or pushed out) or already bad: nothing more is kept.
  if (!p || p.bad) return
  const part = f.part
  const data = typeof f.data === 'string' && f.data.length % 4 === 0 && B64.test(f.data) ? Buffer.from(f.data, 'base64') : null
  if (!Number.isInteger(part) || (part as number) < 0 || (part as number) >= p.parts || !data || data.length === 0 || data.length > PHOTO_PART_MAX) {
    p.bad = true
  } else {
    // The same part again (a resend) replaces itself: never counted twice.
    p.bytes += data.length - (p.got.get(part as number)?.length ?? 0)
    p.got.set(part as number, data)
    if (p.bytes > ASSISTANT_PHOTO_MAX_BYTES) p.bad = true
  }
  if (p.bad) {
    p.got.clear()
    p.bytes = 0
    p.wake?.()
  } else if (p.got.size === p.parts) p.wake?.()
}

export type PhotoResult = { bytes: Buffer } | { error: 'photo-incomplete' | 'photo-bad' }

/** The say's photo, once all `parts` are here (waits up to `waitMs` for the
 *  rest). Taken once: the photo ends whatever the outcome. */
export const awaitPhoto = async (sayId: string, parts: number, waitMs = PHOTO_WAIT_MS, now = Date.now()): Promise<PhotoResult> => {
  const p = entry(sayId, parts, now)
  // Pushed out (or dropped) before this say came to it: refused now, not after a wait.
  if (!p) return { error: 'photo-incomplete' }
  if (!p.bad && p.got.size < p.parts)
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, waitMs)
      p.wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  end(sayId, Date.now())
  if (p.bad) return { error: 'photo-bad' }
  if (p.got.size < p.parts) return { error: 'photo-incomplete' }
  return { bytes: Buffer.concat(Array.from({ length: p.parts }, (_, i) => p.got.get(i)!)) }
}

/** Parts of a say that will not use them (refused before its photo was taken). */
export const dropPhoto = (sayId: string): void => end(sayId, Date.now())

/** Everything kept (the link stopped; tests). */
export const dropAllPhotos = (): void => {
  pending.forEach((p) => p.wake?.())
  pending.clear()
  ended.clear()
}

/** Tests: how many photos are being put together. */
export const pendingPhotos = (): number => pending.size
