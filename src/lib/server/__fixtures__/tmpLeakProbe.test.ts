// Run as a child vitest by testHomeSweep.test.ts: leaves a temp dir behind the
// way many real test files do, so the parent can check setup-home removed it.
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { it } from 'vitest'
import { markCoolingUntil, __resetQuotaForTest } from '../swarmQuota'

it('leaves a temp dir behind', () => {
  writeFileSync(join(mkdtempSync(join(tmpdir(), 'og-leak-probe-')), 'f'), 'x')
  // Model the sensor's non-blocking persistence queue at the end of a file.
  __resetQuotaForTest()
  for (let n = 0; n < 20; n++) markCoolingUntil('sonnet', Date.now() + 60000 + n)
})
