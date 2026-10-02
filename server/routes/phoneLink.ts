// /api/phone-link — pair / unpair the owner's iPhone with this Mac's president
// desks (src/lib/server/phoneLink.ts, docs/PHONE_LINK.md). Owner-only: the
// president is an owner seat, and the pairing code is a key.
import { Hono, type MiddlewareHandler } from 'hono'
import { hasPhoneLinkAccess, pairPhone, pairingCode, phoneLinkStatus, readPhoneLinkConfig, unpairPhone } from '@/lib/server/phoneLink'
import { hostIsLocal, originIsLocal } from '../loopback'

// The pairing code is a WRITE credential (whoever holds it speaks as the owner),
// so even a GET here must not be readable by a DNS-rebinding page: the app-wide
// guard checks Host/Origin only on state-changing methods — this checks every one.
const ownerOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  const host = c.req.header('host')
  if ((origin !== undefined && !originIsLocal(origin)) || (host !== undefined && !hostIsLocal(host))) {
    return c.json({ error: 'forbidden' }, 403)
  }
  return (await hasPhoneLinkAccess()) ? next() : c.json({ error: 'forbidden' }, 403)
}

const reply = (r: object) => ('error' in r ? Response.json(r, { status: 409 }) : Response.json(r))

export const phoneLinkRoutes = new Hono()
  .use('/api/phone-link', ownerOnly)
  .use('/api/phone-link/*', ownerOnly)
  .get('/api/phone-link', async (c) => c.json(await phoneLinkStatus()))
  // New keys: the previously paired phone stops working and its relay room is erased.
  .post('/api/phone-link/pair', async () => reply(await pairPhone()))
  // The current code again (to set up the same phone a second time). POST: it is a key.
  .post('/api/phone-link/code', async (c) => {
    const cfg = await readPhoneLinkConfig()
    return cfg ? c.json({ code: pairingCode(cfg) }) : c.json({ error: 'not paired' }, 404)
  })
  .post('/api/phone-link/unpair', async () => reply(await unpairPhone()))
