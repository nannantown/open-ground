// Images an agent sends the owner (docs/PHONE_LINK.md "Agent images"): the
// assistant with its `send_image` tool, a president with an image line in its
// reply (src/lib/agentImage.ts). Both name a file by path; it is read here —
// only from what the assistant may read (registered projects, OPEN GROUND's
// data, secrets refused) or the temp folder (where a fresh screenshot goes),
// only a JPEG / PNG / GIF / WebP by its own bytes, at most 5 MB — and kept with
// the owner's photos, so the phone fetches every image the same way, by name
// (`photo-get`), and gets it back in sealed `photo` parts.
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join, sep } from 'path'
import { promisify } from 'util'
import { resolveReadable } from './assistantTools'
import { ASSISTANT_PHOTO_MAX_BYTES, assistantPhotoPath, isAssistantPhotoName, sniffPhoto, type AssistantPhotoExt } from './assistantMemory'
import { withLocalClaudeAssistantScope } from './assistantRuntimeStore'
import { projectCentralDir } from './paths'
import { projectUUIDFromPath } from './projectDataPath'
import { atomicWriteJson } from './atomicWrite'

const execFileP = promisify(execFile)
const real = (p: string) => realpath(p).catch(() => null)
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/** Bytes in one `photo` part: base64'd, then sealed and base64'd again, a part
 *  is about 44 KB on the wire — under the relay's 64 KB Mac frame. */
export const PHONE_PHOTO_PART = 24 * 1024
/** Parts one image goes in at most. */
export const PHONE_PHOTO_PARTS_MAX = 64
/** What the phone gets at most; a larger image is shrunk first (photoForPhone). */
export const PHONE_PHOTO_MAX = PHONE_PHOTO_PART * PHONE_PHOTO_PARTS_MAX

export type AgentImage = { bytes: Buffer; ext: AssistantPhotoExt } | { error: string }

/** The image at `p`, or why it cannot be sent (words for the agent). */
export const readAgentImage = async (p: string): Promise<AgentImage> => {
  const given = p.trim().replace(/^~(?=\/)/, homedir())
  if (!isAbsolute(given)) return { error: 'Give an absolute path.' }
  const path = await real(given)
  if (!path) return { error: `Not found: ${given}` }
  const temp = (await Promise.all([tmpdir(), '/tmp'].map(real))).filter((r): r is string => !!r)
  if (!temp.some((r) => inside(path, r))) {
    const r = await resolveReadable(path)
    if (!r.ok) return { error: r.why }
  }
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) return { error: 'Not a file.' }
  if (st.size > ASSISTANT_PHOTO_MAX_BYTES) return { error: 'Too large to send (over 5 MB).' }
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return { error: `Not found: ${given}` }
  // It may have grown since the stat.
  if (bytes.length > ASSISTANT_PHOTO_MAX_BYTES) return { error: 'Too large to send (over 5 MB).' }
  const ext = sniffPhoto(bytes)
  return ext ? { bytes, ext } : { error: 'Not an image that can be sent (JPEG, PNG, GIF or WebP).' }
}

/** Where a president's images are kept: in its project's central data dir
 *  (~/.openground/projects/<uuid>/agent-photos/, never in the repo — beside the
 *  phone's photos for that president, `phone-photos/`), so deleting the
 *  project deletes them too. Apart from the assistant's photos, which follow
 *  the assistant's runtime (assistantMemory). */
const agentPhotoDir = (uuid: string) => join(projectCentralDir(uuid), 'agent-photos')
/** A kept copy's name: its project, then its bytes' sha256 (the same image of
 *  that project is always the same name), e.g. `<uuid>-i<40 hex>.png`. */
const AGENT_PHOTO_NAME = /^([A-Za-z0-9_-]{1,64})-i[0-9a-f]{40}\.(png|jpg|gif|webp)$/
/** A kept copy nothing used for this long goes on the next keep (as phone-photos/). */
const KEEP_MS = 30 * 86_400_000

/** Which copy each image line got (`key` → name): a line read again (a resend,
 *  the talk fetched again, the Mac chat drawn again) is the image it was the
 *  first time — never what lies at its path now (a reused /tmp/shot.png, a
 *  temp folder emptied at restart) — and is not read again. */
