import { describe, it, expect } from 'vitest'
import { app } from '../../app'
import { getSettings, getSwarmBudget } from '@/lib/server/store'

// Settings.swarmBudget (AUTONOMY-SPEC R-D2): the key must pass the POST
// allow-list (USER_SETTINGS_KEYS) and be read back through the production
// reader the engine's dispatch pass calls — a 200 alone proves nothing.

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('Settings.swarmBudget', () => {
  it('defaults to the owner decision when unset', async () => {
    expect(await getSwarmBudget()).toEqual({ pace: 'free', ownerReservePct: 10 })
  })

  it('a POST is stored and read back through the engine\'s reader', async () => {
    const res = await app.request('/api/settings', post({ swarmBudget: { pace: 'even', ownerReservePct: 20 } }))
    expect(res.status).toBe(200)
    expect((await getSettings()).swarmBudget).toEqual({ pace: 'even', ownerReservePct: 20 })
    expect(await getSwarmBudget()).toEqual({ pace: 'even', ownerReservePct: 20 })
  })

  it('a partial patch keeps the other field; a nonsense patch is refused', async () => {
    await app.request('/api/settings', post({ swarmBudget: { pace: 'even', ownerReservePct: 20 } }))
    await app.request('/api/settings', post({ swarmBudget: { ownerReservePct: 15 } }))
    expect(await getSwarmBudget()).toEqual({ pace: 'even', ownerReservePct: 15 })
    await app.request('/api/settings', post({ swarmBudget: { pace: 'never', ownerReservePct: 'x' } }))
    await app.request('/api/settings', post({ swarmBudget: { ownerReservePct: 95 } }))
    await app.request('/api/settings', post({ swarmBudget: 'free' }))
    expect(await getSwarmBudget()).toEqual({ pace: 'even', ownerReservePct: 15 })
  })
})
