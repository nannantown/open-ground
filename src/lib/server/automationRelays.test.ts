import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relayToCommander, type CommanderRelayDeps } from './commanderRelay'
import { queueSupplyNotice, queueSupplyOwnerSay, queueSupplyReply, resetSupplyNoticeState, type SupplyNoticeDeps } from './supplyNotice'

const policy = vi.hoisted(() => ({ allowed: false }))
vi.mock('./automationPolicy', async (original) => ({ ...await original<typeof import('./automationPolicy')>(), automaticOperationAllowed: async () => policy.allowed }))
beforeEach(() => { policy.allowed = false; resetSupplyNoticeState() })
afterEach(() => resetSupplyNoticeState())

const commander = () => {
  let live = false
  const say = vi.fn(() => ({ ok: true }))
  const spawn = vi.fn(async () => { live = true; return { terminalId: '', runtime: 'sdk' as const, sdkSessionId: 'fixture-manager', agentSessionId: 'fixture-agent', resumed: false } })
  const deps: CommanderRelayDeps = {
    preflight: vi.fn(async () => ({ ok: true as const })),
    envPreflight: vi.fn(async () => ({ ok: true, issues: [] })), spawn, say,
    desks: () => live ? [{ runtime: 'sdk', handleId: 'fixture-manager', agentSessionId: 'fixture-agent', cwd: '/fixture/project', startedAt: 0, lastOutputAt: 0, stopping: false }] : [],
  }
  return { deps, spawn, say }
}
const president = () => {
  const sendDirect = vi.fn(() => true)
  const deps: Partial<SupplyNoticeDeps> = { desks: () => [{ id: 'fixture-president', cwd: '/fixture/project', runtime: 'sdk' }], sendDirect, now: () => 1000 }
  return { deps, sendDirect }
}

describe('automatic relay admission is distinct from explicit owner conversation', () => {
  it('does not let an untyped automatic commander message wake or address an outside manager', async () => {
    const f = commander()
    expect(await relayToCommander('/fixture/project', 'automatic instruction', {}, f.deps)).toMatchObject({ ok: false, body: { automationBlocked: true, delivered: false } })
    expect(f.deps.preflight).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.say).not.toHaveBeenCalled()
  })

  it('keeps an explicit owner conversation usable outside, carrying owner origin into its wake', async () => {
    const f = commander()
    expect(await relayToCommander('/fixture/project', 'owner instruction', { cause: 'owner' }, f.deps)).toMatchObject({ ok: true, delivered: true, woke: true })
    expect(f.spawn).toHaveBeenCalledWith({ projectPath: '/fixture/project', cause: 'owner' })
    expect(f.say).toHaveBeenCalledOnce()
  })

  it('does not wake a commander after membership changes during preflight', async () => {
    policy.allowed = true
    const f = commander()
    f.deps.preflight = async () => { policy.allowed = false; return { ok: true } }
    expect(await relayToCommander('/fixture/project', 'automatic instruction', {}, f.deps)).toMatchObject({ ok: false, body: { automationBlocked: true } })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.say).not.toHaveBeenCalled()
  })

  it('holds unsolicited president news outside without losing the queued notice', async () => {
    const f = president()
    await queueSupplyNotice('/fixture/project', 'An automatic update.', f.deps)
    expect(f.sendDirect).not.toHaveBeenCalled()
    policy.allowed = true
    const { flushSupplyNotices } = await import('./supplyNotice')
    await flushSupplyNotices(f.deps)
    expect(f.sendDirect).toHaveBeenCalledOnce()
  })

  it('still delivers owner words and the reply to an already accepted question outside', async () => {
    const f = president(), heard = vi.fn()
    await queueSupplyOwnerSay('/fixture/project', 'Owner words.', heard, f.deps)
    await queueSupplyReply('/fixture/project', 'The answer to the accepted question.', f.deps)
    expect(f.sendDirect).toHaveBeenCalledTimes(2)
    expect(f.sendDirect.mock.calls[0]).toEqual(['fixture-president', 'Owner words.'])
    expect(heard).toHaveBeenCalledWith(true)
  })
})
