import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isSwarmLocalOwnerUnlocked,
  isSwarmOptInAvailable,
  isSwarmOptInEnabled,
  hasSwarmOwnerAccess,
} from './swarmGate'
import { setSettings } from './store'
import { writeSession, clearSession } from './authStore'

// Simulate the host platform for the macOS-only opt-in gate. process.platform
// is a read-only getter, so redefine + restore it around each assertion.
const withPlatform = async (platform: NodeJS.Platform, fn: () => Promise<void>) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    await fn()
  } finally {
    if (orig) Object.defineProperty(process, 'platform', orig)
  }
}

// The swarm gate seam: owner app-login OR the server-local unlock (env /
// hand-edited settings.json). The unlock must resolve from server-local state
// ONLY — these tests pin the exact sources (env string '1', settings key) and
// that nothing-configured stays locked (the shipped default).

const ENV_KEYS = [
  'OPENGROUND_HOME',
  'OPENGROUND_LOCAL_OWNER',
  'OPENGROUND_OWNER_EMAILS',
  'OPENGROUND_TESTER_EMAILS',
] as const
let savedEnv: Record<string, string | undefined> = {}
let home: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-gate-')))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.OPENGROUND_HOME = home
  delete process.env.OPENGROUND_LOCAL_OWNER
  delete process.env.OPENGROUND_OWNER_EMAILS
  delete process.env.OPENGROUND_TESTER_EMAILS
})
afterEach(async () => {
  await clearSession()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    // NEVER unset the home vars: empty means the user's REAL ~/.openground
    // (paths.ts openGroundHome), and vitest reuses workers across files.
    else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
  }
  await rm(home, { recursive: true, force: true })
})

describe('isSwarmLocalOwnerUnlocked', () => {
  it('nothing configured → locked (the shipped default)', async () => {
    expect(await isSwarmLocalOwnerUnlocked()).toBe(false)
  })

  it('env OPENGROUND_LOCAL_OWNER=1 → unlocked', async () => {
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    expect(await isSwarmLocalOwnerUnlocked()).toBe(true)
  })

  it("env accepts ONLY the exact string '1' — 'true'/'0'/blank stay locked", async () => {
    for (const v of ['true', '0', '', ' 1', 'yes']) {
      process.env.OPENGROUND_LOCAL_OWNER = v
      expect(await isSwarmLocalOwnerUnlocked()).toBe(false)
    }
  })

  it('settings.json swarmLocalOwner: true → unlocked', async () => {
    await setSettings({ swarmLocalOwner: true })
    expect(await isSwarmLocalOwnerUnlocked()).toBe(true)
  })

  it('settings.json swarmLocalOwner: false / absent → locked', async () => {
    await setSettings({ swarmLocalOwner: false })
    expect(await isSwarmLocalOwnerUnlocked()).toBe(false)
  })
})

// The PUBLIC macOS opt-in (Settings.swarmOptIn) — the all-users switch. macOS
// only: the deterministic guard is unmeasured on Windows, so a non-macOS opt-in
// never opens the gate.
describe('isSwarmOptInAvailable', () => {
  it('macOS → available; win32 / linux → not available', () => {
    expect(isSwarmOptInAvailable('darwin')).toBe(true)
    expect(isSwarmOptInAvailable('win32')).toBe(false)
    expect(isSwarmOptInAvailable('linux')).toBe(false)
  })
})

describe('isSwarmOptInEnabled', () => {
  it('macOS + setting true → enabled', async () => {
    await setSettings({ swarmOptIn: true })
    await withPlatform('darwin', async () => {
      expect(await isSwarmOptInEnabled()).toBe(true)
    })
  })

  it('⚠ non-macOS + setting true → STILL disabled (the guard is unmeasured there)', async () => {
    await setSettings({ swarmOptIn: true })
    await withPlatform('win32', async () => {
      expect(await isSwarmOptInEnabled()).toBe(false)
    })
  })

  it('macOS + setting absent/false → disabled (the locked default)', async () => {
    await withPlatform('darwin', async () => {
      expect(await isSwarmOptInEnabled()).toBe(false)
      await setSettings({ swarmOptIn: false })
      expect(await isSwarmOptInEnabled()).toBe(false)
    })
  })
})

describe('hasSwarmOwnerAccess', () => {
  it('signed out + no unlock → no access (existing behaviour)', async () => {
    await clearSession()
    expect(await hasSwarmOwnerAccess()).toBe(false)
  })

  it('signed out + macOS opt-in → access (the all-users path)', async () => {
    await clearSession()
    await setSettings({ swarmOptIn: true })
    await withPlatform('darwin', async () => {
      expect(await hasSwarmOwnerAccess()).toBe(true)
    })
  })

  it('⚠ signed out + opt-in but on Windows → NO access (macOS-gated)', async () => {
    await clearSession()
    await setSettings({ swarmOptIn: true })
    await withPlatform('win32', async () => {
      expect(await hasSwarmOwnerAccess()).toBe(false)
    })
  })

  it('signed out + local unlock → access (the login-free path)', async () => {
    await clearSession()
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    expect(await hasSwarmOwnerAccess()).toBe(true)
  })

  it('signed-in owner without any unlock → access (the existing login path is untouched)', async () => {
    process.env.OPENGROUND_OWNER_EMAILS = 'owner@example.com'
    await writeSession({
      user: { id: 'test-user', email: 'owner@example.com', provider: 'google' },
      expiresAt: Date.now() + 3_600_000,
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
    })
    expect(await hasSwarmOwnerAccess()).toBe(true)
  })

  it('signed-in NON-owner (tester) without unlock → no access; with unlock → access', async () => {
    process.env.OPENGROUND_TESTER_EMAILS = 'tester@example.com'
    await writeSession({
      user: { id: 'test-user', email: 'tester@example.com', provider: 'google' },
      expiresAt: Date.now() + 3_600_000,
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
    })
    expect(await hasSwarmOwnerAccess()).toBe(false)
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    expect(await hasSwarmOwnerAccess()).toBe(true)
  })
})
