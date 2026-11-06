import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSdkPublicConversation, getSdkSession, pushSdkInput, spawnSdkSession, terminateSdkSession } from './sdkSession'
import type { SdkEvent } from './sdkEvents'
import { getSupplyPublicConversation } from './swarmSupplyRuntime'
vi.mock('./runtimeOwner', async original => ({ ...await original<typeof import('./runtimeOwner')>(), runtimeOwnerKey: async () => 'fixture-owner' }))
const ids: string[] = []
afterEach(async () => { for (const id of ids.splice(0)) { terminateSdkSession(id); await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true)) } })
const start = (extra: Partial<Parameters<typeof spawnSdkSession>[0]> = {}) => {
  const session = spawnSdkSession({ cwd: '/fixture/project', role: 'supply', options: { runtimeOwnerKey: 'fixture-owner' },
    handoffTranscript: [{ kind: 'input', text: 'Earlier owner request.' }, { kind: 'text', text: 'Earlier public answer.' }],
    distillMessage: value => [value as SdkEvent], queryFn: params => ({ interrupt: async () => {}, async *[Symbol.asyncIterator]() {
      for await (const _input of params.prompt) {
        yield { kind: 'thinking', active: true, text: 'private reasoning must not escape' }
        yield { kind: 'tool_result', ok: true, head: 'private tool result must not escape' }
        yield { kind: 'text', text: 'New public answer.' }
        await params.onTurnSettled?.()
      }
    } }), ...extra })
  ids.push(session.id); return session.id
}
const expected = { ownerKey: 'fixture-owner', cwd: '/fixture/project', role: 'supply' as const }
describe('bounded public president conversation projection', () => {
  it('restores seed words independently of the frame ring and returns detached public lines', () => {
    const id = start(), snapshot = getSdkPublicConversation(id, expected)!
    expect(snapshot).toMatchObject({ lines: [{ kind: 'input', text: 'Earlier owner request.' }, { kind: 'text', text: 'Earlier public answer.' }], overflow: false, seq: 0 })
    snapshot.lines[0].text = 'renderer mutation'
    expect(getSdkPublicConversation(id, expected)?.lines[0].text).toBe('Earlier owner request.')
  })
  it('includes new owner words and public answers but never tool output or reasoning', async () => {
    const id = start(), before = getSdkPublicConversation(id, expected)!
    expect(pushSdkInput(id, 'New owner request.')).toBe(true)
    await vi.waitFor(() => expect(getSdkPublicConversation(id, expected)?.lines).toHaveLength(4))
    const result = getSdkPublicConversation(id, expected)!
    expect(result.lines).toEqual([...before.lines, { kind: 'input', text: 'New owner request.' }, { kind: 'text', text: 'New public answer.' }])
    expect(result.revision).not.toBe(before.revision)
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it.each([{ ownerKey: 'other-owner' }, { cwd: '/fixture/project-other' }, { role: 'manager' as const }])('rejects the wrong owner, project or role: %j', different => {
    expect(getSdkPublicConversation(start(), { ...expected, ...different })).toBeNull()
  })
  it('does not expose ownerless legacy actors as another signed-in owner', () => {
    expect(getSdkPublicConversation(start({ options: {} }), expected)).toBeNull()
  })
  it('never serves a retired handle as the new live president conversation', async () => {
    const old = start()
    expect(getSupplyPublicConversation(expected.cwd, old, expected.ownerKey)?.lines).toHaveLength(2)
    terminateSdkSession(old)
    const current = start()
    expect(getSupplyPublicConversation(expected.cwd, old, expected.ownerKey)).toBeNull()
    expect(getSupplyPublicConversation(expected.cwd, current, expected.ownerKey)?.lines).toHaveLength(2)
  })
  it('refuses ambiguous live presidents rather than picking one for the history view', () => {
    const first = start(), second = start()
    expect(getSupplyPublicConversation(expected.cwd, first, expected.ownerKey)).toBeNull()
    expect(getSupplyPublicConversation(expected.cwd, second, expected.ownerKey)).toBeNull()
  })
  it('reports the existing capture boundary instead of implying its bounded history is complete', () => {
    const id = start({ handoffTranscript: [{ kind: 'text', text: 'x'.repeat(256 * 1024) }] })
    expect(getSdkPublicConversation(id, expected)).toMatchObject({ lines: [], overflow: true })
  })
})
