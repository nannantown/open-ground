// Phone link at BOOT (phoneLink.ts startPhoneLink → connect → 'open'). Real
// store, isolated HOME (setup-home.ts), a local relay that records dial-outs and
// frames: the observable is "the Mac dialled out / told the relay X", not "a
// function was called".
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const h = vi.hoisted(() => ({ owner: true }))
vi.mock('./swarmGate', () => ({ isSwarmLocalOwnerUnlocked: async () => h.owner }))
vi.mock('./roles', () => ({ getCustomTabRole: async () => h.owner ? 'owner' : 'none' }))

import { startPhoneLink, stopPhoneLink } from './phoneLink'
import { setSettings } from './store'
import { openGroundHome } from './paths'

let server: Server | undefined
afterEach(() => {
  stopPhoneLink()
  server?.close()
  delete process.env.OPENGROUND_PHONE_LINK
  h.owner = true
})

/** A relay on loopback: counts dial-outs and keeps every frame the Mac sends. */
const recordingRelay = async () => {
  const seen = { upgrades: 0, frames: [] as { type?: string }[] }
  const wss = new WebSocketServer({ noServer: true })
  server = createServer((_q, r) => r.end())
  server.on('upgrade', (req, sock, head) => {
    seen.upgrades++
    wss.handleUpgrade(req, sock, head, (ws) => ws.on('message', (d) => void seen.frames.push(JSON.parse(String(d)))))
  })
  server.on('close', () => wss.close())
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  writeFileSync(
    join(openGroundHome(), 'phone-link.json'),
    JSON.stringify({ v: 1, relayUrl: `http://127.0.0.1:${port}`, macKey: 'm'.repeat(43), phoneKey: 'p'.repeat(43) }),
  )
  process.env.OPENGROUND_PHONE_LINK = '1'
  return seen
}

/** server/index.ts order: nothing has read settings yet, so the work-mode
 *  mirror is still unset when the link starts. */
const boot = async (lockdownMode: boolean) => {
  await setSettings({ lockdownMode })
  ;(globalThis as { __openground_lockdown?: unknown }).__openground_lockdown = undefined
  expect(await startPhoneLink()).toBe(true)
}
const settle = () => new Promise((r) => setTimeout(r, 500))

describe('startPhoneLink at boot', () => {
  it('with work mode ON in settings, never dials the relay', async () => {
    const seen = await recordingRelay()
    await boot(true)
    await settle()
    expect(seen.upgrades).toBe(0)
  })

  it('with work mode OFF, dials it and sends the project list to the owner', async () => {
    const seen = await recordingRelay()
    await boot(false)
    await expect.poll(() => seen.frames.some((f) => f.type === 'projects'), { timeout: 5000 }).toBe(true)
  })

  it('a Mac that is not the owner dials but tells the relay nothing', async () => {
    h.owner = false
    const seen = await recordingRelay()
    await boot(false)
    await expect.poll(() => seen.upgrades, { timeout: 5000 }).toBeGreaterThan(0)
    await settle()
    expect(seen.frames).toEqual([])
  })
})
