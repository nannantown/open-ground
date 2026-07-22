// Probe for the TMPDIR-poisoning teeth (testHomeGuard.test.ts).
//
// Runs as a CHILD PROCESS, because the holes it measures exist only when the
// environment is in place BEFORE the guard module loads. testHomeGuard samples
// its baselines once at import, so `vi.stubEnv(…)` inside a running suite can
// never reproduce them — the answers are already fixed. An in-process test that
// tried went green for the wrong reason and hid a live hole for a day (0719).
//
// Writes nothing and needs no directory to exist: it only asks the fence for a
// verdict on paths, which is a pure predicate over strings. That is deliberate —
// the scenario under test is "the real home is writable and unprotected", and a
// probe that actually wrote there to prove the point would be the very accident
// the fence exists to prevent. It is also why TMPDIR can be poisoned at
// `OG_PROBE_TMPDIR` *after* startup: tsx needs a writable TMPDIR to boot, and
// `tempRoots()` re-reads the variable on every call, so the poisoning lands
// exactly where it matters (condition 1) without asking the OS to create
// anything inside the user's home.
//
// Prints one JSON line of verdicts, each 'REFUSED' (fence fired) or 'ALLOWED'.
import { homedir, userInfo } from 'os'
import { join } from 'path'
import { assertTestHomeIsolated } from '../testHomeGuard'

const poison = process.env.OG_PROBE_TMPDIR
if (poison) process.env.TMPDIR = poison

const verdict = (path: string, anchor: string): 'REFUSED' | 'ALLOWED' => {
  try {
    assertTestHomeIsolated(path, anchor)
    return 'ALLOWED'
  } catch {
    return 'REFUSED'
  }
}

// The REAL user's home, read the way the fence reads it — from passwd, so it
// survives an isolated $HOME. This is the data the fence exists to protect.
const passwd = (() => {
  try {
    return userInfo().homedir
  } catch {
    return homedir()
  }
})()

process.stdout.write(
  JSON.stringify({
    home: homedir(),
    passwd,
    // The three homedir-anchored resolvers, spelled the way their callers do.
    hooksInstall: verdict(homedir(), 'hooksInstall (homedir-anchored)'),
    claudeTrust: verdict(
      join(homedir(), '.claude.json'),
      'claudeTrust (CLAUDE_CONFIG_PATH ?? homedir()/.claude.json)',
    ),
    ogManageSkill: verdict(join(homedir(), '.claude'), 'ogManageSkill (homedir()/.claude/skills)'),
    // The REAL user's data, which must stay refused no matter what $HOME says.
    passwdOpenground: verdict(join(passwd, '.openground'), 'openGroundHome()'),
    passwdClaudeJson: verdict(join(passwd, '.claude.json'), 'claudeTrust (passwd home)'),
  }),
)
