// One OS process owns the receipts journal (<home>/runtime/receipts-v2.json and
// runtime/receipt-archive/) at a time.
//
// conversationReceipts.ts marks every 'executing' receipt claimed by another boot
// as cut off by a restart ('uncertain') when it opens the journal. That is only
// true when the claiming process is gone. On 2026-11-20 a worker started
// `npm run dev:alt` on the same ~/.openground: its first read marked the live
// app's in-flight tool calls 'uncertain'. One such mark denies every tool in that
// project, ends each new worker before `claude` starts and keeps the commander
// from launching — two projects stood still for three days. Nothing stopped two
// processes from writing the journal over each other either.
//
// So the journal has one owner, checked at its single choke point
// (conversationReceipts.ts transaction()). While the owner lives, any other
// process gets RuntimeJournalOwnedElsewhere before it reads or writes. The owner
// alone marks a gone owner's unfinished work 'uncertain', so a real restart is
// held exactly as before. Builds from before this file know no lock: the journal
// moved to runtime/receipts-v2.json and their path, runtime/receipts.json, is a
// folder they fail closed on (conversationReceipts.ts retireLegacyJournal).
//
// An owner record is {bootId, pid, port}. `port` is a loopback listener the
// owner opens before it publishes the record and never closes, so only the end
// of that process closes it (the kernel does, whatever way the process ends).
// A probe sends one HTTP-shaped line; the owner answers a hash of its boot id.
// Gone takes proof; "cannot tell" counts as alive:
// - gone: no process has the pid (ESRCH); or nothing listens on the port
//   (ECONNREFUSED); or what listens there says something else (the port number
//   went to another program; the line makes the many programs that wait for the
//   client to speak, HTTP servers above all, answer as well).
// - alive: everything else. A stopped, busy or sleeping owner still accepts the
//   connection in the kernel and simply does not answer: there is no lease and no
//   timeout to run out. An owner out of file descriptors closes the connection
//   without a word; that is not proof either.
// The same rule on every OS, and no pid-reuse guess: a pid alone says nothing
// after a reboot, where old pids soon belong to other programs.
//
// A probe of a silent owner stays in its accept queue until the owner runs again
// (a reset does not free the slot; measured on macOS), and Windows refuses
// connections to a full queue. So a silent holder is probed at most once a minute.
//
// Takeover is a compare-and-swap: the next generation is published with link(2),
// which never overwrites an existing name (EEXIST), and withdrawn again unless
// every other record in the folder is one this process judged, unchanged.
//
// Known limits: an app version from before this file writes no owner record, so a
// live app is protected once it runs this code itself. Pids and loopback ports
// belong to one machine: a data folder shared with a container or another host is
// not covered. A reused pid plus a program on the recorded port that neither
// speaks nor answers still reads as alive until that program lets go of the
// port. No record is published without a port (a failed listen fails that call,
// the next one tries again); one found without a port is from a build that
// never shipped and counts as alive while any process has its pid. The data
// folder needs hard links (APFS, NTFS, ext4). Never delete runtime/journal-owner
// while any OPEN GROUND process runs: the next process to ask then owns the
// journal, and when that is not the live app, the app is refused on every call
// until that process exits (measured 2026-11-26) — the incident's stop, without
// the marks.
import { createHash } from 'node:crypto'
import { link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'

export class RuntimeJournalOwnedElsewhere extends Error {
  constructor(readonly pid: number) {
    // Agents read this. The owner is usually the live app (2026-11-20); but when
    // another process asked first while the app was down, the refused one is the
    // app, and moving it to another home would leave it empty.
    super(`Another OPEN GROUND process (pid ${pid}) owns this data folder's runtime journal. Check what pid ${pid} is before acting: if it is the live app, give this copy its own OPENGROUND_HOME; if this is the app, stop pid ${pid} only once it is confirmed a stray copy, and never move the app to another OPENGROUND_HOME. Never delete runtime/journal-owner/ while any OPEN GROUND process runs.`)
    this.name = 'RuntimeJournalOwnedElsewhere'
  }
}

// Unknown keys are ignored, so a later version may add fields without this one
// reading its record as broken (and its owner as gone).
const recordSchema = z.object({ bootId: z.string().min(1).max(128), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535).optional() })
type OwnerRecord = z.infer<typeof recordSchema>
// Canonical names only: a record is read back as `${generation}.json`.
const generationOf = (name: string): number | undefined => {
  const value = Number(/^([1-9]\d{0,14})\.json$/.exec(name)?.[1])
  return Number.isSafeInteger(value) ? value : undefined
}
// Windows reports a refused loopback connection only after its SYN retries (about 2 s).
const PROBE_MS = 5_000
const SILENT_MS = 60_000
const PROBE = 'GET /openground-journal-owner HTTP/1.0\r\n\r\n'
/** What an owner's listener says. The boot id itself never leaves the process. */
const answerOf = (bootId: string): string => createHash('sha256').update(`openground-journal-owner:${bootId}`).digest('hex')

const listeners = new Map<string, Promise<number | undefined>>()
/** The port of this process's listener for `bootId`, opened on first use. */
const listenerPort = (bootId: string): Promise<number | undefined> => {
  let port = listeners.get(bootId)
  if (!port) {
    port = new Promise((resolve) => {
      // The probe's line is read and dropped: closing on unread input resets the connection.
      const server = createServer((socket) => { socket.on('error', () => {}).resume().end(answerOf(bootId)) })
      // A failed listen resolves without a port, and the next claim tries again.
      // Later errors (a failed accept) leave the listener open.
      server.on('error', () => { if (!server.listening) { listeners.delete(bootId); resolve(undefined) } })
      server.listen(0, '127.0.0.1', () => { server.unref(); resolve((server.address() as AddressInfo).port) })
    })
    listeners.set(bootId, port)
  }
  return port
}

