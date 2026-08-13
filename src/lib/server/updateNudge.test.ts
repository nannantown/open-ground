import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { requestUpdateCheck, UPDATE_CHECK_MESSAGE } from './updateNudge'

// The release-time bell: POST /api/update/check-now → process.send → electron
// main runs an update check now instead of at the next periodic tick.
//
// ⚠ vitest's fork pool ITSELF talks to its parent over process.send, so these
// tests swap it synchronously and restore in afterEach — never delete it across
// an await, or the pool loses its reporting channel.

type Send = NonNullable<typeof process.send>
const realSend = process.send

afterEach(() => {
  if (realSend) process.send = realSend
  else delete (process as { send?: Send }).send
})

describe('requestUpdateCheck', () => {
  it('delivers exactly one message with the exact literal main.js matches on', () => {
    const sent: unknown[] = []
    process.send = ((msg: unknown) => {
      sent.push(msg)
      return true
    }) as Send
    expect(requestUpdateCheck()).toEqual({ queued: true, reason: 'sent' })
    // The shape is the contract: onServerMessage switches on msg.type alone.
    expect(sent).toEqual([{ type: UPDATE_CHECK_MESSAGE }])
  })

  it('with no Electron parent it reports so instead of pretending', () => {
    // dev tsx / bare node — the exact honesty the release runbook reads back.
    delete (process as { send?: Send }).send
    expect(requestUpdateCheck()).toEqual({ queued: false, reason: 'no-electron-parent' })
  })

  it('a throwing channel is a report, not a crash', () => {
    process.send = (() => {
      throw new Error('EPIPE')
    }) as Send
    expect(requestUpdateCheck()).toEqual({ queued: false, reason: 'send-failed' })
  })
})

// ─── The two files that cannot import this one ──────────────────────────────
// electron/main.js is plain JS Electron loads directly and server/routes are
// wired by hand, so the contract is pinned the screenSrcdocMirror way: not
// "does the string exist somewhere" but "is it USED at the seam" — main must
// COMPARE the literal in its message handler and ARM the closure the handler
// rings; the route must CALL the sender. (A bare includes() certified a broken
// :lang(ja) fix once — same repo, 2026-08-04. Never again.)

const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')

describe('the seam is wired on both far sides', () => {
  it('electron/main.js listens for this exact literal and rings the bell', () => {
    const main = src('../../../electron/main.js')
    expect(main).toContain(`const UPDATE_CHECK_MESSAGE = '${UPDATE_CHECK_MESSAGE}'`)
    expect(main, 'the message handler compares it').toMatch(
      /msg\.type === UPDATE_CHECK_MESSAGE/,
    )
    expect(main, 'the handler actually rings').toMatch(/nudgeUpdateCheck\(\)/)
    expect(main, 'the updater arms the bell').toMatch(
      /nudgeUpdateCheck = \(\) => maybeCheck\('nudge'\)/,
    )
    expect(main, 'the ring is rate-limited').toMatch(/shouldNudgeCheck\(/)
  })

  it('the route exists and calls the sender', () => {
    const misc = src('../../../server/routes/misc.ts')
    expect(misc).toMatch(/\.post\('\/api\/update\/check-now'[\s\S]{0,80}?requestUpdateCheck\(\)/)
  })
})
