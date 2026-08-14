// gitInit.ts — one-click `git init` for a registered project that has no repo
// yet. Backs POST /api/project/git-init (the Swarm tab's env-preflight banner
// offers it on the `notAGitRepo` issue, so a non-programmer owner never has to
// type the `git init` the old banner copy pointed them at).
//
// Three steps, all required: `git init`, `git add -A`, and an initial commit.
// The commit uses `--allow-empty` so HEAD exists even in a brand-new empty
// folder — a swarm worker's worktree needs a HEAD to branch from
// (createSwarmWorktree in swarmWorker.ts), and a repo with no commits has none;
// creating that HEAD is the whole point of committing here.
//
// Every spawn is execFile with an argv ARRAY (never a shell string — nothing
// here is ever shell-interpreted), with the house git options (swarmWorker.ts
// GIT_OPTS): GIT_TERMINAL_PROMPT=0 so git can never hang on a credential/ident
// prompt, and a hard 30s timeout per step. env is built PER CALL, not snapshot
// at module load, so a PATH/config change after boot (and a test pinning git
// env) is honoured.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

/** Per-call exec options — house convention (swarmWorker.ts GIT_OPTS) plus
 *  LC_ALL=C: the identity-failure detection below matches git's ENGLISH
 *  message, and a gettext-enabled git under a non-English locale would
 *  translate it (same trap swarmEnvPreflight.ts documents for its
 *  "not a git repository" match). */
const gitOpts = (cwd: string) => ({
  cwd,
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
})

/** Does this commit failure mean "user.name/user.email are unset"? Covers the
 *  wordings git actually emits: "*** Please tell me who you are.", "fatal:
 *  unable to auto-detect email address", "fatal: no email was given and
 *  auto-detection is disabled" (user.useConfigOnly), "empty ident", and any
 *  message naming user.name/user.email outright. */
const IDENT_FAILURE_RE = /tell me who you are|auto-detect|empty ident|user\.(name|email)/i

const stderrOf = (e: unknown): string => {
  const err = e as { stderr?: unknown; message?: unknown }
  if (typeof err?.stderr === 'string' && err.stderr.trim()) return err.stderr
  return typeof err?.message === 'string' ? err.message : String(e)
}

/** Tail of a git failure, bounded so a 500 body never carries an unbounded
 *  dump (the useful part — "fatal: …" — is at the END of git's stderr). */
export const gitErrorTail = (e: unknown, max = 200): string => {
  const s = stderrOf(e).trim() || 'git failed'
  return s.length <= max ? s : s.slice(-max)
}

export interface GitInitOutcome {
  /** The commit needed the built-in fallback identity ("OPEN GROUND"
   *  <openground@localhost>) because git has no user.name/user.email. */
  fallbackIdentity: boolean
}

/**
 * Initialize a git repo in `projectPath` and land an initial commit so HEAD
 * exists. Throws the failing step's error (feed it to {@link gitErrorTail} for
 * a response body). The caller is responsible for the registry allowlist check
 * AND for refusing an existing repo first (isGitRepoRoot) — this function
 * assumes a non-repo cwd.
 *
 * If the commit fails because user.name/email are unset, it retries ONCE with
 * an explicit `-c` identity instead of failing — a machine that never
 * configured git (exactly the owner this button exists for) must still end up
 * with a HEAD. The fallback is per-invocation only (`-c`, never `git config`):
 * nothing is written into the user's git configuration.
 */
export const initGitRepo = async (projectPath: string): Promise<GitInitOutcome> => {
  await execFile('git', ['init'], gitOpts(projectPath))
  await execFile('git', ['add', '-A'], gitOpts(projectPath))
  const commitArgs = ['commit', '--allow-empty', '-m', 'Initial commit']
  try {
    await execFile('git', commitArgs, gitOpts(projectPath))
    return { fallbackIdentity: false }
  } catch (e) {
    if (!IDENT_FAILURE_RE.test(stderrOf(e))) throw e
    await execFile(
      'git',
      ['-c', 'user.name=OPEN GROUND', '-c', 'user.email=openground@localhost', ...commitArgs],
      gitOpts(projectPath),
    )
    return { fallbackIdentity: true }
  }
}
