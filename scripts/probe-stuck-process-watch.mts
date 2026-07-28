// End-to-end probe for stuckProcessWatch: does it stay quiet on THIS machine,
// and would it actually have fired on the 2026-07-28 process table?
//   npx tsx scripts/probe-stuck-process-watch.mts
import {
  findStuckProcesses,
  parseStuckProcesses,
  describeStuckProcesses,
  STUCK_MIN_COUNT,
} from '../src/lib/server/stuckProcessWatch'

console.log('--- live machine (should be silent when healthy) ---')
const live = await findStuckProcesses()
console.log(`stuck now: ${live.length}  → ${live.length >= STUCK_MIN_COUNT ? 'WOULD NOTIFY' : 'silent'}`)
if (live.length) console.log(describeStuckProcesses(live))

// The real shape captured during the incident (ps -axo pid=,ppid=,stat=,etime=,comm=).
const incident = [
  '  537     1 U    05:35:14 /usr/bin/git',
  ' 6151     1 U    05:35:08 /usr/bin/git',
  ' 7354     1 U    05:35:06 /usr/bin/git',
  '94049     1 U    05:35:22 /usr/bin/git',
  // …and the ordinary neighbours it must NOT report:
  '  336     1 Ss   03:01:48 /usr/libexec/logd',
  ' 1728     1 S    02:10:00 /Applications/OPEN GROUND.app/Contents/MacOS/OPEN GROUND',
  ' 9999  4321 U    05:00:00 /usr/bin/git', // stuck but has a LIVE parent
].join('\n')

console.log('\n--- replay of the 2026-07-28 table ---')
const found = parseStuckProcesses(incident)
console.log(`detected: ${found.length} (expected 4 — the orphaned+wedged git only)`)
console.log(`would notify: ${found.length >= STUCK_MIN_COUNT}`)
console.log(`message: ${describeStuckProcesses(found)}`)

const ok = live.length === 0 && found.length === 4
console.log(`\nverdict: ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
