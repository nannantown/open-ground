import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeOwnerKey, runtimeRequestOwnerKey } from './runtimeOwner'

const h = vi.hoisted(() => ({ roleOwner: true, userId: 'synthetic-owner-a', read: vi.fn() }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => h.roleOwner }))
vi.mock('./authStore', () => ({ readSession: async () => { h.read(); return h.userId ? { user: { id: h.userId } } : null } }))
beforeEach(() => { h.roleOwner = true; h.userId = 'synthetic-owner-a'; h.read.mockClear() })
afterEach(() => vi.unstubAllEnvs())

describe('immutable runtime owner identity', () => {
  it('returns a stable hash of the authenticated app identity and rejects another owner expectation', async () => {
    const expected = createHash('sha256').update(h.userId).digest('hex')
    expect(await runtimeOwnerKey()).toBe(expected)
    expect(await runtimeOwnerKey(expected)).toBe(expected)
    expect(await runtimeRequestOwnerKey(h.userId)).toBe(expected)
    await expect(runtimeOwnerKey('b'.repeat(64))).rejects.toThrow('account changed')
    await expect(runtimeRequestOwnerKey('synthetic-owner-b')).rejects.toThrow('account changed')
  })
  it('revokes the old identity after account replacement or sign-out', async () => {
    const before = await runtimeOwnerKey()
    h.userId = 'synthetic-owner-b'
    await expect(runtimeOwnerKey(before)).rejects.toThrow('account changed')
    h.userId = ''
    await expect(runtimeOwnerKey()).rejects.toThrow('sign-in')
  })
  it('does not accept local unlock or API-key environment as proof of an owner account', async () => {
    vi.stubEnv('OPENGROUND_LOCAL_OWNER', '1')
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-never-used')
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-never-used')
    h.roleOwner = false
    await expect(runtimeOwnerKey()).rejects.toThrow('sign-in')
    expect(h.read).not.toHaveBeenCalled()
  })
})
