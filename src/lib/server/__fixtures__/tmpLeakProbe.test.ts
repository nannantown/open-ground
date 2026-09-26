// Run as a child vitest by testHomeSweep.test.ts: leaves a temp dir behind the
// way many real test files do, so the parent can check setup-home removed it.
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { it } from 'vitest'

it('leaves a temp dir behind', () => {
  writeFileSync(join(mkdtempSync(join(tmpdir(), 'og-leak-probe-')), 'f'), 'x')
})
