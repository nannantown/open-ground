import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import * as atomic from './atomicWrite'
import { openGroundHome } from './paths'
import { acceptConversationReceipt, cancelPresidentInputs, claimConversationReceipt, finishConversationReceipt, readConversationContext, readConversationReceipt, rotateConversationContext } from './conversationReceipts'

const h = vi.hoisted(() => ({ owner: 'owner-a', occupied: false, handleOccupied: false, sessionOccupied: false, ownerCheck: vi.fn() }))
vi.mock('./runtimeOwner', () => ({ runtimeOwnerKey: async (expected?: string) => {
  await h.ownerCheck()
  if (expected && expected !== h.owner) throw new Error('owner changed')
  return h.owner
} }))
vi.mock('./liveDesks', () => ({ isAgentConversationOccupied: () => h.occupied || h.sessionOccupied, isRecordedRuntimeHandleOccupied: () => h.occupied || h.handleOccupied }))
const scope = 'project-a', path = '/fixture/project'
const execution = { runtime: 'sdk' as const, handleId: 'sdk-one', sessionId: 'chatgpt-one' }
const input = (id: string, kind = 'president-input', inputScope = scope) => acceptConversationReceipt(inputScope, id, { kind, path, text: `request ${id}` })
const request = async (messageIds = ['one'], overrides: Record<string, unknown> = {}) => ({ scope, path, operationId: 'cancel-once', ...await readConversationContext(scope), messageIds, note: 'Completed elsewhere; abandon this request.', expectedOwnerKey: 'owner-a', ...overrides })
const receipt = (id: string) => readConversationReceipt(scope, id)
beforeEach(async () => { h.owner = 'owner-a'; h.occupied = false; h.handleOccupied = false; h.sessionOccupied = false; h.ownerCheck.mockReset(); await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true }) })
afterEach(() => vi.restoreAllMocks())

