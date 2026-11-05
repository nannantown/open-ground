import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
const h = vi.hoisted(() => ({ owner: true, user: 'synthetic-owner-a' }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => h.owner }))
vi.mock('./authStore', () => ({ readSession: async () => ({ user: { id: h.user } }) }))
import { trackSwarmRuntimeLaunch } from './swarmRuntimeAdmission'
import { currentRuntimeOwnerKey, withRuntimeOwner } from './runtimeOwner'
import { spawnSdkSession, terminateSdkSession, getSdkSession, type SdkQueryParams } from './sdkSession'

const ids: string[] = []
afterEach(async () => {
  for (const id of ids.splice(0)) { terminateSdkSession(id); await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true)) }
  h.owner = true; h.user = 'synthetic-owner-a'
})
const spawn = () => {
  let captured!: SdkQueryParams, stop = () => {}
  const stopped = new Promise<void>(resolve => { stop = resolve })
  const session = spawnSdkSession({ cwd: '/synthetic/project', role: 'worker', options: {}, initialPrompt: 'approved goal',
    queryFn: (params) => { captured = params; return { async *[Symbol.asyncIterator]() { await stopped; yield* [] }, interrupt: async () => { stop() } } } })
  ids.push(session.id)
  return { session, params: captured }
}
describe('swarm launch owner admission', () => {
  it('pins an admitted owner across awaited launch setup and refuses logout before the first provider input', async () => {
    const expected = createHash('sha256').update(h.user).digest('hex')
    const actor = await trackSwarmRuntimeLaunch(undefined, async () => { await Promise.resolve(); return spawn() })
    expect(actor.params.options.runtimeOwnerKey).toBe(expected)
    expect(currentRuntimeOwnerKey()).toBeUndefined()
    h.owner = false
    await expect(actor.params.prompt[Symbol.asyncIterator]().next()).rejects.toThrow('sign-in')
    expect(getSdkSession(actor.session.id)?.inputs ?? 0).toBe(0)
  })
  it('preserves local/public Claude admission without manufacturing owner capability', async () => {
    h.owner = false
    const actor = await trackSwarmRuntimeLaunch(undefined, async () => spawn())
    expect(actor.params.options).not.toHaveProperty('runtimeOwnerKey')
    expect((await actor.params.prompt[Symbol.asyncIterator]().next()).done).toBe(false)
  })
  it('cannot substitute a different owner in explicit SDK metadata', () => {
    expect(() => withRuntimeOwner('admitted-owner', () => spawnSdkSession({ cwd: '/synthetic/project', options: { runtimeOwnerKey: 'another-owner' },
      queryFn: () => ({ async *[Symbol.asyncIterator]() {} }) }))).toThrow('different admitted owner')
  })
})