const silentUntil = new Map<string, number>()
/** True only on proof that the holder's listener is no more. */
const listenerGone = (port: number, bootId: string): Promise<boolean> => new Promise((resolve) => {
  const expected = answerOf(bootId)
  let heard = ''
  const socket = connect({ host: '127.0.0.1', port }, () => { socket.write(PROBE) })
  socket.setEncoding('utf8').setTimeout(PROBE_MS)
    .on('data', (chunk: string) => { heard += chunk; if (!expected.startsWith(heard)) { resolve(true); socket.destroy() } })
    .on('end', () => resolve(false))
    .on('timeout', () => { silentUntil.set(`${port}:${bootId}`, performance.now() + SILENT_MS); resolve(false); socket.resetAndDestroy() })
    .on('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'))
})

const gone = async (holder: OwnerRecord): Promise<boolean> => {
  // Our own pid is never another live process: an earlier load of this module
  // (tests reload modules), or a gone owner whose pid this process now has.
  if (holder.pid === process.pid) return true
  try { process.kill(holder.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true }
  if (holder.port === undefined || (silentUntil.get(`${holder.port}:${holder.bootId}`) ?? 0) > performance.now()) return false
  return listenerGone(holder.port, holder.bootId)
}

/** What this process records on each call it claims: the same proof of life an
 *  owner record carries, so a call is held only once its own process is gone. */
export const runtimeJournalHolder = async (bootId: string): Promise<{ pid: number; port: number }> => {
  const port = await listenerPort(bootId)
  // A claim only a pid speaks for could never be held once cut off (see claim).
  if (!port) throw noListener()
  return { pid: process.pid, port }
}
const noListener = () => new Error('The runtime journal could not open its loopback listener (127.0.0.1); this call is refused and the next one tries again.')
/** True only on proof that the process recorded as `holder` is gone. */
export const runtimeJournalHolderGone = (holder: OwnerRecord): Promise<boolean> => gone(holder)

let warnedPid: number | undefined

/** Publishes `generation` for this process. False when another claim got there first. */
const claim = async (dir: string, judged: Map<string, string>, generation: number, bootId: string): Promise<boolean> => {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Listening before the record can be read: a reader must never find our port closed.
  const port = await listenerPort(bootId)
  // No port, no record: only a pid would speak for it, and after a restart a
  // reused pid would refuse the real app its journal for as long as it lives.
  if (!port) throw noListener()
  const mine = `${generation}.json`
  const draft = join(dir, `${generation}.${bootId}.tmp`)
  await writeFile(draft, JSON.stringify({ bootId, pid: process.pid, port }), { mode: 0o600 })
  try {
    await link(draft, join(dir, mine))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    throw new Error(`The runtime journal owner record could not be published (${code}). Its data folder must be writable and allow hard links (APFS, NTFS, ext4).`)
  } finally {
    await unlink(draft).catch(() => {})
  }
  // Only records judged gone may stay beside ours, each as it was judged. A
  // listing can be older than two takeovers, and a name judged then can hold a
  // live claimer's record now (generations restart when the folder is emptied).
  try {
    const others = (await readdir(dir)).filter((name) => name !== mine && generationOf(name) !== undefined)
    for (const name of others) {
      const now = await readFile(join(dir, name), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (now !== undefined && now !== judged.get(name)) {
        await unlink(join(dir, mine)).catch(() => {})
        return false
      }
    }
    for (const name of others) await unlink(join(dir, name)).catch(() => {})
    return true
  } catch (error) {
    // A claim that could not be checked must not stay: the next call would read
    // our record as the newest and take it for ownership.
    await unlink(join(dir, mine)).catch(() => {})
    throw error
  }
}

/** Resolves when this process (as `bootId`) owns `<home>/runtime`'s receipts
 *  journal, claiming it first if nobody does or every recorded owner is gone.
 *  Throws RuntimeJournalOwnedElsewhere while another live process owns it. */
export const assertRuntimeJournalOwner = async (home: string, bootId: string): Promise<void> => {
  const dir = join(home, 'runtime', 'journal-owner')
  attempts: for (let attempt = 0; attempt < 5; attempt++) {
    let listed: string[] = []
    try { listed = await readdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const generations = listed.map(generationOf).filter((value): value is number => value !== undefined).sort((a, b) => b - a)
    const judged = new Map<string, string>()
    // Newest first. Every record is judged, not only the newest: a process that
    // died between publishing and withdrawing leaves one above the live owner's.
    for (const generation of generations) {
      let raw: string
      try { raw = await readFile(join(dir, `${generation}.json`), 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue attempts
        throw error
      }
      judged.set(`${generation}.json`, raw)
      // Unparseable: link(2) publishes only complete files, so no live process
      // holds this. It counts as gone.
      const holder = recordSchema.safeParse((() => { try { return JSON.parse(raw) } catch { return undefined } })()).data
      if (!holder) continue
      if (holder.bootId === bootId) {
        // The newest record names the owner. An older one of ours lies under a
        // gone process's stray claim: publish again above it.
        if (generation === generations[0]) return
        continue
      }
      if (!await gone(holder)) {
        const refused = new RuntimeJournalOwnedElsewhere(holder.pid)
        // Callers retry quietly (the 2 s inbox tick swallows errors): say it once.
        if (warnedPid !== holder.pid) { warnedPid = holder.pid; console.warn(`[openground] ${refused.message}`) }
        throw refused
      }
    }
    if (await claim(dir, judged, (generations[0] ?? 0) + 1, bootId)) return
  }
  throw new Error('The runtime journal owner could not be settled.')
}
