import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestEngineSelfUpdate, SELF_UPDATE_MESSAGE } from './selfUpdateSignal'

// Tests for the server→Electron self-update seam (selfUpdateSignal.ts). Both
// gates must FAIL SAFE — a no-op return, never a throw — so wiring this into the
// integration path can't disturb a merge:
//   1. process.send must exist (we are the forked engine with an IPC channel).
//   2. The integrated project must BE this engine's own source repo
//      (OPENGROUND_SOURCE_ROOT), canonical-path matched — a swarm merge on any
//      OTHER project must never rebuild/restart OPEN GROUND.

type Send = NonNullable<typeof process.send>

const realProcess = process as NodeJS.Process & { send?: Send }
let savedSend: Send | undefined
let savedSourceRoot: string | undefined
let tmp: string

beforeEach(() => {
  savedSend = realProcess.send
  savedSourceRoot = process.env.OPENGROUND_SOURCE_ROOT
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'og-selfupd-')))
})

afterEach(() => {
  realProcess.send = savedSend
  if (savedSourceRoot === undefined) delete process.env.OPENGROUND_SOURCE_ROOT
  else process.env.OPENGROUND_SOURCE_ROOT = savedSourceRoot
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('requestEngineSelfUpdate', () => {
  it('no-ops (false) when there is no IPC channel (process.send absent)', () => {
    realProcess.send = undefined
    process.env.OPENGROUND_SOURCE_ROOT = tmp
    expect(requestEngineSelfUpdate(tmp)).toBe(false)
  })

  it('no-ops when OPENGROUND_SOURCE_ROOT is unset (self-update not armed)', () => {
    realProcess.send = vi.fn(() => true) as unknown as Send
    delete process.env.OPENGROUND_SOURCE_ROOT
    expect(requestEngineSelfUpdate(tmp)).toBe(false)
    expect(realProcess.send).not.toHaveBeenCalled()
  })

  it('no-ops for a merge on a DIFFERENT project (path mismatch)', () => {
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'og-other-')))
    try {
      realProcess.send = vi.fn(() => true) as unknown as Send
      process.env.OPENGROUND_SOURCE_ROOT = tmp
      expect(requestEngineSelfUpdate(other)).toBe(false)
      expect(realProcess.send).not.toHaveBeenCalled()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('SENDS the self-update message when the integrated project IS the source repo', () => {
    const send = vi.fn((_msg: unknown) => true)
    realProcess.send = send as unknown as Send
    process.env.OPENGROUND_SOURCE_ROOT = tmp
    expect(requestEngineSelfUpdate(tmp)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toEqual({ type: SELF_UPDATE_MESSAGE, projectPath: tmp })
  })

  it('matches on canonical path (trailing separator / spelling differences)', () => {
    const send = vi.fn(() => true)
    realProcess.send = send as unknown as Send
    process.env.OPENGROUND_SOURCE_ROOT = `${tmp}/` // trailing slash spelling
    expect(requestEngineSelfUpdate(tmp)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('no-ops for an empty path', () => {
    realProcess.send = vi.fn(() => true) as unknown as Send
    process.env.OPENGROUND_SOURCE_ROOT = tmp
    expect(requestEngineSelfUpdate('')).toBe(false)
    expect(realProcess.send).not.toHaveBeenCalled()
  })

  it('swallows a send() that throws (never disturbs the merge path)', () => {
    realProcess.send = vi.fn(() => {
      throw new Error('IPC channel closed')
    }) as unknown as Send
    process.env.OPENGROUND_SOURCE_ROOT = tmp
    expect(requestEngineSelfUpdate(tmp)).toBe(false)
  })
})
