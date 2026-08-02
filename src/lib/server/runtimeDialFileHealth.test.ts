// THE KILL SWITCH MUST NOT FLIP ITSELF BACK ON WHEN THE FILE GOES BAD.
//
// `swarmRuntimeDialParity.test.ts` and `settingsRuntimeDials.test.ts` both pin
// the dial at the VALUE level: given a settings object, which runtime wins. This
// file pins the level underneath — given a settings FILE in some state of
// disrepair, which runtime wins. They are different questions and the second one
// had the opposite answer.
//
// Measured 2026-08-02 (isolated HOME), before the fix:
//
//     A  no settings.json                      ⇒ manager sdk   (intended)
//     B  {"swarmManagerRuntime":{"mode":"pty"}} ⇒ manager pty   (intended)
//     C  that same file, chmod 000              ⇒ manager SDK   ← kill switch inverted
//     D  that same file, unparseable            ⇒ manager SDK   ← kill switch inverted
//
// So an owner who had deliberately turned the SDK commander OFF got it back the
// moment the file stopped being readable — silently, with no log and no throw.
// The cause is a tolerant reader: store.readJson catches BOTH the read failure
// and the parse failure and returns the fallback, so "the file is broken" and
// "the key was never written" arrive at the dial as the same thing (`undefined`),
// and absent ⇒ sdk is the documented rule. swarmManager's
// `.catch(() => ({mode:'pty'}))` cannot save it either: nothing rejects.
//
// The fix distinguishes the two. ABSENT keeps its rule (a fresh install has
// never written anything, and that is not evidence of a broken file). UNREADABLE
// and UNPARSEABLE fall to the kill switch.
//
// WHY THE WORKER DIAL IS ASSERTED HERE TOO. When this file was written it
// already answered pty — but by COINCIDENCE: its absent-default happened to be
// pty, so the tolerant fallback landed on the safe side by luck rather than by
// rule. THAT COINCIDENCE EXPIRED ON 2026-08-02, when the worker's absent-default
// flipped to sdk to match the commander's (its own card — the flip had shipped
// in chooseWorkerRuntime a day earlier but could not reach dispatch, because
// this very reader sat in between turning absent back into pty). Every worker
// assertion below is now load-bearing: delete the file-health probe and the
// broken-file cases go red instead of passing on the old luck.

import { describe, it, expect, afterEach } from 'vitest'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { settingsFile } from './paths'
import { getManagerRuntimeDial, getWorkerRuntimeDial } from './store'

const write = async (raw: string) => {
  // `dirname`, NOT `new URL('.', 'file://'+path).pathname` — the URL round trip
  // PERCENT-ENCODES the path (`/tmp/a b/` becomes `/tmp/a%20b/`), so on a machine
  // whose TMPDIR contains a space this would create a DIFFERENT directory and
  // the test would silently stop testing the home it pinned.
  await mkdir(dirname(settingsFile()), { recursive: true }).catch(() => {})
  await writeFile(settingsFile(), raw, 'utf8')
}

/** Make the file unreadable and report whether that ACTUALLY blocks a read.
 *
 *  chmod is not a guarantee: root ignores the mode bits, and Windows has no
 *  equivalent. Rather than assert something the platform never did, probe it —
 *  a case that silently tests nothing is worse than one that says it skipped. */
const denyRead = async (): Promise<boolean> => {
  await chmod(settingsFile(), 0o000)
  try {
    await readFile(settingsFile(), 'utf8')
    return false // the mode bits did not bite (root / Windows)
  } catch {
    return true
  }
}

afterEach(async () => {
  // Restore the mode FIRST — a 000 file survives afterEach cleanup and would
  // poison every later test in this worker (and resist the tmp-dir teardown).
  await chmod(settingsFile(), 0o600).catch(() => {})
  await rm(settingsFile(), { force: true }).catch(() => {})
})

