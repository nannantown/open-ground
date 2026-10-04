// The assistant's memory on the Mac (assistantMemory.ts + phoneAssistant.ts).
// Owner decision 2026-10-03: the talk is kept N days (default 30) in text
// files, ONE memo of fixed size (default ~4000 characters) carries what matters
// beyond that, and each turn reads only the memo + the recent talk. Asserted on
// what is ON DISK (read back with the production readers) and what the MODEL
// is told. HOME is tmpdir-isolated by setup-home.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readdir, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { openGroundHome } from './paths'
import { setLockdownCache } from './lockdown'
import {
  appendAssistantEntries,
  appendAssistantCall,
  assistantEpoch,
  charCount,
  clearAssistantLog,
  clearAssistantMemory,
  deleteAssistantEntry,
  readAssistantConfig,
  readAssistantLog,
  readAssistantMemory,
  readFolded,
  readIdleTried,
  saveAssistantConfig,
  writeAssistantMemory,
} from './assistantMemory'
import { __resetAssistantMemory, askAssistant, foldIdleAssistantTalk, saveAssistantStyle, type AssistantDeps } from './phoneAssistant'

const DAY = 86_400_000
const noProjects: AssistantDeps['digest'] = async () => ({ text: '(none)', projects: [] })
/** A model stand-in: records each prompt, answers with the next canned JSON. */
const model = (...answers: unknown[]) => {
  const prompts: string[] = []
  const run: AssistantDeps['run'] = async (prompt) => {
    prompts.push(prompt)
    return JSON.stringify(answers.shift() ?? { reply: 'ok' })
  }
  return { prompts, run }
}
const logDir = () => join(openGroundHome(), 'assistant', 'log')

beforeEach(async () => {
  __resetAssistantMemory()
  await clearAssistantLog()
  await clearAssistantMemory()
  await saveAssistantConfig({ logDays: 30, memoryChars: 4000, name: '', look: 'verm' })
  await saveAssistantStyle('')
  setLockdownCache(false)
})