describe('owner cancellation only revokes selected president intent', () => {
  it('atomically cancels queued and unoccupied uncertain inputs, preserving effects and unrelated work', async () => {
    await input('one'); await input('two'); await input('keep'); await input('tool', 'runtime-tool')
    await claimConversationReceipt(scope, 'tool', execution)
    await finishConversationReceipt(scope, 'tool', 'uncertain', { error: 'Independent effect still requires inspection.' })
    await claimConversationReceipt(scope, 'two', execution)
    await finishConversationReceipt(scope, 'two', 'uncertain', { error: 'effect may have happened', heard: true })
    const file = join(openGroundHome(), 'runtime', 'receipts.json'), saved = JSON.parse(await readFile(file, 'utf8'))
    Object.values(saved.receipts).forEach(value => { const entry = value as { id: string; error?: string }; if (entry.id === 'two') entry.error = 'Original interruption evidence.' })
    await writeFile(file, JSON.stringify(saved))
    const before = await receipt('two')
    const result = await cancelPresidentInputs(await request(['one', 'two']))
    expect(result.receipts.map(r => [r.id, r.state])).toEqual([['one', 'cancelled'], ['two', 'cancelled']])
    expect(await receipt('two')).toMatchObject({ body: before!.body, error: before!.error, execution, result: { cancelledByOwner: true, previousState: 'uncertain', previousResult: before!.result, automaticReplay: false, effectsRolledBack: false } })
    expect((await receipt('keep'))?.state).toBe('queued'); expect((await receipt('tool'))?.state).toBe('uncertain')
    expect(await claimConversationReceipt(scope, 'one')).toBe(false)
    expect((await finishConversationReceipt(scope, 'two', 'delivered', { late: true }))?.state).toBe('cancelled')
    expect(JSON.stringify(result)).not.toContain('request two'); expect(result.receipts[1]).not.toHaveProperty('execution')
  })
  it('replays the same operation without touching a newer input, and rejects changed bodies', async () => {
    await input('one'); const body = await request()
    const first = await cancelPresidentInputs(body)
    expect(await cancelPresidentInputs(body)).toEqual(first)
    await rotateConversationContext(scope, await readConversationContext(scope))
    await input('newer')
    expect(await cancelPresidentInputs(body)).toEqual(first)
    await expect(cancelPresidentInputs({ ...body, messageIds: ['newer'] })).rejects.toThrow()
    expect((await receipt('newer'))?.state).toBe('queued')
  })
  it.each(['missing', 'wrong-kind', 'wrong-scope', 'executing', 'occupied', 'old-context'])(
    'validates the entire batch before changing anything: %s', async mode => {
      await input('one')
      if (mode === 'wrong-kind') await input('bad', 'runtime-tool')
      else if (mode === 'wrong-scope') await input('bad', 'president-input', 'other-project')
      else if (mode !== 'missing') await input('bad')
      if (mode === 'executing' || mode === 'occupied') {
        await claimConversationReceipt(scope, 'bad', execution)
        if (mode === 'occupied') { await finishConversationReceipt(scope, 'bad', 'uncertain'); h.occupied = true }
      }
      const body = await request(['one', 'bad'])
      if (mode === 'old-context') await rotateConversationContext(scope, await readConversationContext(scope))
      const before = await readFile(join(openGroundHome(), 'runtime', 'receipts.json'), 'utf8')
      await expect(cancelPresidentInputs(body)).rejects.toThrow()
      expect(await readFile(join(openGroundHome(), 'runtime', 'receipts.json'), 'utf8')).toBe(before)
    },
  )
  it('serializes cancellation against a real execution claim in both orders', async () => {
    for (const first of ['cancel', 'claim'] as const) {
      const id = `race-${first}`; await input(id); const body = await request([id], { operationId: `cancel-${first}` })
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const write = atomic.atomicWriteJson
      const spy = vi.spyOn(atomic, 'atomicWriteJson').mockImplementationOnce(async (...args) => { await held; return write(...args) })
      const firstOperation = first === 'cancel' ? cancelPresidentInputs(body) : claimConversationReceipt(scope, id, execution)
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
      const secondOperation = first === 'cancel' ? claimConversationReceipt(scope, id, execution) : cancelPresidentInputs(body)
      // Attach rejection handlers before releasing the writer; neither operation
      // can observe or commit a half-cancelled batch.
      const results = Promise.allSettled([firstOperation, secondOperation])
      release()
      const settled = await results; spy.mockRestore()
      if (first === 'cancel') {
        expect((await receipt(id))?.state).toBe('cancelled')
        expect(settled[0].status).toBe('fulfilled'); expect(settled[1]).toMatchObject({ status: 'fulfilled', value: false })
      } else {
        expect((await receipt(id))?.state).toBe('executing')
        expect(settled[0]).toMatchObject({ status: 'fulfilled', value: true }); expect(settled[1].status).toBe('rejected')
      }
    }
  })
  it.each(['handle', 'conversation'])('refuses uncertainty while its recorded %s is still occupied', async occupied => {
    await input('one'); await claimConversationReceipt(scope, 'one', execution)
    await finishConversationReceipt(scope, 'one', 'uncertain')
    h.handleOccupied = occupied === 'handle'; h.sessionOccupied = occupied === 'conversation'
    await expect(cancelPresidentInputs(await request())).rejects.toMatchObject({ code: 'input-occupied' })
    expect((await receipt('one'))?.state).toBe('uncertain')
  })
  it('replays an archived cancellation and its archived control without accepting old work again', async () => {
    await input('one'); const body = await request(), first = await cancelPresidentInputs(body)
    const file = join(openGroundHome(), 'runtime', 'receipts.json'), saved = JSON.parse(await readFile(file, 'utf8'))
    const original = Object.values(saved.receipts)[0] as Record<string, unknown>
    for (let i = 0; Object.keys(saved.receipts).length < 3072; i++) {
      const id = `padding-${i}`, key = createHash('sha256').update(JSON.stringify(['owner-a', scope, id])).digest('hex')
      saved.receipts[key] = { ...original, id, state: 'queued', result: undefined }
    }
    await writeFile(file, JSON.stringify(saved))
    expect((await receipt('one'))?.state).toBe('cancelled') // compacts terminal copies first
    const active = JSON.parse(await readFile(file, 'utf8'))
    expect(Object.values(active.receipts).some(value => (value as { id: string }).id === 'one')).toBe(false)
    expect(await cancelPresidentInputs(body)).toEqual(first)
    expect(await claimConversationReceipt(scope, 'one')).toBe(false)
  })
  it('does not acknowledge or partly cancel when the atomic fsync write fails', async () => {
    await input('one'); await input('two'); const body = await request(['one', 'two'])
    const before = await readFile(join(openGroundHome(), 'runtime', 'receipts.json'), 'utf8')
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic cancel fsync failure'))
    await expect(cancelPresidentInputs(body)).rejects.toThrow('cancel fsync failure')
    expect(await readFile(join(openGroundHome(), 'runtime', 'receipts.json'), 'utf8')).toBe(before)
    expect((await receipt('one'))?.state).toBe('queued'); expect((await receipt('two'))?.state).toBe('queued')
    expect((await cancelPresidentInputs(body)).receipts.every(r => r.state === 'cancelled')).toBe(true)
  })
  it('replays a committed cancellation after a failed acknowledgement without running the original input', async () => {
    await input('one'); const body = await request()
    const write = atomic.atomicWriteJson
    vi.spyOn(atomic, 'atomicWriteJson').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('synthetic post-rename interruption') })
    await expect(cancelPresidentInputs(body)).rejects.toThrow('post-rename interruption')
    expect((await receipt('one'))?.state).toBe('cancelled')
    expect(await claimConversationReceipt(scope, 'one')).toBe(false)
    expect((await cancelPresidentInputs(body)).receipts[0]).toMatchObject({ id: 'one', state: 'cancelled' })
  })
  it('revalidates the captured owner inside the writer after an awaited admission', async () => {
    await input('one'); const body = await request()
    h.ownerCheck.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { h.owner = 'owner-b' })
    await expect(cancelPresidentInputs(body)).rejects.toThrow('owner changed')
    h.owner = 'owner-a'; expect((await receipt('one'))?.state).toBe('queued')
  })
})
