// Explicit dummy Owner fixture; never reads/writes the user's auth or data.
const { realpathSync, writeFileSync } = require('node:fs')
const { join, relative, isAbsolute } = require('node:path')
const { tmpdir } = require('node:os')
const { strict: assert } = require('node:assert')
const dir = realpathSync(process.argv[2])
const rel = relative(realpathSync(tmpdir()), dir)
assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Owner fixture requires an isolated temp directory')
writeFileSync(join(dir, 'auth.json'), JSON.stringify({
  user: { id: '11111111-2222-4333-8444-555555555555', email: 'e2e-owner@example.invalid', provider: 'google' },
  accessToken: 'dummy-e2e-owner', refreshToken: 'dummy-e2e-refresh', expiresAt: Date.now() + 3600000,
}), { mode: 0o600 })
