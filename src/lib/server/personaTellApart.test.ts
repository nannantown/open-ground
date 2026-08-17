import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TELL_APART_EVERY,
  answerTellApart,
  nextTellApart,
  skipTellApart,
  tellApartMisses,
} from './personaTellApart'
import { appendJudgment } from './youCorpus'
import { personaTellApartFile } from './paths'

// 「どれが自分ではないか」 — WHEN it is asked, that it holds still while it is on
// screen, and what answering it records. The question itself is built by the
// pure src/lib/persona/tellApart.ts (its own tests).

let home: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-tellapart-')))
  process.env.OPENGROUND_HOME = home
  // Hermetic assembly: appendJudgment re-assembles the corpus, and without these
  // it would go looking for the real ~/.claude auto-memory.
  process.env.OPENGROUND_MEMORY_DIR = join(home, 'no-memory')
  process.env.OPENGROUND_CONCEPT_PATH = join(home, 'no-concept.md')
})

afterEach(async () => {
  delete process.env.OPENGROUND_MEMORY_DIR
  delete process.env.OPENGROUND_CONCEPT_PATH
  await rm(home, { recursive: true, force: true })
})

/** n lines of HIS OWN (a course finding would not count — see tellApart.ts). */
const write = async (n: number, from = 0) => {
  for (let i = from; i < from + n; i++) {
    await appendJudgment({ text: `本人の言葉 ${i}`, tags: ['chat'] })
  }
}

describe('when the check is offered', () => {
  it('is NOT offered before the record has grown enough', async () => {
    await write(TELL_APART_EVERY - 1)
    expect(await nextTellApart()).toBeNull()
  })

  it('is offered once it has', async () => {
    await write(TELL_APART_EVERY)
    const check = await nextTellApart()
    expect(check?.options).toHaveLength(3)
  })

  it('⚠ NEVER SENDS THE ANSWER TO THE BROWSER', async () => {
    // The page that asks 「どれが自分ではないか」 must not be carrying the answer to
    // it: this is a tool for finding out something true about yourself.
    await write(TELL_APART_EVERY)
    const check = await nextTellApart()
    expect(JSON.stringify(check)).not.toContain('answerId')
    expect(JSON.stringify(check)).not.toContain('mineIds')
  })

  it('⚠ HOLDS STILL — asking again returns the SAME three lines', async () => {
    // Three options that reshuffle on refresh are not a question, and an answer
    // to one means nothing.
    await write(TELL_APART_EVERY)
    const first = await nextTellApart()
    await write(3, 100)
    expect(await nextTellApart()).toEqual(first)
  })

  it('does not offer one when too few lines are HIS OWN', async () => {
    // Course findings are the instrument's wording, not his — see tellApart.ts.
    for (let i = 0; i < TELL_APART_EVERY + 2; i++) {
      await appendJudgment({ text: `コースの結果 ${i}`, tags: ['persona', 'big5'] })
    }
    expect(await nextTellApart()).toBeNull()
    // ⚠ AND THE COUNTER DID NOT MOVE: the record has not been checked, so the
    // next ten lines must not be silenced too.
    await write(2)
    expect(await nextTellApart()).not.toBeNull()
  })
})

describe('answering it', () => {
  const optionsOf = async () => {
    const check = await nextTellApart()
    if (!check) throw new Error('no check')
    // The stranger is the option whose id is not a uuid from the corpus.
    const stranger = check.options.find((o) => o.id.startsWith('barnum:'))!
    const mine = check.options.find((o) => !o.id.startsWith('barnum:'))!
    return { check, stranger, mine }
  }

  it('says so when he picked the stranger, and records no miss', async () => {
    await write(TELL_APART_EVERY)
    const { check, stranger } = await optionsOf()
    const result = await answerTellApart(check.id, stranger.id)
    expect(result?.correct).toBe(true)
    expect(result?.strangerText).toBe(stranger.text)
    // ⚠ AND NO 「これはあなたの言葉でした」 — he picked the stranger, which is
    // nobody's sentence.
    expect(result?.mistookText).toBeUndefined()
    expect(await tellApartMisses()).toEqual([])
  })

  it('⚠ RECORDS THE MISS AGAINST THE LINE, NOT AGAINST HIM — and names both', async () => {
    // What a wrong answer means is that THIS LINE reads like something anyone
    // would say: a fact about the sentence, fixable by rewriting or withdrawing.
    await write(TELL_APART_EVERY)
    const { check, stranger, mine } = await optionsOf()
    const result = await answerTellApart(check.id, mine.id)
    expect(result?.correct).toBe(false)
    expect(result?.mistookText).toBe(mine.text)
    // The stranger is shown too, so a wrong answer ends by showing what a
    // fits-anyone sentence looks like beside his own.
    expect(result?.strangerText).toBe(stranger.text)
    expect(await tellApartMisses()).toEqual([mine.id])
  })

  it('⚠ WRITES NOTHING TO THE CORPUS, right or wrong', async () => {
    // A detector that edited the record it was auditing would be the last thing
    // this feature should ship.
    await write(TELL_APART_EVERY)
    const before = await readFile(join(home, 'you-corpus-additions.json'), 'utf8')
    const { check, mine } = await optionsOf()
    await answerTellApart(check.id, mine.id)
    expect(await readFile(join(home, 'you-corpus-additions.json'), 'utf8')).toBe(before)
  })

  it('a stale tab cannot answer a check that has moved on', async () => {
    await write(TELL_APART_EVERY)
    const { check, stranger } = await optionsOf()
    await answerTellApart(check.id, stranger.id)
    expect(await answerTellApart(check.id, stranger.id)).toBeNull()
    // …and it recorded nothing the second time.
    expect(await tellApartMisses()).toEqual([])
  })

  it('waits for another ten lines before asking again', async () => {
    await write(TELL_APART_EVERY)
    const { check, stranger } = await optionsOf()
    await answerTellApart(check.id, stranger.id)
    expect(await nextTellApart()).toBeNull()
    await write(TELL_APART_EVERY, 200)
    expect(await nextTellApart()).not.toBeNull()
  })
})

describe('「あとで」', () => {
  it('clears the check and pushes the next one out by the same ten lines', async () => {
    await write(TELL_APART_EVERY)
    const check = await nextTellApart()
    expect(await skipTellApart(check!.id)).toBe(true)
    expect(await nextTellApart()).toBeNull()
    // Declining is not punished with the same question on the next screen.
    await write(TELL_APART_EVERY, 300)
    expect(await nextTellApart()).not.toBeNull()
  })

  it('ignores a skip for a check that is not the open one', async () => {
    await write(TELL_APART_EVERY)
    await nextTellApart()
    expect(await skipTellApart('not-the-open-one')).toBe(false)
    expect(await nextTellApart()).not.toBeNull()
  })
})

describe('the state file', () => {
  it('is owner-only — it quotes his own record', async () => {
    await write(TELL_APART_EVERY)
    await nextTellApart()
    const { stat } = await import('fs/promises')
    expect((await stat(personaTellApartFile())).mode & 0o777).toBe(0o600)
  })

  it('starts fresh from a corrupt file rather than wedging the screen', async () => {
    const { writeFile } = await import('fs/promises')
    await write(TELL_APART_EVERY)
    await writeFile(personaTellApartFile(), 'not json at all')
    // The worst case here is one repeated question — unlike the corpus, where
    // "unreadable ≠ absent" guards real judgments.
    expect(await nextTellApart()).not.toBeNull()
  })
})