describe('talk older than the kept days is deleted', () => {
  it('a 31-day-old line is gone from disk and from what the assistant reads; 29 days is kept', async () => {
    const now = Date.now()
    await appendAssistantEntries([
      { at: now - 31 * DAY, who: 'owner', text: '三十一日前の話', via: 'phone' },
      { at: now - 29 * DAY, who: 'owner', text: '二十九日前の話', via: 'phone' },
      { at: now - 3_600_000, who: 'owner', text: 'さっきの話', via: 'screen' },
    ])
    expect((await readAssistantLog(now)).map((e) => e.text)).toEqual(['二十九日前の話', 'さっきの話'])
    const files = await readdir(logDir())
    expect(files).toHaveLength(2)
    expect(files).not.toContain(new Date(now - 31 * DAY).toISOString().slice(0, 10) + '.jsonl')
    // ...and the model never sees it either.
    const m = model({ reply: 'うん' })
    await askAssistant('前の話覚えてる?', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('二十九日前の話')
    expect(m.prompts[0]).not.toContain('三十一日前の話')
  })

  it('a shorter setting deletes the older days at once', async () => {
    const now = Date.now()
    await appendAssistantEntries([
      { at: now - 10 * DAY, who: 'owner', text: '十日前', via: 'phone' },
      { at: now - 3_600_000, who: 'owner', text: '今日', via: 'phone' },
    ])
    expect(await saveAssistantConfig({ logDays: 7 })).toMatchObject({ logDays: 7 })
    expect(await readdir(logDir())).toHaveLength(1)
    expect((await readAssistantLog()).map((e) => e.text)).toEqual(['今日'])
  })

  it('refuses days or characters out of range and keeps the old value', async () => {
    expect(await saveAssistantConfig({ logDays: 0 })).toHaveProperty('error')
    expect(await saveAssistantConfig({ memoryChars: 100_000 })).toHaveProperty('error')
    expect(await saveAssistantConfig({ logDays: '30' })).toHaveProperty('error')
    expect(await readAssistantConfig()).toEqual({ logDays: 30, memoryChars: 4000, name: '', look: 'verm' })
  })
})

describe('the name and look the owner gives the assistant', () => {
  it('are kept, read back, and leave the numbers alone', async () => {
    expect(await saveAssistantConfig({ name: '  ノノ ', look: 'moss' })).toMatchObject({ name: 'ノノ', look: 'moss', logDays: 30 })
    expect(await readAssistantConfig()).toEqual({ logDays: 30, memoryChars: 4000, name: 'ノノ', look: 'moss' })
  })

  it('a name is one line: line breaks become spaces, control characters go', async () => {
    expect(await saveAssistantConfig({ name: 'No\nno\u0007' })).toMatchObject({ name: 'No no' })
  })

  it('direction controls and other invisible characters go too', async () => {
    expect(await saveAssistantConfig({ name: 'a\u2066b\u202ec\u00ad \u200b d' })).toMatchObject({ name: 'abc d' })
  })

  it('a quote in the name stays inside the quoted name in the prompt', async () => {
    const m = model({ reply: 'はい' })
    await saveAssistantConfig({ name: 'No"no' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('The owner named you "No\\"no". That is your name.')
  })

  it('refuses a too-long name or an unknown look and keeps the old one', async () => {
    await saveAssistantConfig({ name: 'ノノ', look: 'ochre' })
    expect(await saveAssistantConfig({ name: 'x'.repeat(25) })).toHaveProperty('error')
    expect(await saveAssistantConfig({ look: 'pink' })).toHaveProperty('error')
    expect(await saveAssistantConfig({ name: 3 })).toHaveProperty('error')
    expect(await readAssistantConfig()).toMatchObject({ name: 'ノノ', look: 'ochre' })
  })

  it('the assistant is told its name, and not told one before it has a name', async () => {
    const m = model({ reply: 'はい' }, { reply: 'はい' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    await saveAssistantConfig({ name: 'ノノ' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).not.toContain('named you')
    expect(m.prompts[1]).toContain('The owner named you "ノノ"')
  })
})

describe('the memo never goes over its size', () => {
  it('a memo the model writes too long is not kept: the memo stays, and what it was folding is folded again (nothing lost)', async () => {
    // The reviewer's case: a memo near its 4,000 characters, and the old line about the
    // cat comes back appended at its END, over the limit. A cut would drop
    // exactly that line while marking it folded — gone from memo, prompt and log view.
    const before = 'き'.repeat(3998)
    await writeAssistantMemory(before, 4000)
    await appendAssistantEntries([{ at: Date.now() - 2 * DAY, who: 'owner', text: 'うちの猫はミケ', via: 'phone' }])
    const m = model({ reply: 'ok', memory: before + '\n猫はミケ' }, { reply: 'ok' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toMatch(/Older talk leaving your view[\s\S]*うちの猫はミケ/)
    expect(await readAssistantMemory()).toBe(before)
    await askAssistant('それで', { run: m.run, digest: noProjects })
    expect(m.prompts[1]).toMatch(/Older talk leaving your view[\s\S]*うちの猫はミケ/)
    expect(m.prompts[1]).toContain('REQUIRED')
  })

  it('the model is asked for a memo a tenth under the limit, so a slight overshoot still fits', async () => {
    const m = model({ reply: 'ok' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('at most 4000 characters (aim for 3600')
  })

  it('counts characters as the owner does (an emoji is one) and never splits one', async () => {
    await saveAssistantConfig({ memoryChars: 500 })
    await writeAssistantMemory('😀'.repeat(900), 500)
    const memo = await readAssistantMemory()
    expect(charCount(memo)).toBe(500)
    expect(Array.from(memo).every((c) => c === '😀')).toBe(true)
  })

  it('a smaller size cuts the existing memo at once', async () => {
    await writeAssistantMemory(Array.from({ length: 100 }, (_, i) => `メモ${i}の行です`).join('\n'), 4000)
    expect(charCount(await readAssistantMemory())).toBeGreaterThan(800)
    await saveAssistantConfig({ memoryChars: 500 })
    expect(charCount(await readAssistantMemory())).toBeLessThanOrEqual(500)
  })

  it('a memo over its size (edited by hand) is asked back rewritten, and what comes back is cut to the size', async () => {
    await saveAssistantConfig({ memoryChars: 1000 })
    await writeFile(join(openGroundHome(), 'assistant', 'memory.md'), 'い'.repeat(3000))
    const m = model({ reply: 'ok', memory: 'う'.repeat(900) }, { reply: 'ok' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('REQUIRED')
    expect(m.prompts[0]).toContain('at most 1000 characters')
    expect(await readAssistantMemory()).toBe('う'.repeat(900))
    await askAssistant('また', { run: m.run, digest: noProjects })
    expect(m.prompts[1]).not.toContain('REQUIRED')
  })

  it('a size lowered while a line is being answered still holds: that line\'s longer memo is not written', async () => {
    let release!: () => void
    const run: AssistantDeps['run'] = () => new Promise((r) => (release = () => r(JSON.stringify({ reply: 'ok', memory: 'え'.repeat(4000) }))))
    const p = askAssistant('覚えて', { run, digest: noProjects })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await saveAssistantConfig({ memoryChars: 500 })
    release()
    await p
    expect(await readAssistantMemory()).toBe('')
  })

  it('a malformed memo in the answer costs nothing else: the reply still comes and is logged', async () => {
    const m = model({ reply: '了解', memory: ['not', 'text'] })
    expect(await askAssistant('やあ', { run: m.run, digest: noProjects })).toEqual({ reply: '了解' })
    expect(await readAssistantMemory()).toBe('')
    expect((await readAssistantLog()).map((e) => e.text)).toEqual(['やあ', '了解'])
  })
})

describe('the memory goes on after a restart, days later', () => {
  it('what was said and the memo are read by a freshly loaded assistant three days on', async () => {
    const first = model({ reply: '覚えたよ', memory: 'オーナーの猫の名前はミケ' })
    await askAssistant('うちの猫はミケって覚えておいて', { run: first.run, digest: noProjects })
    expect(first.prompts[0]).toContain('remember or forget')

    // A restart: nothing in memory survives — a fresh copy of the code.
    __resetAssistantMemory()
    vi.resetModules()
    const fresh = await import('./phoneAssistant')
    const later = model({ reply: 'ミケだよ' })
    const threeDays = new Date(Date.now() + 3 * DAY)
    expect(await fresh.askAssistant('猫の名前なんだっけ', { run: later.run, digest: noProjects, now: () => threeDays })).toEqual({ reply: 'ミケだよ' })
    expect(later.prompts[0]).toContain('オーナーの猫の名前はミケ') // the memo
    expect(later.prompts[0]).toContain('うちの猫はミケって覚えておいて') // the recent talk
    expect(later.prompts[0]).toContain('覚えたよ')
  })
})

describe('old talk is folded into the one memo (compaction)', () => {
  const seed = async (n: number, ago = 3_600_000) => {
    const t0 = Date.now() - ago
    await appendAssistantEntries(
      Array.from({ length: n }, (_, i) => ({ at: t0 + i * 1000, who: i % 2 ? ('assistant' as const) : ('owner' as const), text: `L${String(i).padStart(2, '0')}`, via: 'phone' as const })),
    )
  }

  it('a short talk is read whole and the memo is not asked for', async () => {
    await seed(10)
    const m = model({ reply: 'ok' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('L00')
    expect(m.prompts[0]).not.toContain('REQUIRED')
    expect(m.prompts[0]).not.toContain('Older talk leaving your view')
  })

  it('past 30 lines the older part must be folded; once folded it is read only through the memo', async () => {
    await seed(32)
    const m = model({ reply: 'ok', memory: 'まとめ: L00〜L11 の話' }, { reply: 'ok2' })
    await askAssistant('一つ目', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('REQUIRED')
    expect(m.prompts[0]).toMatch(/Older talk leaving your view[\s\S]*L00[\s\S]*L11[\s\S]*Conversation so far[\s\S]*L12/)
    expect(await readAssistantMemory()).toBe('まとめ: L00〜L11 の話')
    await askAssistant('二つ目', { run: m.run, digest: noProjects })
    expect(m.prompts[1]).toContain('まとめ: L00〜L11 の話')
    expect(m.prompts[1]).not.toMatch(/Owner: L00|You: L11/)
    expect(m.prompts[1]).toContain('L12')
    expect(m.prompts[1]).toContain('一つ目')
    // The log itself still holds every line (deleted by days, not by folding).
    expect(await readAssistantLog()).toHaveLength(36)
  })

  it('talk waiting more than a day is folded at the next line, few lines or not — it would expire unfolded otherwise', async () => {
    await seed(4, 2 * DAY)
    const m = model({ reply: 'ok', memory: 'おととい: L00〜L03' }, { reply: 'ok' })
    await askAssistant('ひさしぶり', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('REQUIRED')
    expect(m.prompts[0]).toMatch(/Older talk leaving your view[\s\S]*L00[\s\S]*L03/)
    await askAssistant('それで', { run: m.run, digest: noProjects })
    expect(m.prompts[1]).not.toMatch(/(Owner|You): L03/)
    expect(m.prompts[1]).toContain('おととい: L00〜L03')
  })

  it('a fold too long to show at once shows the OLDEST part and marks only that folded', async () => {
    const t0 = Date.now() - 2 * DAY
    await appendAssistantEntries(Array.from({ length: 12 }, (_, i) => ({ at: t0 + i, who: 'owner' as const, text: `F${String(i).padStart(2, '0')}` + 'お'.repeat(1990), via: 'phone' as const })))
    const m = model({ reply: 'ok', memory: 'm1' }, { reply: 'ok', memory: 'm2' })
    await askAssistant('一つ目', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('F00')
    expect(m.prompts[0]).not.toContain('F11')
    await askAssistant('二つ目', { run: m.run, digest: noProjects })
    expect(m.prompts[1]).not.toContain('F00')
    expect(m.prompts[1]).toMatch(/Older talk leaving your view[\s\S]*F11/)
  })

  it('while nobody talks, old talk is folded before it can expire — claude runs only when there is something to fold', async () => {
    const nothing = model({ reply: '-' })
    expect(await foldIdleAssistantTalk({ run: nothing.run })).toBe(false)
    expect(nothing.prompts).toHaveLength(0)
    await seed(4, 2 * DAY)
    const m = model({ reply: '-', memory: 'おととい: L00〜L03' }, { reply: 'ok' })
    expect(await foldIdleAssistantTalk({ run: m.run })).toBe(true)
    expect(m.prompts[0]).toMatch(/Older talk leaving your view[\s\S]*L00[\s\S]*L03/)
    expect(m.prompts[0]).toContain('Nobody is talking')
    expect(m.prompts[0]).not.toContain('The owner now says')
    expect(await readAssistantMemory()).toBe('おととい: L00〜L03')
    // Folded: nothing left to fold, and the next line does not see them verbatim.
    expect(await foldIdleAssistantTalk({ run: m.run })).toBe(false)
    expect((await readAssistantLog()).map((e) => e.text)).toEqual(['L00', 'L01', 'L02', 'L03'])
  })

  it('a fold that is not saved (memo left out, or claude failing) runs claude at most twice a day on the same lines', async () => {
    await seed(4, 2 * DAY)
    let calls = 0
    const leftOut: AssistantDeps['run'] = async () => (calls++, JSON.stringify({ reply: '-' }))
    const t0 = Date.now()
    // The server ticks every hour: a day of ticks — and it restarts before each
    // one (`npm run dev` restarts on every save): the gap must outlive that.
    const day = async (run: AssistantDeps['run']) => {
      for (let h = 0; h < 24; h++) {
        __resetAssistantMemory()
        expect(await foldIdleAssistantTalk({ run, now: () => new Date(t0 + h * 3_600_000) }).catch(() => false)).toBe(false)
      }
    }
    await day(leftOut)
    expect(calls).toBeLessThanOrEqual(2)
    expect(calls).toBeGreaterThan(0)
    // Fresh lines for the next case (deleting the log resets what was tried).
    await clearAssistantLog()
    await seed(4, 2 * DAY)
    calls = 0
    await day(async () => (calls++, Promise.reject(new Error('claude not ready'))))
    expect(calls).toBeLessThanOrEqual(2)
    // A saved fold is true, and the memo holds it.
    await clearAssistantLog()
    await seed(4, 2 * DAY)
    expect(await foldIdleAssistantTalk({ run: async () => JSON.stringify({ reply: '-', memory: 'まとめ' }) })).toBe(true)
    expect(await readAssistantMemory()).toBe('まとめ')
  })

  it('an unattended run that saves nothing keeps the mark of what was already folded', async () => {
    await seed(4, 3 * DAY)
    expect(await foldIdleAssistantTalk({ run: async () => JSON.stringify({ reply: '-', memory: 'まとめ' }) })).toBe(true)
    const folded = await readFolded()
    expect(folded).not.toBeNull()
    // More old talk, and a run that leaves the memo out: only its try is written.
    await seed(4, 2 * DAY)
    expect(await foldIdleAssistantTalk({ run: async () => JSON.stringify({ reply: '-' }) })).toBe(false)
    expect(await readIdleTried()).not.toBeNull()
    // Lost, the next hourly run would fold the whole 30 days again.
    expect(await readFolded()).toEqual(folded)
  })

  it('a fold-only run never empties a memo that holds something, flag or not — nobody asked to forget', async () => {
    await writeAssistantMemory('大事な長期記憶', 4000)
    await seed(4, 2 * DAY)
    const m = model({ reply: '-', memory: '', forgetAll: true })
    expect(await foldIdleAssistantTalk({ run: m.run })).toBe(false)
    expect(await readAssistantMemory()).toBe('大事な長期記憶')
    expect(m.prompts[0]).not.toContain('forgetAll')
  })

  it('a line that got no answer is still logged, so the next answer sees it', async () => {
    const run: AssistantDeps['run'] = async () => 'not json'
    await expect(askAssistant('聞こえる?', { run, digest: noProjects })).rejects.toBeTruthy()
    expect((await readAssistantLog()).map((e) => [e.who, e.text])).toEqual([['owner', '聞こえる?']])
    const m = model({ reply: 'うん' })
    await askAssistant('もう一回', { run: m.run, digest: noProjects })
    expect(m.prompts[0]).toContain('聞こえる?')
  })

  it('a fold the model skipped is asked for again on the next line', async () => {
    await seed(32)
    const m = model({ reply: 'ok' }, { reply: 'ok' })
    await askAssistant('一つ目', { run: m.run, digest: noProjects })
    await askAssistant('二つ目', { run: m.run, digest: noProjects })
    expect(m.prompts[1]).toContain('REQUIRED')
    expect(m.prompts[1]).toMatch(/Older talk leaving your view[\s\S]*L00/)
  })
})

describe('"remember" / "forget", and deleting', () => {
  it('an empty memo is not a memo: the long-term memory stays unless the owner asked to forget everything', async () => {
    await writeAssistantMemory('大事な長期記憶', 4000)
    const m = model({ reply: 'ok', memory: '' }, { reply: 'ok', memory: '   ' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    await askAssistant('それで', { run: m.run, digest: noProjects })
    expect(await readAssistantMemory()).toBe('大事な長期記憶')
    expect(m.prompts[0]).toContain('"forgetAll": true')
  })

  it('a memo returned without a fold due is kept; "forget" of its only fact really empties it', async () => {
    // A stand-in that does exactly what the prompt says: it adds forgetAll to
    // an empty memory only if the prompt asks for that whenever the memory
    // comes out empty — the reviewer's case was a one-fact memo, "forget that",
    // under a prompt that asked for forgetAll only on "forget EVERYTHING".
    const prompts: string[] = []
    const run: AssistantDeps['run'] = async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) return JSON.stringify({ reply: '覚えた', memory: '朝はコーヒー' })
      const flag = prompt.includes('asks you to forget something and the memory then comes out EMPTY, add "forgetAll": true')
      return JSON.stringify({ reply: '忘れた', memory: '', ...(flag ? { forgetAll: true } : {}) })
    }
    await askAssistant('朝はコーヒー派って覚えて', { run, digest: noProjects })
    expect(await readAssistantMemory()).toBe('朝はコーヒー')
    await askAssistant('朝はコーヒーのこと忘れて', { run, digest: noProjects })
    expect(prompts[1]).toContain('朝はコーヒー') // it saw the memo it was asked to change
    expect(await readAssistantMemory()).toBe('')
  })

  it('the flag is offered only for the owner\'s own "forget": a fold-due "最近どう?" cannot empty the memory', async () => {
    await writeAssistantMemory('大事な長期記憶', 4000)
    await appendAssistantEntries([{ at: Date.now() - 2 * DAY, who: 'owner', text: '古い雑談', via: 'phone' }])
    // A stand-in that empties the memory and sets the flag whenever the prompt
    // lets it do so for ANY empty memory (the old wording did).
    const prompts: string[] = []
    const run: AssistantDeps['run'] = async (prompt) => {
      prompts.push(prompt)
      const anyEmpty = prompt.includes('Whenever the "memory" you return is EMPTY')
      return JSON.stringify({ reply: '順調だよ', memory: '', ...(anyEmpty ? { forgetAll: true } : {}) })
    }
    await askAssistant('最近どう?', { run, digest: noProjects })
    expect(prompts[0]).toContain('REQUIRED')
    expect(prompts[0]).toContain('in the line above, asks you to forget something')
    expect(await readAssistantMemory()).toBe('大事な長期記憶')
  })

  it('a memo deleted while a line is being answered is not written back by that line', async () => {
    let release!: () => void
    const run: AssistantDeps['run'] = () => new Promise((r) => (release = () => r(JSON.stringify({ reply: 'ok', memory: '古いメモ' }))))
    await writeAssistantMemory('古いメモ', 4000)
    const p = askAssistant('やあ', { run, digest: noProjects })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await clearAssistantMemory()
    release()
    await p
    expect(await readAssistantMemory()).toBe('')
  })

  it('a delete asked while the line is still writing its log wins over the memo that line brings back', async () => {
    // The line's last steps, as phoneAssistant's turn does them: the epoch it
    // started at, its log write (holding the lock), then its memo. Every kind of
    // delete pressed during that log write must keep its memo out.
    for (const del of [clearAssistantMemory, clearAssistantLog, () => deleteAssistantEntry('any')]) {
      await writeAssistantMemory('前からのメモ', 4000)
      const epoch = assistantEpoch()
      const logging = appendAssistantEntries([{ at: Date.now(), who: 'owner', text: 'やあ', via: 'phone' }])
      const deleting = del()
      await logging
      expect(await writeAssistantMemory('この行が書き戻すメモ', 4000, { epoch, folded: { id: 'x', at: 1 } })).toBeNull()
      await deleting
      expect(await readAssistantMemory()).not.toBe('この行が書き戻すメモ')
      await clearAssistantMemory()
    }
  })

  it('one line or all of the log can be deleted', async () => {
    const [a, b] = await appendAssistantEntries([
      { at: Date.now() - 2000, who: 'owner', text: '残す', via: 'phone' },
      { at: Date.now() - 1000, who: 'owner', text: '消す', via: 'phone' },
    ])
    expect(await deleteAssistantEntry(b.id)).toBe(true)
    expect(await deleteAssistantEntry('no-such-id')).toBe(false)
    expect((await readAssistantLog()).map((e) => e.id)).toEqual([a.id])
    await clearAssistantLog()
    expect(await readAssistantLog()).toEqual([])
  })
})

describe('one log for the phone and the screen, owner-only files', () => {
  it('both ends land in the same log, marked where they came from', async () => {
    const m = model({ reply: 'はい' }, { reply: 'うん' })
    await askAssistant('画面から', { run: m.run, digest: noProjects, via: 'screen' })
    await askAssistant('電話から', { run: m.run, digest: noProjects })
    expect((await readAssistantLog()).map((e) => [e.who, e.via, e.text])).toEqual([
      ['owner', 'screen', '画面から'],
      ['assistant', 'screen', 'はい'],
      ['owner', 'phone', '電話から'],
      ['assistant', 'phone', 'うん'],
    ])
    expect(m.prompts[1]).toContain('画面から')
  })

  it('the folder is 0700 and every file in it 0600', async () => {
    const m = model({ reply: 'ok', memory: 'メモ' })
    await askAssistant('やあ', { run: m.run, digest: noProjects })
    const base = join(openGroundHome(), 'assistant')
    const mode = async (p: string) => (await stat(p)).mode & 0o777
    expect(await mode(base)).toBe(0o700)
    expect(await mode(logDir())).toBe(0o700)
    for (const f of await readdir(logDir())) expect(await mode(join(logDir(), f))).toBe(0o600)
    expect(await mode(join(base, 'memory.md'))).toBe(0o600)
    expect(await mode(join(base, 'config.json'))).toBe(0o600)
  })

  it('a line under work mode is neither answered nor written down', async () => {
    // (Settings reads re-mirror the stored switch, so it is turned on mid-turn, as in phoneAssistant.test.ts.)
    const digest: AssistantDeps['digest'] = async () => (setLockdownCache(true), { text: '', projects: [] })
    const m = model({ reply: 'ok' })
    await expect(askAssistant('やあ', { run: m.run, digest })).rejects.toThrow()
    expect(m.prompts).toHaveLength(0)
    setLockdownCache(false)
    expect(await readAssistantLog()).toEqual([])
  })
})


it('call metadata remains in the shared reader but never enters assistant prompts or folding', async () => {
  await appendAssistantCall('assistant-call', { at: Date.now(), who: 'owner', via: 'phone', text: 'Call 1:42 metadata-only', kind: 'call', seconds: 102, projectId: 'assistant' })
  await appendAssistantCall('president-call', { at: Date.now(), who: 'owner', via: 'phone', text: 'President call private metadata-only', kind: 'call', seconds: 44, projectId: 'p1' })
  expect(await readAssistantLog()).toHaveLength(2)
  const m = model({ reply: 'ok' })
  await askAssistant('hello', { run: m.run, digest: noProjects })
  expect(m.prompts.join('')).not.toContain('metadata-only')
})


it('phone owner client ids survive authoritative history even for repeated identical text, never becoming model text', async () => {
  const m = model({ reply: 'one' }, { reply: 'two' })
  const now = Date.now()
  await askAssistant('same words', { run: m.run, digest: noProjects, now: () => new Date(now - 1000), clientId: 'old-phone-id' })
  await askAssistant('same words', { run: m.run, digest: noProjects, now: () => new Date(now), clientId: 'new-phone-id' })
  const owners = (await readAssistantLog()).filter((e) => e.who === 'owner')
  expect(owners.map((e) => [e.text, e.clientId])).toEqual([['same words', 'old-phone-id'], ['same words', 'new-phone-id']])
  expect(m.prompts.join('')).not.toContain('phone-id')
})
