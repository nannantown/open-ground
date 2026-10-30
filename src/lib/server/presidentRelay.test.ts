// presidentRelay — the assistant passes one message to a president and brings
// the answer back. Observable results only: the line typed into the window, the
// words handed back, and why nothing came.
import { describe, it, expect } from 'vitest'
import { appendFileSync } from 'fs'
import { appendFile, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { relayToPresident, presidentWordsFit, type PresidentRelayDeps, type PresidentReply } from './presidentRelay'
import { ASSISTANT_RELAY_PREFIX, SUPPLY_OWNER_SAY_MAX, assistantRelayLine, supplyNoticeLine } from './supplyNotice'

const said = (text: string, at: number, tool = false) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', name: 'Bash' }] : [])] } }) + '\n'
/** A line typed into the window, as claude records it. */
const typedIn = (text: string, at: number) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { content: text } }) + '\n'

/** A clock that moves only when the relay sleeps; `onSleep` runs at each look. */
const rig = async (over: Partial<PresidentRelayDeps> = {}, onSleep: (t: number) => Promise<void> | void = () => {}) => {
  const file = join(await mkdtemp(join(tmpdir(), 'og-pres-')), 's.jsonl')
  await writeFile(file, said('前の話', 1))
  let t = 1_000_000
  const typed: string[] = []
  const deps: Partial<PresidentRelayDeps> = {
    hasDesk: () => true,
    wake: async () => null,
    // Typing the line puts its echo in the transcript, then it is heard.
    say: async (_p, line, onDone) => {
      typed.push(line)
      appendFileSync(file, typedIn(line, t))
      onDone?.(true)
      return 0
    },
    cancel: () => false,
    transcript: async () => file,
    working: async () => false,
    now: () => t,
    sleep: async (ms) => {
      t += ms
      await onSleep(t)
    },
    waitMs: 60_000,
    pollMs: 1000,
    ...over,
  }
  return { file, typed, deps, at: () => t }
}
const replyOf = () => {
  let got!: (x: PresidentReply) => void
  const done = new Promise<PresidentReply>((res) => (got = res))
  return { done, on: { reply: (x: PresidentReply) => got(x) } }
}

