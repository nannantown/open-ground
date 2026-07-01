import { writeFile, rename, rm, open } from 'fs/promises'
import { dirname, join, basename } from 'path'

// Atomic file write via a sibling temp file + `rename`. Two DISTINCT guarantees
// are at play here; keep them straight (an earlier version of this comment
// conflated them):
//
//   1. ATOMICITY (always on). rename(2) within one directory (= one filesystem)
//      swaps the target in a single step, so a concurrent READER never sees a
//      torn / half-written file, and the original stays intact until the rename
//      lands. This also covers a mid-write process death — a crash / forced quit
//      / `kill` leaves the (un-renamed) temp behind and the original untouched,
//      because the OS PAGE CACHE survives a process dying, so even data that was
//      never fsync'd is still readable afterward. This is what every JSON read
//      site in src/lib/server relies on (they treat a parse failure as
//      "empty/default" and would otherwise lose data on the next save).
//
//   2. DURABILITY across POWER LOSS / kernel panic (opt-in via `fsync: true`).
//      Atomicity alone does NOT survive a power cut: the rename's directory entry
//      can reach disk while the temp file's DATA BLOCKS have not, so the target
//      reappears empty/zero-length and the previous contents are gone. To close
//      that window we fsync the file's data BEFORE the rename and fsync the
//      DIRECTORY AFTER it, so both the bytes and the rename are persisted.
//      Caveat (macOS): Node's fsync maps to fsync(2), which flushes to the
//      storage device but NOT the device's internal write cache. True power-loss
//      durability on a drive that caches writes needs fcntl(F_FULLFSYNC), which
//      Node core does not expose (fs.constants.F_FULLFSYNC is undefined — it
//      would require a native addon). So `fsync: true` gives strong durability on
//      Linux and to-the-device durability on macOS: a large improvement over no
//      fsync, with the residual F_FULLFSYNC gap documented honestly rather than
//      falsely promised. Only callers persisting the user's irreplaceable WORK
//      data (tasks.json) pass it; high-frequency debounced writes (canvas) skip
//      it to avoid per-save fsync latency (see canvasData.writeCanvasFile).
//
// The temp file is a hidden sibling so it lands on the same filesystem (cross-
// device rename throws EXDEV) and a per-process monotonic counter keeps the
// name unique even if two writes to the same path overlap in-process.
let seq = 0

// fsync the directory so a rename's new entry is itself durable. Best-effort:
// not all platforms/filesystems allow opening a directory for fsync (Windows
// rejects it), and a failure here must never fail the write — the file data was
// already fsync'd; the worst case is the rename being slightly less durable.
const fsyncDir = async (dir: string): Promise<void> => {
  if (process.platform === 'win32') return // directory fsync is unsupported on Windows
  let dh: Awaited<ReturnType<typeof open>> | undefined
  try {
    dh = await open(dir, 'r')
    await dh.sync()
  } catch {
    /* best-effort */
  } finally {
    await dh?.close().catch(() => {})
  }
}

// `mode` (when given) is applied to the temp file before the rename, so the
// final file inherits owner-only perms atomically — there's no window where the
// destination exists with looser permissions (matters for auth.json = 0600).
// `fsync` (opt-in) upgrades the write from atomic to atomic+durable — see (2).
export const atomicWriteText = async (
  path: string,
  text: string,
  opts?: { mode?: number; fsync?: boolean },
): Promise<void> => {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${seq++}`)
  try {
    if (opts?.fsync) {
      // Write through a handle so we can fsync the DATA before the rename swaps
      // the file in — otherwise a power cut could surface the rename with the
      // temp's blocks unwritten (an empty/zero target).
      const fh = await open(tmp, 'w', opts.mode ?? 0o666)
      try {
        await fh.writeFile(text, 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await rename(tmp, path)
      await fsyncDir(dirname(path))
    } else {
      await writeFile(tmp, text, { encoding: 'utf8', ...(opts?.mode != null ? { mode: opts.mode } : {}) })
      await rename(tmp, path)
    }
  } catch (e) {
    // writeFile (e.g. ENOSPC mid-write) OR rename (perms, EXDEV, …) failed —
    // drop any orphan temp so a failed save never litters the dir. The original
    // target is untouched: rename is the only step that swaps it, and it either
    // fully succeeded or never ran. The caller's data on disk stays consistent.
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

// `async` so a non-serialisable `data` (circular ref, BigInt) surfaces as a
// REJECTED promise rather than a SYNCHRONOUS throw. Without it, JSON.stringify
// throws while the argument is being built — before atomicWriteText returns a
// promise — so a fire-and-forget `atomicWriteJson(...).catch(...)` caller would
// not catch it (uncaught exception → process crash). Awaiting callers are
// unaffected. The original file on disk is never touched: the throw happens
// before any write.
export const atomicWriteJson = async (
  path: string,
  data: unknown,
  opts?: { mode?: number; fsync?: boolean },
): Promise<void> => atomicWriteText(path, JSON.stringify(data, null, 2), opts)