describe('the runtime dials at the FILE level — a broken settings.json is not consent', () => {
  it('A: no settings.json at all ⇒ BOTH dials sdk (the documented fresh-install default)', async () => {
    await rm(settingsFile(), { force: true })
    expect((await getManagerRuntimeDial()).mode).toBe('sdk')
    // ⚠ THIS LINE SAID 'pty' UNTIL 2026-08-02, and that was the defect, not the
    // rule: the 08-01 flip lived in chooseWorkerRuntime while this reader — the
    // one dispatch actually consults — still answered pty, so 0.11.47 shipped
    // drawing the worker switch ON over a PTY fleet. Both readers now resolve
    // absent to sdk. Changing it back is a behaviour change, not a fix.
    expect((await getWorkerRuntimeDial()).mode).toBe('sdk')
  })

  it('B: an explicit {"mode":"pty"} ⇒ commander pty', async () => {
    await write(JSON.stringify({ swarmManagerRuntime: { mode: 'pty' } }))
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
  })

  it('B2: an explicit {"mode":"sdk"} on a READABLE file ⇒ commander sdk', async () => {
    // The control. Without it, "always pty" would pass every other case here.
    await write(JSON.stringify({ swarmManagerRuntime: { mode: 'sdk' } }))
    expect((await getManagerRuntimeDial()).mode).toBe('sdk')
  })

  it('C: a settings.json we cannot READ ⇒ commander pty, whatever it used to say', async (ctx) => {
    // Seeded with the SDK explicitly ON, so passing cannot be explained by the
    // stored value: the only reason to answer pty is that the file is unreadable.
    await write(JSON.stringify({ swarmManagerRuntime: { mode: 'sdk' } }))
    // `ctx.skip()`, not `return` — an early return reports as a PASS, so on root
    // or Windows this case would have gone on claiming a guarantee it never
    // exercised. A skip is visible in the run; a silent pass is a lie.
    if (!(await denyRead())) ctx.skip()
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
    expect((await getWorkerRuntimeDial()).mode).toBe('pty')
  })

  it('C2: a DANGLING SYMLINK is not a fresh install either ⇒ commander pty', async () => {
    // Dotfiles setups symlink settings.json into a synced folder. While that
    // target is away (unmounted volume, repo not cloned yet) `readFile` reports
    // ENOENT — the same code as "never written" — so without the lstat probe the
    // kill switch would sit inverted for exactly as long as the link is broken.
    await rm(settingsFile(), { force: true })
    await symlink(join(dirname(settingsFile()), 'nowhere.json'), settingsFile())
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
    // ⚠ THE LINE BELOW NOW HAS TEETH TOO. It used to be a tripwire only — green
    // whether or not the lstat probe existed, because the worker's ABSENT default
    // was itself pty. Since that default flipped to sdk (2026-08-02) a dangling
    // symlink WOULD read as a fresh install and turn the experiment on, so this
    // assertion fails the moment the probe is removed. It is proof now, not a
    // placeholder.
    expect((await getWorkerRuntimeDial()).mode).toBe('pty')
    // The WRITE side of this same state — that a refused write leaves the
    // symlink a symlink instead of replacing it with a real file — is a
    // different guarantee and lives in settingsWriteGuard.test.ts.
  })

  it('D: a settings.json we cannot PARSE ⇒ commander pty', async () => {
    await write('{ "swarmManagerRuntime": { "mode": "sdk" },,, oops')
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
    expect((await getWorkerRuntimeDial()).mode).toBe('pty')
  })

  it('D2: valid JSON that is not an OBJECT is corrupt too ⇒ commander pty', async () => {
    // readJson already refuses these shapes (a bare string/array/number would
    // spread into char/numeric keys) — but it refuses them by returning the
    // fallback, which is exactly the "looks absent" confusion this file exists
    // to break. A file holding `"sdk"` is damaged, not unwritten.
    for (const raw of ['"sdk"', '["sdk"]', '42', 'null']) {
      await write(raw)
      expect((await getManagerRuntimeDial()).mode, raw).toBe('pty')
    }
  })

  it('E: a readable, parseable file that simply has no dial key ⇒ still sdk', async () => {
    // The boundary that matters most: "healthy file, key never written" must NOT
    // be dragged to pty by the fix. Otherwise closing the hole would quietly
    // revert the 2026-08-02 default flip for every user with any settings at all.
    await write(JSON.stringify({ defaultWorkspace: null, projects: [] }))
    expect((await getManagerRuntimeDial()).mode).toBe('sdk')
  })
})
