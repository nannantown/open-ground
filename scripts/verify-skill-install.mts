#!/usr/bin/env tsx
// verify-skill-install — run the boot-time ~/.claude installers ONCE, against the
// REAL home, and print what each file's outcome was.
//
// WHY IT EXISTS. The install is a boot side-effect whose result only ever
// reached a console.log, so "the skill I shipped never reached the machine" is
// invisible until something behaves strangely. It was invisible for 9 days:
// ~/.claude/skills/{order,supply}/SKILL.md predated the managed-by marker, so
// every update reported 'kept-user' and silently did not apply (fixed by
// adoptDigests — managedFileInstall.ts). This script makes the answer one
// command instead of a server restart plus a log hunt.
//
//   npx tsx scripts/verify-skill-install.mts
//
// It writes exactly what a normal app boot writes — nothing more. Safe to
// re-run; a second run reports 'unchanged'.

import { installSwarmTooling } from '../src/lib/server/swarmToolingInstall'
import { installOgManageSkill } from '../src/lib/server/ogManageSkill'

const main = async () => {
  const rows: { name: string; outcome: string; path: string; error?: string }[] = []

  for (const { name, result } of await installSwarmTooling()) {
    rows.push({ name, outcome: result.outcome, path: result.path, ...(result.error ? { error: result.error } : {}) })
  }
  const og = await installOgManageSkill()
  rows.push({ name: 'og-manage', outcome: og.outcome, path: og.path, ...(og.error ? { error: og.error } : {}) })

  for (const r of rows) {
    console.log(`${r.outcome.padEnd(10)} ${r.name.padEnd(24)} ${r.path}${r.error ? `\n           ↳ ${r.error}` : ''}`)
  }

  // kept-user is the one outcome that means "your update did NOT apply".
  const stuck = rows.filter((r) => r.outcome === 'kept-user' || r.outcome === 'error')
  if (stuck.length) {
    console.log(
      `\n⚠ ${stuck.length} file(s) did not receive the shipped version. ` +
        `'kept-user' = the copy on disk carries no managed-by marker and is not a digest OPEN GROUND claims ` +
        `(swarmToolingInstall.ts). Either it is genuinely yours, or its digest belongs in an adopt list.`,
    )
    process.exitCode = 1
  }
}

void main()
