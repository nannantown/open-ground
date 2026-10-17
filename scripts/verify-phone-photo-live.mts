// Real-claude check of a photo sent from the iPhone to the assistant
// (docs/PHONE_LINK.md "Photos"; CLAUDE.md 検証の掟 3).
//
//   E2E=<base64url 32 bytes> npx tsx scripts/verify-phone-photo-live.mts <frames file>...
//
// Each frames file holds the wire frames the iPhone app sends for ONE photo —
// its `photo-part`s then the `say`, one JSON per line, sealed with E2E — made
// by the app's own PhoneLinkCore (the harness in the report: `PhotoHarness
// frames`). Files given together are sent back to back, the says not waiting
// for each other's answers (the owner sending several photos quickly).
// Every frame goes through the Mac's real `handleRelayFrame` and the REAL
// assistant (signed-in claude CLI, a few short turns of the subscription), with
// OPEN GROUND's data in a throwaway OPENGROUND_HOME (the real ~/.openground is
// never touched). Prints per photo: frame count and largest frame (the relay
// takes 16 384), whether the kept photo is byte-identical to what was cut, the
// acks, and the assistant's answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

for (const k of Object.keys(process.env)) if ((k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') && !['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
const home = mkdtempSync(join(tmpdir(), 'og-phone-photo-live-'))
process.env.OPENGROUND_HOME = home
writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'ja', swarmLocalOwner: true }))

const E2E = process.env.E2E ?? ''
const files = process.argv.slice(2)
const { __testLinkState, handleRelayFrame } = await import('../src/lib/server/phoneLink')
const { e2eKeyOf, open } = await import('../src/lib/server/phoneLinkSeal')
const { readAssistantLog, assistantPhotoPath } = await import('../src/lib/server/assistantMemory')
const { closeAssistantSession } = await import('../src/lib/server/assistantSession')
const key = e2eKeyOf(E2E)
if (!key || !files.length) throw new Error('E2E=<key> and at least one frames file')

const wire: string[] = []
const st = __testLinkState(
  { v: 2, relayUrl: 'https://relay.test', macKey: 'm'.repeat(43), phoneKey: 'p'.repeat(43), e2eKey: E2E, assistantDirect: true },
  { readyState: 1, send: (s: string) => void wire.push(s) } as never,
)
const RELAY_PHONE_FRAME_MAX = 16 * 1024
let ok = true
const says: Promise<void>[] = []
const cut: Record<string, Buffer> = {}
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const largest = Math.max(...lines.map((l) => l.length))
  const frames = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  const say = frames.at(-1)!
  // What the phone cut (opened with the phone's direction, as only the Mac can).
  const parts = frames.slice(0, -1).map((p) => open(key, 'p2m', p.box) as { part: number; data: string })
  cut[String(say.id)] = Buffer.concat(parts.sort((a, b) => a.part - b.part).map((p) => Buffer.from(p.data, 'base64')))
  console.log(`${f}: ${frames.length} frames, largest ${largest} chars (relay cap ${RELAY_PHONE_FRAME_MAX}), photo ${cut[String(say.id)].length} bytes`)
  if (largest > RELAY_PHONE_FRAME_MAX) ok = false
  for (const p of frames.slice(0, -1)) await handleRelayFrame(st, p)
  says.push(handleRelayFrame(st, say))
}
await Promise.all(says)

const said = wire.map((s) => JSON.parse(s)).map((f) => (f.box ? open(key, 'm2p', f.box) : f) as Record<string, unknown>)
for (const f of said) if (f.type === 'ack') console.log(`ack ${f.id} ${f.state}${f.reason ? ' ' + f.reason : ''}${f.detail ? ' — ' + f.detail : ''}`)
const log = await readAssistantLog()
for (const e of log) {
  if (e.who === 'owner') {
    const kept = e.photo ? readFileSync(assistantPhotoPath(e.photo)!) : null
    const same = kept !== null && e.clientId !== undefined && kept.equals(cut[e.clientId] ?? Buffer.alloc(0))
    console.log(`\nowner (${e.clientId}): ${JSON.stringify(e.text)} photo=${e.photo ?? '-'} byte-identical=${same}`)
    if (!same) ok = false
  } else console.log(`assistant: ${e.text}`)
}
if (log.filter((e) => e.who === 'assistant').length !== files.length) ok = false
closeAssistantSession()
rmSync(home, { recursive: true, force: true })
console.log(ok ? '\nOK' : '\nFAILED')
process.exit(ok ? 0 : 1)