const indexFile = (uuid: string) => join(agentPhotoDir(uuid), 'index.json')
const INDEX_MAX = 2000
let indexWrites: Promise<unknown> = Promise.resolve()
const readIndex = async (uuid: string): Promise<Record<string, string>> => {
  try {
    const v = JSON.parse(await readFile(indexFile(uuid), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}
const remember = (uuid: string, key: string, name: string): Promise<void> => {
  const w = indexWrites.then(async () => {
    const all = Object.entries(await readIndex(uuid)).filter(([k]) => k !== key)
    await atomicWriteJson(indexFile(uuid), Object.fromEntries([...all, [key, name]].slice(-INDEX_MAX)), { mode: 0o600 })
  })
  indexWrites = w.catch(() => {})
  return w
}

/** A president's image line, kept: `key` names the line (its transcript
 *  position for the phone, its place in the chat for the Mac), and the line
 *  keeps the copy it got first (see indexFile). */
export const keepAgentImage = async (path: string, key: string, projectPath: string, now = Date.now()): Promise<{ name: string; file: string } | { error: string }> => {
  const uuid = await projectUUIDFromPath(projectPath).catch(() => null)
  if (!uuid) return { error: 'Not a registered project.' }
  const dir = agentPhotoDir(uuid)
  const known = (await readIndex(uuid))[key]
  if (typeof known === 'string' && AGENT_PHOTO_NAME.test(known) && (await stat(join(dir, known)).catch(() => null))?.isFile())
    return { name: known, file: join(dir, known) }
  const r = await readAgentImage(path)
  if ('error' in r) return r
  const name = `${uuid}-i${createHash('sha256').update(r.bytes).digest('hex').slice(0, 40)}.${r.ext}`
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    for (const f of await readdir(dir).catch(() => [] as string[]))
      if (f !== 'index.json' && (await stat(join(dir, f)).then((s) => now - s.mtimeMs > KEEP_MS, () => false))) await rm(join(dir, f), { force: true }).catch(() => {})
    await writeFile(join(dir, name), r.bytes, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e
    })
  } catch {
    return { error: 'Could not keep it.' }
  }
  await remember(uuid, key, name).catch(() => {})
  return { name, file: join(dir, name) }
}

/** Where a photo of this name may be: a president's kept image (in its
 *  project), or one the assistant keeps (either runtime's folder — both are
 *  the owner's). Only names of these shapes; no name reaches anything else. */
const photoPlaces = (name: string): string[] => {
  const agent = AGENT_PHOTO_NAME.exec(name)
  if (agent) return [join(agentPhotoDir(agent[1]), name)]
  return isAssistantPhotoName(name)
    ? [withLocalClaudeAssistantScope(() => assistantPhotoPath(name)), assistantPhotoPath(name)].filter((p): p is string => !!p)
    : []
}

/** Shrinks to at most `max` bytes (a JPEG), or null. */
export type PhotoShrink = (path: string, max: number) => Promise<Buffer | null>

/** macOS `sips`: a JPEG of at most 2000 px, smaller until it fits. Elsewhere: null. */
const sipsShrink: PhotoShrink = async (path, max) => {
  if (process.platform !== 'darwin') return null
  const dir = await mkdtemp(join(tmpdir(), 'og-phone-photo-'))
  try {
    const out = join(dir, 'small.jpg')
    for (const px of [2000, 1600, 1280, 1024]) {
      await execFileP('/usr/bin/sips', ['-Z', String(px), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', path, '--out', out], { timeout: 10_000 })
      const b = await readFile(out)
      if (b.length <= max) return b
    }
    return null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** A kept photo as the phone gets it: `photo-gone` when there is none by that
 *  name (only names assistantMemory made resolve), `photo-bad` when it is not
 *  an image or cannot be brought under PHONE_PHOTO_MAX. */
export const photoForPhone = async (name: string, shrink: PhotoShrink = sipsShrink): Promise<Buffer | 'photo-gone' | 'photo-bad'> => {
  let path: string | null = null
  let bytes: Buffer | null = null
  for (const p of photoPlaces(name)) {
    bytes = await readFile(p).catch(() => null)
    if (bytes) {
      path = p
      break
    }
  }
  if (!path || !bytes) return 'photo-gone'
  if (!sniffPhoto(bytes)) return 'photo-bad'
  if (bytes.length <= PHONE_PHOTO_MAX) return bytes
  // One shrink per image at a time, and its result kept: asked again (a tap
  // after a lost part, many asks at once) it is never shrunk a second time.
  const hit = shrunk.get(path)
  const small =
    hit && hit.size === bytes.length && hit.shrink === shrink
      ? hit.small
      : (() => {
          const run = shrink(path, PHONE_PHOTO_MAX).catch(() => null)
          shrunk.delete(path)
          shrunk.set(path, { size: bytes.length, shrink, small: run })
          while (shrunk.size > SHRUNK_MAX) shrunk.delete(shrunk.keys().next().value!)
          return run
        })()
  const got = await small
  if (!got || got.length > PHONE_PHOTO_MAX || !sniffPhoto(got)) {
    // A failed shrink is not kept: the next ask tries again.
    if (shrunk.get(path)?.small === small) shrunk.delete(path)
    return 'photo-bad'
  }
  return got
}
/** The last few images shrunk for the phone: kept path → its size then, the
 *  shrink used and the (possibly still running) result. */
const shrunk = new Map<string, { size: number; shrink: PhotoShrink; small: Promise<Buffer | null> }>()
const SHRUNK_MAX = 4

/** The sealed `photo` frames that carry one image to the phone, in order. */
export const photoFrames = (id: string, name: string, bytes: Buffer): Record<string, unknown>[] => {
  const parts = Math.ceil(bytes.length / PHONE_PHOTO_PART)
  return Array.from({ length: parts }, (_, part) => ({
    type: 'photo',
    id,
    name,
    part,
    parts,
    data: bytes.subarray(part * PHONE_PHOTO_PART, (part + 1) * PHONE_PHOTO_PART).toString('base64'),
  }))
}

/** The Mac chat's view of a president's image line: the copy that line got
 *  first (keepAgentImage), so it never changes or vanishes with its path. */
export const readKeptAgentImage = async (path: string, key: string, projectPath: string): Promise<AgentImage> => {
  const kept = await keepAgentImage(path, key, projectPath)
  if ('error' in kept) return kept
  const bytes = await readFile(kept.file).catch(() => null)
  const ext = bytes && sniffPhoto(bytes)
  return bytes && ext ? { bytes, ext } : { error: 'Not found.' }
}
