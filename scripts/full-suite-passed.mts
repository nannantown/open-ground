// Commander's check before integrating a worker branch (skills/og-manage
// "Re-verify"): exit 0 = the worker's own full `npm test` already passed on this
// exact HEAD and HEAD contains origin/main, so the suite need not run again.
// exit 1 = run it. Logic: fullSuiteVerdict in src/test/fullSuiteRecord.ts.
//   npx tsx scripts/full-suite-passed.mts <worktree> [base=origin/main]
import { fullSuiteVerdict } from '../src/test/fullSuiteRecord'

const v = fullSuiteVerdict(process.argv[2] ?? process.cwd(), process.argv[3])
console.log(v.why)
process.exit(v.ok ? 0 : 1)