describe('a message reaches the president marked as the assistant’s, and the answer comes back', () => {
  it('types ONE line with the frozen prefix and hands back what the president wrote after it — not what it said before', async () => {
    let file = ''
    const r = await rig({}, async (t) => {
      if (t === 1_002_000) await appendFile(file, said('進み具合は半分です。', t))
    })
    file = r.file
    const reply = replyOf()
    const res = await relayToPresident('/p', '進み具合を教えて', reply.on, r.deps)
    expect(res).toEqual({ ok: true, woke: false, waiting: 0 })
    expect(r.typed).toHaveLength(1)
    expect(r.typed[0].startsWith(`${ASSISTANT_RELAY_PREFIX}進み具合を教えて`)).toBe(true)
    expect(await reply.done).toEqual({ kind: 'answered', text: '進み具合は半分です。' })
  })

  it('waits while the president is still working, and joins everything it wrote', async () => {
    let file = ''
    let busy = true
    const r = await rig({ working: async () => busy }, async (t) => {
      if (t === 1_002_000) await appendFile(file, said('調べます。', t))
      if (t === 1_005_000) await appendFile(file, said('半分できています。', t))
      if (t === 1_006_000) busy = false
    })
    file = r.file
    const reply = replyOf()
    await relayToPresident('/p', '進み具合は?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: '調べます。\n\n半分できています。' })
    expect(r.at()).toBe(1_007_000) // two idle looks after the desk stopped (1_006_000, 1_007_000)
  })

  it('a freshly opened desk whose conversation file appears only later: read from its start, nothing from before the line', async () => {
    let file = ''
    let there = false
    const r = await rig({ transcript: async () => (there ? file : null) }, async (t) => {
      if (t === 1_002_000) {
        await writeFile(file, said('昨日の話', 1) + typedIn(assistantRelayLine('進み具合は?'), t - 500) + said('はい、半分です。', t))
        there = true
      }
    })
    file = r.file
    const reply = replyOf()
    await relayToPresident('/p', '進み具合は?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: 'はい、半分です。' })
  })

  it('only the answer to THIS line: what the president says after the next line typed in (a notice) is left out; an earlier echo of other words is not taken for it', async () => {
    let file = ''
    const r = await rig({}, async (t) => {
      if (t === 1_001_000) await appendFile(file, said('調べますね。', t, true))
      if (t === 1_002_000) await appendFile(file, said('半分です。', t))
      if (t === 1_003_000) await appendFile(file, typedIn(supplyNoticeLine('カードが1枚終わりました'), t) + said('カードが1枚終わりました。', t + 1))
    })
    file = r.file
    await appendFile(file, typedIn(assistantRelayLine('別の伝言'), 999_000) + said('別の返事', 999_500))
    const reply = replyOf()
    await relayToPresident('/p', '進み具合は?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: '調べますね。\n\n半分です。' })
  })

  it('a "let me look" before a tool is not the end of the answer, even with the desk read idle', async () => {
    let file = ''
    const r = await rig({}, async (t) => {
      if (t === 1_001_000) await appendFile(file, said('確認します。', t, true))
      if (t === 1_008_000) await appendFile(file, said('明日できます。', t))
    })
    file = r.file
    const reply = replyOf()
    await relayToPresident('/p', 'いつできる?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: '確認します。\n\n明日できます。' })
  })

  it('a closed window is opened first; one that cannot be opened is reported and nothing is typed', async () => {
    const opened = await rig({ hasDesk: () => false })
    expect(await relayToPresident('/p', 'こんにちは', replyOf().on, opened.deps)).toMatchObject({ ok: true, woke: true })
    const failed = await rig({ hasDesk: () => false, wake: async () => 'claude-unavailable' })
    expect(await relayToPresident('/p', 'こんにちは', replyOf().on, failed.deps)).toEqual({ ok: false, error: 'claude-unavailable' })
    expect(failed.typed).toEqual([])
  })

  it('nothing written within the wait → no-reply; never typed in (busy desk) → not-landed', async () => {
    const silent = await rig()
    const a = replyOf()
    await relayToPresident('/p', 'もしもし', a.on, silent.deps)
    expect(await a.done).toEqual({ kind: 'no-reply' })

    let late: ((heard: boolean) => void) | undefined
    const cancelled: unknown[] = []
    const held = await rig({ say: async (_p, _l, onDone) => ((late = onDone), 1), cancel: (_p, fn) => (cancelled.push(fn), true) })
    const b = replyOf()
    const landed: string[] = []
    expect(await relayToPresident('/p', 'もしもし', { ...b.on, landed: () => landed.push('late') }, held.deps)).toEqual({ ok: true, woke: false, waiting: 1 })
    expect(await b.done).toEqual({ kind: 'not-landed' })
    // Taken back from the window's queue, so it never lands days later…
    expect(cancelled).toEqual([late])
    // …and a landing that slips through anyway tells nothing more.
    late?.(true)
    expect(landed).toEqual([])
  })

  it('landed at once: others queued behind it do not make it "waiting"', async () => {
    const r = await rig()
    r.deps.say = async (_p, _l, onDone) => (onDone?.(true), 2)
    expect(await relayToPresident('/p', 'もしもし', replyOf().on, r.deps)).toEqual({ ok: true, woke: false, waiting: 0 })
  })

  it('a message too long to be typed in unfolded is refused before anything happens', async () => {
    const long = 'あ'.repeat(SUPPLY_OWNER_SAY_MAX)
    expect(presidentWordsFit(long)).toBe(false)
    const r = await rig()
    expect(await relayToPresident('/p', long, replyOf().on, r.deps)).toEqual({ ok: false, error: 'too-long' })
    expect(r.typed).toEqual([])
  })
})

describe('no mix-ups, no early "no reply" (integration review 2026-10-30)', () => {
  it('a window made anew while waiting: its resume report / greeting is not taken for the answer', async () => {
    const fresh = join(await mkdtemp(join(tmpdir(), 'og-pres-')), 'new.jsonl')
    let swapped = false
    const r = await rig({ transcript: async () => (swapped ? fresh : r.file) }, async (t) => {
      if (t === 1_002_000) {
        await writeFile(fresh, said('おはようございます、再開しました。', t))
        swapped = true
      }
    })
    const reply = replyOf()
    await relayToPresident('/p', '進み具合は?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'no-reply' })
  })

  it('a slash command typed into the window (/compact, /model) ends the answer: what follows it is left out', async () => {
    let file = ''
    const r = await rig({}, async (t) => {
      if (t === 1_001_000) await appendFile(file, said('半分です。', t, true))
      if (t === 1_002_000) await appendFile(file, typedIn('<command-name>/compact</command-name>', t) + said('要約しました。', t + 1))
    })
    file = r.file
    const reply = replyOf()
    await relayToPresident('/p', '進み具合は?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: '半分です。' })
  })

  it('someone else types in before the president wrote a word: "no reply" at once, not after the whole wait', async () => {
    let file = ''
    const r = await rig({}, async (t) => {
      if (t === 1_002_000) await appendFile(file, typedIn('別件ですが', t))
    })
    file = r.file
    const reply = replyOf()
    await relayToPresident('/p', '進み具合は?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'no-reply' })
    expect(r.at()).toBe(1_002_000)
  })

  it('landing just before the landing wait ran out still leaves the president a full wait to answer', async () => {
    let file = ''
    let late: ((heard: boolean) => void) | undefined
    const r = await rig({ say: async (_p, line, onDone) => ((late = () => (appendFileSync(file, typedIn(line, r.at())), onDone?.(true))), 1) }, async (t) => {
      if (t === 1_059_000) late?.(true)
      if (t === 1_070_000) await appendFile(file, said('明日できます。', t))
    })
    file = r.file
    const reply = replyOf()
    await relayToPresident('/p', 'いつできる?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: '明日できます。' })
  })

  it('two messages that open alike within a minute: the answer to the OTHER one is not taken', async () => {
    const head = 'あ'.repeat(40)
    let file = ''
    const r = await rig({}, async (t) => {
      if (t === 1_002_000) await appendFile(file, said('B の返事', t))
    })
    file = r.file
    await appendFile(file, typedIn(assistantRelayLine(`${head}A`), 990_000) + said('A の返事', 990_500))
    const reply = replyOf()
    await relayToPresident('/p', `${head}B`, reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: 'B の返事' })
  })
})

describe('a background task finishing mid-answer is not someone typing in (rework 2026-10-30)', () => {
  it('a queued task-notification (origin INSIDE the attachment, as a real transcript has it) does not end the answer', async () => {
    // The exact shape measured on a real president transcript.
    const taskDone = (at: number) =>
      JSON.stringify({
        type: 'attachment',
        origin: null,
        timestamp: new Date(at).toISOString(),
        attachment: {
          type: 'queued_command',
          origin: { kind: 'task-notification', producer: 'session-task' },
          commandMode: 'task-notification',
          prompt: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>',
        },
      }) + '\n'
    let file = ''
    const r = await rig({}, async (t) => {
      if (t === 1_001_000) await appendFile(file, said('調べます。', t, true))
      if (t === 1_002_000) await appendFile(file, taskDone(t))
      if (t === 1_003_000) await appendFile(file, said('半分できています。', t))
    })
    file = r.file
    const reply = replyOf()
    await relayToPresident('/p', '進み具合は?', reply.on, r.deps)
    expect(await reply.done).toEqual({ kind: 'answered', text: '調べます。\n\n半分できています。' })
  })
})
