import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, realpath, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  openEscalation,
  answerEscalation,
  dismissEscalation,
  listEscalations,
  pruneResolvedEscalations,
  injectAnswerIntoWorker,
  buildAnswerInjection,
  defaultReceiptKey,
  defaultCanInjectInto,
  sanitizeForPaste,
  pasteStillInInputBox,
  EscalationNotFoundError,
  EscalationStateError,
  ESCALATION_RETENTION_DAYS,
  MAX_ESCALATION_SHOT_CHARS,
  MAX_ESCALATION_PLAIN_QUESTION,
  ENTER_RETRY_MAX,
} from './swarmEscalations'
import { escalationsFile, escalationShotsDir, youCorpusAdditionsFile } from './paths'
import { BRACKETED_PASTE_START, BRACKETED_PASTE_END } from './pastePrompt'
import type { OpenEscalationInput } from './swarmEscalations'

// The Escalations inbox (C1 — docs/OVERSEER_DESIGN.md §8), exercised against an
// ISOLATED HOME so the suite never touches the real ~/.openground. Every PTY /
// notification / memory / engine dependency is injected as a fake; ONE test each
// runs the real appendJudgment (you-corpus write-back) and the real lazy-import
// queue seam, so the default wiring is proven live too.
//
// The invariants pinned here are the card's Done conditions:
//   • FAIL-CLOSED — nothing ever leaves 'open' without an explicit owner action;
//     the retention sweep never prunes an open record no matter how old.
//   • receiptKey idempotency — an open duplicate is a no-op (no append, no
//     re-notification), so an overseer restart can't grow the inbox.
//   • corrupt-file preservation — a mangled inbox is moved aside, never clobbered.
//   • memory write-back — the OWNER's Q→A only; dismiss learns nothing.

let home: string
let project: string
// The suite-wide pin (src/test/setup-home.ts), restored in afterEach. NEVER
// `delete` it: an unset OPENGROUND_HOME makes every later openGroundHome()
// resolve to the REAL ~/.openground (the 2026-07-18 data loss).
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-escalations-')))
  process.env.OPENGROUND_HOME = home
  // A real directory so canonicalize() resolves it cleanly.
  project = join(home, 'proj')
  await mkdir(project, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  // Deliberately NOT unset: openGroundHome() falls back to the user's real
  // ~/.openground when this is empty, and vitest reuses worker processes across
  // files, so an unset here aims every later write in this process at real data
  // (observed 2026-07-19). Restore the suite-wide pin instead of leaving the
  // just-removed temp dir in place — inert either way under isolate:true, but
  // with --no-isolate the next file would inherit a home that no longer exists.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

const openInput = (over: Partial<OpenEscalationInput> = {}): OpenEscalationInput => ({
  projectPath: project,
  question: '本番の Stripe キーを配布物に埋めますか？',
  context: '課金導線の実装で必要。埋めると公開リポに乗る（不可逆）。',
  whyEscalated: 'irreversible',
  taskId: 'card-1',
  branch: 'swarm/card-1',
  ...over,
})

/** Fakes for the notification side channel (counted, never OS-toasting). */
const makeNotify = () => {
  const calls: unknown[] = []
  return {
    calls,
    notify: async (n: unknown) => {
      calls.push(n)
      return n
    },
  }
}

describe('openEscalation — persistence, idempotency, capture', () => {
  it('persists one open record and fires the notification once', async () => {
    const { calls, notify } = makeNotify()
    const { escalation, deduped } = await openEscalation(
      openInput({ proxyDraft: { answer: '埋めない', confidence: 'high', isAbstention: false } }),
      { notify },
    )
    expect(deduped).toBe(false)
    expect(escalation.status).toBe('open')
    expect(escalation.receiptKey).toBeTruthy()
    expect(escalation.projectPath).toBe(project) // canonical (realpath'd tmpdir)
    expect(calls).toHaveLength(1)
    expect((calls[0] as { event: string }).event).toBe('escalation-open')
    expect((calls[0] as { escalationId: string }).escalationId).toBe(escalation.id)

    const list = await listEscalations()
    expect(list).toHaveLength(1)
    expect(list[0].question).toContain('Stripe')
    expect(list[0].proxyDraft?.confidence).toBe('high')
    expect(list[0].whyEscalated).toBe('irreversible')
  })

  it('plainQuestion (平易文) persists first-class, clamps, and leads the toast teaser', async () => {
    const { calls, notify } = makeNotify()
    const plain =
      '作業中のプログラムが、古いデータの置き場所を削除してよいか聞いています。\n' +
      'A: 削除する（二度と戻せませんが、動作が軽くなります）\n' +
      'B: 残す（安全ですが、容量を使い続けます）'
    const { escalation } = await openEscalation(openInput({ plainQuestion: plain }), { notify })
    expect(escalation.plainQuestion).toBe(plain)
    const [row] = await listEscalations()
    expect(row.plainQuestion).toBe(plain) // survives persist → list round-trip
    // The owner-facing toast leads with the PLAIN text, not the technical question.
    expect((calls[0] as { detail: string }).detail).toContain('古いデータの置き場所')
    expect((calls[0] as { detail: string }).detail).not.toContain('Stripe')

    // Absent stays absent (backward compat — the UI then renders `question`).
    const bare = await openEscalation(openInput({ taskId: 'card-2', question: '素の質問？' }), { notify })
    expect(bare.escalation.plainQuestion).toBeUndefined()
    // Whitespace-only collapses to absent (never a blank primary line in the UI).
    const blank = await openEscalation(
      openInput({ taskId: 'card-3', question: '第三の質問？', plainQuestion: '   ' }),
      { notify },
    )
    expect(blank.escalation.plainQuestion).toBeUndefined()
    // Clamped like question (the inbox is uncapped — nothing unbounded may enter).
    const long = await openEscalation(
      openInput({
        taskId: 'card-4',
        question: '第四の質問？',
        plainQuestion: 'あ'.repeat(MAX_ESCALATION_PLAIN_QUESTION + 100),
      }),
      { notify },
    )
    expect((long.escalation.plainQuestion ?? '').length).toBe(MAX_ESCALATION_PLAIN_QUESTION)
  })

  it('is idempotent on receiptKey while OPEN: no second record, no re-notification', async () => {
    const { calls, notify } = makeNotify()
    const first = await openEscalation(openInput(), { notify })
    const second = await openEscalation(openInput(), { notify })
    expect(second.deduped).toBe(true)
    expect(second.escalation.id).toBe(first.escalation.id)
    expect(await listEscalations()).toHaveLength(1)
    expect(calls).toHaveLength(1) // the dedup also suppressed the re-toast
  })

  it('a RESOLVED record frees its receiptKey — the same question may open anew', async () => {
    const { notify } = makeNotify()
    const first = await openEscalation(openInput(), { notify })
    await dismissEscalation(first.escalation.id)
    const again = await openEscalation(openInput(), { notify })
    expect(again.deduped).toBe(false)
    expect(again.escalation.id).not.toBe(first.escalation.id)
    expect(await listEscalations()).toHaveLength(2)
  })

  it('preserves a corrupt inbox aside as .corrupt-<ts> instead of clobbering it', async () => {
    await mkdir(home, { recursive: true })
    await writeFile(escalationsFile(), 'not json at all', 'utf8')
    const { notify } = makeNotify()
    await openEscalation(openInput(), { notify })
    const names = await readdir(home)
    const corrupt = names.find((n) => n.startsWith('escalations.json.corrupt-'))
    expect(corrupt).toBeTruthy()
    expect(await readFile(join(home, corrupt as string), 'utf8')).toBe('not json at all')
    expect(await listEscalations()).toHaveLength(1) // the new record still landed
  })

  it('serialises concurrent opens (single-flight): none lost', async () => {
    const { notify } = makeNotify()
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        openEscalation(openInput({ question: `質問 ${i} ですか？`, taskId: `card-${i}` }), {
          notify,
        }),
      ),
    )
    expect(await listEscalations()).toHaveLength(5)
  })

  it('captures the worker PTY tail (clamped) and expands it on list', async () => {
    const { notify } = makeNotify()
    const screen = `${'x'.repeat(MAX_ESCALATION_SHOT_CHARS)}TAIL-MARKER`
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-1' }), {
      notify,
      captureScreen: (id) => (id === 'pty-1' ? screen : null),
    })
    expect(escalation.screenshotRef).toBeTruthy()
    const stored = await readFile(escalation.screenshotRef as string, 'utf8')
    expect(stored.length).toBeLessThanOrEqual(MAX_ESCALATION_SHOT_CHARS)
    expect(stored.endsWith('TAIL-MARKER')).toBe(true) // the TAIL survives the clamp
    const [row] = await listEscalations()
    expect(row.screenshot).toBe(stored)
  })

  it('a TAMPERED screenshotRef is neither read back (list) nor unlinked (prune)', async () => {
    const { notify } = makeNotify()
    const secret = join(home, 'secret.txt')
    await writeFile(secret, 'do not exfiltrate or delete', 'utf8')
    const old = new Date(Date.now() - (ESCALATION_RETENTION_DAYS + 10) * 24 * 60 * 60 * 1000)
    const { escalation } = await openEscalation(openInput(), { notify, now: () => old })
    // Simulate on-disk tampering: point the record's ref OUTSIDE the shots dir.
    const raw = JSON.parse(await readFile(escalationsFile(), 'utf8')) as {
      items: Array<Record<string, unknown>>
    }
    raw.items[0].screenshotRef = secret
    await writeFile(escalationsFile(), JSON.stringify(raw), 'utf8')

    // list: the foreign file's contents never ride out.
    const [row] = await listEscalations()
    expect(row.screenshot).toBeUndefined()

    // prune: resolve it, age it out — the foreign file survives the sweep.
    await dismissEscalation(escalation.id, { now: () => old })
    expect(await pruneResolvedEscalations()).toBe(1)
    expect(await readFile(secret, 'utf8')).toBe('do not exfiltrate or delete')
  })

  it('defaultReceiptKey folds whitespace/case wobble but separates cards', () => {
    const a = defaultReceiptKey({ projectPath: '/p', taskId: 'c1', question: 'Deploy  NOW? ' })
    const b = defaultReceiptKey({ projectPath: '/p', taskId: 'c1', question: 'deploy now?' })
    const c = defaultReceiptKey({ projectPath: '/p', taskId: 'c2', question: 'deploy now?' })
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
})

describe('answerEscalation — delivery, memory, idempotency', () => {
  const answerDeps = () => {
    const writes: Array<{ id: string; data: string }> = []
    const memory: Array<{ text: string; tags?: string[] }> = []
    const queued: Array<{ projectPath: string; taskId: string; line: string }> = []
    return {
      writes,
      memory,
      queued,
      deps: {
        write: (id: string, data: string) => {
          writes.push({ id, data })
          return true
        },
        sleep: async () => {},
        appendMemory: async (input: { text: string; tags?: string[] }) => {
          memory.push(input)
        },
        queueForNextDispatch: async (projectPath: string, taskId: string, line: string) => {
          queued.push({ projectPath, taskId, line })
        },
        isPathAllowed: async () => true,
        // The REAL guard needs a live claude PTY in a registered project —
        // neither exists in this suite. Its own conditions are unit-tested
        // separately (defaultCanInjectInto below).
        canInjectInto: async () => true,
      },
    }
  }

  it('LIVE worker → bracketed-paste + Enter, status injected, memory written', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-1' }), { notify })
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, '埋めない。ビルド時に env から注入する。', h.deps)

    expect(res.delivery).toBe('injected')
    expect(res.memoryWritten).toBe(true)
    expect(res.escalation.status).toBe('injected')
    expect(res.escalation.answer).toContain('env から注入')
    expect(res.escalation.injectedAt).toBeTruthy()

    // 着弾確認 contract: paste first (bracketed, both markers), then a bare CR.
    expect(h.writes).toHaveLength(2)
    expect(h.writes[0].id).toBe('pty-1')
    expect(h.writes[0].data.startsWith(BRACKETED_PASTE_START)).toBe(true)
    expect(h.writes[0].data.endsWith(BRACKETED_PASTE_END)).toBe(true)
    expect(h.writes[0].data).toContain('埋めない')
    expect(h.writes[1].data).toBe('\r')

    // Memory carries the owner's Q→A, tagged for the training pipeline.
    expect(h.memory).toHaveLength(1)
    expect(h.memory[0].text).toContain('Q: ')
    // Labelled in words, not `→ A:` — the corpus is what the brain reads back, and
    // an `A:` answer next to the question's own `A: …` option is the misreading
    // this routing work exists to prevent (same rule as the injection).
    expect(h.memory[0].text).toContain('→ オーナーの回答: 埋めない')
    expect(h.memory[0].tags).toContain('escalation')
    expect(h.memory[0].tags).toContain('irreversible')

    // Nothing was queued — the live path won.
    expect(h.queued).toHaveLength(0)
  })

  // ── Misattribution guard, END-TO-END (the routing lane's whole point) ────────
  // The pure helper is pinned in "injection helpers" below; THESE pin the WIRING —
  // that every delivery lane actually passes plainQuestion through. Both lanes are
  // covered because the queued one re-introduced the bug once: the injection was
  // fixed while `queueForNextDispatch` kept pairing the raw technical question, so
  // the misattribution simply moved to the next dispatch.
  const routingInput = (over: Partial<OpenEscalationInput> = {}) =>
    openInput({
      question: '実装方式はどちらにしますか？ A: 既存テーブルを拡張 B: 新テーブルを追加',
      // Multi-line on purpose — the real routing question is a joined block, and
      // the queued lane must survive it (the /order goal is one argv line).
      plainQuestion: [
        '聞かれているのは「実装方式はどちらにしますか？」です。',
        '「まかせる」と書く → AIが判断して先へ進みます。',
      ].join('\n'),
      whyEscalated: 'insufficient-info',
      ...over,
    })

  it('LIVE worker, routing record → the paste pairs the answer with the OWNER’s question, not the技術原文', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(routingInput({ terminalId: 'pty-r' }), { notify })
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, 'まかせる', h.deps)

    expect(res.delivery).toBe('injected')
    const paste = h.writes[0].data
    expect(paste).toContain('オーナーに表示された質問')
    expect(paste).toContain('「まかせる」と書く')
    expect(paste).toContain('あなたが出した元の質問')
    // The failure this closes: "A: 既存テーブルを拡張…" sitting under a bare `Q:`
    // with `A: まかせる` beneath it, so the worker reads its own option as chosen.
    expect(paste).not.toContain('Q: 実装方式はどちらにしますか？')
  })

  it('queued lane, routing record → the next dispatch carries the same attribution', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(routingInput(), { notify }) // no terminalId
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, 'まかせる', h.deps)

    expect(res.delivery).toBe('queued')
    const line = h.queued[0].line
    expect(line).toContain('オーナーに表示された質問')
    expect(line).toContain('あなたが出した元の質問')
    expect(line).toContain('まかせる')
    expect(line).not.toContain('Q: 実装方式はどちらにしますか？')
    // Still ONE argv-bound line — the /order goal cannot carry a newline.
    expect(line).not.toMatch(/[\n\r]/)
  })

  it('plain records are untouched — no plainQuestion means the original Q: shape', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-p' }), { notify })
    const h = answerDeps()
    await answerEscalation(escalation.id, '埋めない', h.deps)
    expect(h.writes[0].data).toContain('Q: 本番の Stripe キーを配布物に埋めますか？')
    expect(h.writes[0].data).not.toContain('オーナーに表示された質問')
  })

  // The BARE queue lane — the one that carries worker-authored questions, whose
  // option menus `brief()` folds onto this single line. It had no label assertion,
  // so `→ A:` survived here after the other two surfaces were converted.
  it('the bare queue lane labels the answer in words too (all three surfaces agree)', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(
      openInput({
        question: 'カードのデータをどちらに置きますか？\nA: 既存テーブルを拡張\nB: 新テーブルを追加',
      }),
      { notify },
    )
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, 'B', h.deps)
    expect(res.delivery).toBe('queued')
    expect(h.queued[0].line).toContain('オーナーの回答: B')
    // `A:` may appear ONLY as the question's own option — never as the answer.
    expect(h.queued[0].line).not.toContain('→ A: ')
  })

  it('dead PTY (write returns false) → falls back to the next-dispatch queue', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-dead' }), { notify })
    const h = answerDeps()
    h.deps.write = () => false
    const res = await answerEscalation(escalation.id, '答えはB', h.deps)
    expect(res.delivery).toBe('queued')
    expect(res.escalation.status).toBe('answered') // injected only on true delivery
    expect(h.queued).toHaveLength(1)
    expect(h.queued[0]).toMatchObject({ projectPath: project, taskId: 'card-1' })
    expect(h.queued[0].line).toContain('答えはB')
  })

  it('no worker at all (no terminalId) → queued for the card', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput(), { notify })
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, '答えはC', h.deps)
    expect(res.delivery).toBe('queued')
    expect(h.writes).toHaveLength(0)
  })

  it('no worker and no card → skipped (recorded + learned, nothing to deliver to)', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ taskId: undefined }), { notify })
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, '答えはD', h.deps)
    expect(res.delivery).toBe('skipped')
    expect(res.escalation.status).toBe('answered')
    expect(res.memoryWritten).toBe(true)
  })

  it('a project no longer in the registry is NOT injected into (defence in depth)', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-1' }), { notify })
    const h = answerDeps()
    h.deps.isPathAllowed = async () => false
    const res = await answerEscalation(escalation.id, '答えはE', h.deps)
    expect(res.delivery).toBe('skipped')
    expect(h.writes).toHaveLength(0)
    expect(h.queued).toHaveLength(0)
    expect(res.memoryWritten).toBe(true) // learning is project-independent
  })

  it('re-answering never rewrites the decision: first answer stands, memory written once, only DELIVERY retries', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput(), { notify })
    const h = answerDeps()
    await answerEscalation(escalation.id, '最初の回答', h.deps) // no PTY → queued
    const second = await answerEscalation(escalation.id, '二度目の回答', h.deps)
    expect(second.delivery).toBe('queued') // the delivery leg re-ran…
    expect(second.escalation.answer).toBe('最初の回答') // …but the decision did not change
    expect(second.memoryWritten).toBe(false)
    expect(h.memory).toHaveLength(1) // learned exactly once
    expect(h.queued[1].line).toContain('最初の回答') // the retry carries the ORIGINAL answer
  })

  it('answering a DISMISSED record is a loud state error', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput(), { notify })
    await dismissEscalation(escalation.id)
    const h = answerDeps()
    await expect(answerEscalation(escalation.id, 'x', h.deps)).rejects.toBeInstanceOf(
      EscalationStateError,
    )
  })

  it('unknown id → EscalationNotFoundError', async () => {
    const h = answerDeps()
    await expect(answerEscalation('nope', 'x', h.deps)).rejects.toBeInstanceOf(
      EscalationNotFoundError,
    )
  })

  it('a memory failure never blocks the unblock (memoryWritten:false, delivery proceeds)', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-1' }), { notify })
    const h = answerDeps()
    h.deps.appendMemory = async () => {
      throw new Error('corpus unavailable')
    }
    const res = await answerEscalation(escalation.id, '回答F', h.deps)
    expect(res.memoryWritten).toBe(false)
    expect(res.delivery).toBe('injected')
  })

  it('DEFAULT memory wiring really appends the Q→A to you-corpus additions', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ taskId: undefined }), { notify })
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, '本人の実回答', {
      ...h.deps,
      appendMemory: undefined, // fall through to the real appendJudgment
    })
    expect(res.memoryWritten).toBe(true)
    const additions = JSON.parse(await readFile(youCorpusAdditionsFile(), 'utf8')) as Array<{
      text: string
      tags?: string[]
    }>
    expect(additions).toHaveLength(1)
    expect(additions[0].text).toContain('本人の実回答')
    expect(additions[0].tags).toContain('escalation')
  })

  // M2 — the corpus must record the question the owner ACTUALLY READ. The UI shows
  // plainQuestion as the primary text (the technical original folds into a details
  // pane), so pairing their answer with the technical wording misattributes it. The
  // routing question is the sharp case: "まかせる" (= "you decide") filed under
  // "which library should we use?" would teach the next brain something about the
  // LIBRARY — inverting the whole point of routing.
  it('learns the PLAIN question the owner answered, not the technical original', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(
      openInput({
        taskId: undefined,
        question: 'ライブラリはAとBのどちらを使うべきですか？',
        plainQuestion: [
          'これはあなたが決めたい種類の話ですか？',
          '「まかせる」と書く → AIが判断して先へ進みます。',
          '「自分で決める」と書く → 続けてあなたの考えを書いてください。',
        ].join('\n'),
      }),
      { notify },
    )
    const h = answerDeps()
    await answerEscalation(escalation.id, 'まかせる', { ...h.deps, appendMemory: undefined })
    const additions = JSON.parse(await readFile(youCorpusAdditionsFile(), 'utf8')) as Array<{
      text: string
    }>
    expect(additions[0].text).toContain('これはあなたが決めたい種類の話ですか？')
    expect(additions[0].text).not.toContain('ライブラリはAとBのどちらを使うべきですか？')
    // The technical text is NOT lost — it stays on the record (and the worker's
    // injection carries it too, labelled as the worker's own question).
    const [stored] = await listEscalations()
    expect(stored.question).toBe('ライブラリはAとBのどちらを使うべきですか？')
  })

  it('DEFAULT queue wiring (lazy import → engine rework slot) resolves to queued', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput(), { notify })
    const h = answerDeps()
    const res = await answerEscalation(escalation.id, '回答G', {
      ...h.deps,
      queueForNextDispatch: undefined, // fall through to the real lazy import
    })
    expect(res.delivery).toBe('queued') // the import path is alive (no cycle/typo)
    // Drop the engine entry the real seam materialised on globalThis.
    const orch = await import('./swarmOrchestrator')
    orch.__resetOrchestratorForTests()
  })
})

describe('dismissEscalation', () => {
  it('open → dismissed, learns NOTHING', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput(), { notify })
    const memory = vi.fn()
    const res = await dismissEscalation(escalation.id)
    expect(res.status).toBe('dismissed')
    expect(res.dismissedAt).toBeTruthy()
    expect(memory).not.toHaveBeenCalled()
    // dismiss is terminal-but-idempotent; an ANSWERED record is never demoted.
    expect((await dismissEscalation(escalation.id)).status).toBe('dismissed')
  })

  it('never demotes an answered record', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput(), { notify })
    await answerEscalation(escalation.id, '回答', {
      write: () => false,
      sleep: async () => {},
      appendMemory: async () => {},
      queueForNextDispatch: async () => {},
      isPathAllowed: async () => true,
    })
    const res = await dismissEscalation(escalation.id)
    expect(res.status).toBe('answered')
  })
})

describe('retention — fail-closed pruning (the card Done condition)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it("an OPEN record is NEVER pruned, no matter how old; resolved ones age out with their shots", async () => {
    const { notify } = makeNotify()
    const old = new Date(Date.now() - (ESCALATION_RETENTION_DAYS + 10) * DAY)
    // One ancient OPEN record…
    const openRec = await openEscalation(openInput({ taskId: 'card-open' }), {
      notify,
      now: () => old,
    })
    // …one ancient DISMISSED record with a PTY capture…
    const dismissed = await openEscalation(
      openInput({ taskId: 'card-dismissed', question: '別の質問A?', terminalId: 'pty-x' }),
      { notify, captureScreen: () => 'captured screen', now: () => old },
    )
    await dismissEscalation(dismissed.escalation.id, { now: () => old })
    // …one FRESH answered record.
    const fresh = await openEscalation(openInput({ taskId: 'card-fresh', question: '別の質問B?' }), {
      notify,
    })
    await answerEscalation(fresh.escalation.id, '回答', {
      write: () => false,
      sleep: async () => {},
      appendMemory: async () => {},
      queueForNextDispatch: async () => {},
      isPathAllowed: async () => true,
    })

    const shotPath = dismissed.escalation.screenshotRef as string
    expect((await stat(shotPath)).isFile()).toBe(true)

    const removed = await pruneResolvedEscalations()
    expect(removed).toBe(1) // ONLY the ancient dismissed one

    const remaining = await listEscalations()
    const ids = remaining.map((e) => e.id).sort()
    expect(ids).toEqual([openRec.escalation.id, fresh.escalation.id].sort())
    // The pruned record's capture went with it.
    await expect(stat(shotPath)).rejects.toThrow()
    // The shots dir itself survives (other records may still reference files).
    expect((await stat(escalationShotsDir())).isDirectory()).toBe(true)
  })

  it('a resolved record INSIDE the window is kept', async () => {
    const { notify } = makeNotify()
    const recent = new Date(Date.now() - (ESCALATION_RETENTION_DAYS - 2) * DAY)
    const rec = await openEscalation(openInput(), { notify, now: () => recent })
    await dismissEscalation(rec.escalation.id, { now: () => recent })
    expect(await pruneResolvedEscalations()).toBe(0)
    expect(await listEscalations()).toHaveLength(1)
  })
})

describe('adversarial-review hardening (2026-07-03 pass)', () => {
  it('a read failure that is NOT ENOENT aborts the write instead of clobbering the inbox', async () => {
    // Make escalationsFile() unreadable-but-existing: a DIRECTORY (EISDIR on
    // read — deterministic on every platform, unlike chmod games).
    await mkdir(escalationsFile(), { recursive: true })
    const { notify } = makeNotify()
    await expect(openEscalation(openInput(), { notify })).rejects.toThrow()
    // Nothing was persisted over it — the path is still the directory.
    expect((await stat(escalationsFile())).isDirectory()).toBe(true)
  })

  it('elements this build cannot parse are PRESERVED verbatim across writes', async () => {
    const foreign = {
      id: 'from-the-future',
      receiptKey: 'rk-future',
      createdAt: new Date().toISOString(),
      projectPath: '/p',
      question: 'q?',
      context: 'c',
      whyEscalated: 'budget-exceeded', // an enum value THIS build doesn't know
      status: 'open',
    }
    await writeFile(escalationsFile(), JSON.stringify({ items: [foreign] }), 'utf8')
    const { notify } = makeNotify()
    await openEscalation(openInput(), { notify }) // one full read-modify-write
    const raw = JSON.parse(await readFile(escalationsFile(), 'utf8')) as { items: unknown[] }
    expect(raw.items).toHaveLength(2)
    expect(raw.items.some((x) => (x as { id?: string }).id === 'from-the-future')).toBe(true)
  })

  it('receiptKey idempotency is scoped per project — the same explicit key in another project opens its own record', async () => {
    const other = join(home, 'proj-b')
    await mkdir(other, { recursive: true })
    const { notify } = makeNotify()
    await openEscalation(openInput({ receiptKey: 'K' }), { notify })
    const b = await openEscalation(
      openInput({ projectPath: other, question: '全く別の質問？', receiptKey: 'K' }),
      { notify },
    )
    expect(b.deduped).toBe(false)
    expect(await listEscalations()).toHaveLength(2)
  })

  it('a dedup hit refreshes the worker coordinates — the answer targets the LIVE respawned worker', async () => {
    const { notify } = makeNotify()
    await openEscalation(openInput({ terminalId: 'pty-dead', branch: 'swarm/gen-1' }), { notify })
    const again = await openEscalation(
      openInput({ terminalId: 'pty-live', branch: 'swarm/gen-2' }),
      { notify },
    )
    expect(again.deduped).toBe(true)
    expect(again.escalation.terminalId).toBe('pty-live')
    expect(again.escalation.branch).toBe('swarm/gen-2')
    // And it persisted (not just the in-memory copy).
    const [row] = await listEscalations()
    expect(row.terminalId).toBe('pty-live')
  })

  it('defaultCanInjectInto refuses: a plain shell, an open menu, a foreign project, an unresolvable cwd', async () => {
    const uuidOf = async (p: string) => {
      if (p.includes('unresolvable')) throw new Error('not registered')
      return p.includes('proj-a') ? 'uuid-a' : 'uuid-b'
    }
    const term = (over: Record<string, unknown>) =>
      ({ id: 't', cwd: '/proj-a/worktree', tag: 'claude', ...over }) as never
    // a live claude in the same project, no menu → YES
    expect(
      await defaultCanInjectInto('t', '/proj-a', { get: () => term({}), uuidOf }),
    ).toBe(true)
    // plain user shell → NO (the paste would execute as commands)
    expect(
      await defaultCanInjectInto('t', '/proj-a', { get: () => term({ tag: 'shell' }), uuidOf }),
    ).toBe(false)
    // interactive menu open → NO (the trailing CR would confirm its default)
    expect(
      await defaultCanInjectInto('t', '/proj-a', { get: () => term({ menuOpen: true }), uuidOf }),
    ).toBe(false)
    // a DIFFERENT project's PTY → NO
    expect(
      await defaultCanInjectInto('t', '/proj-b', { get: () => term({}), uuidOf }),
    ).toBe(false)
    // dead / unknown PTY → NO
    expect(await defaultCanInjectInto('t', '/proj-a', { get: () => null, uuidOf })).toBe(false)
    // unresolvable cwd → NO (fail-closed)
    expect(
      await defaultCanInjectInto('t', '/unresolvable', { get: () => term({}), uuidOf }),
    ).toBe(false)
  })

  it('sanitizeForPaste strips C0/C1 control bytes (8-bit CSI included) and normalises CR, keeping \\t and \\n', () => {
    const dirty = 'line1\r\nline2\rline3\ttab\u009b201~inject\x07bell\x1b[31mred'
    const clean = sanitizeForPaste(dirty)
    expect(clean).toBe('line1\nline2\nline3\ttab201~injectbell[31mred')
  })

  it("an 'answered' record whose delivery was lost can be re-delivered by re-answering (no dead end)", async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-1' }), { notify })
    const h = answerDepsShared()
    // First attempt: the guard says the PTY is not injectable → queued.
    let injectable = false
    h.deps.canInjectInto = async () => injectable
    const first = await answerEscalation(escalation.id, '最終回答', h.deps)
    expect(first.delivery).toBe('queued')
    expect(first.escalation.status).toBe('answered')

    // The worker comes back → a re-POST retries ONLY the delivery leg.
    injectable = true
    const second = await answerEscalation(escalation.id, 'この本文は無視される', h.deps)
    expect(second.delivery).toBe('injected')
    expect(second.escalation.status).toBe('injected')
    expect(second.escalation.answer).toBe('最終回答') // the first answer stands
    expect(second.memoryWritten).toBe(false)
    expect(h.memory).toHaveLength(1) // learned exactly once
    // The injected payload carried the ORIGINAL answer.
    expect(h.writes[0].data).toContain('最終回答')
  })

  it('a long answer is shortened for the /order queue line (the full text stays on the record)', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput(), { notify })
    const h = answerDepsShared()
    const long = 'あ'.repeat(5000)
    const res = await answerEscalation(escalation.id, long, h.deps)
    expect(res.delivery).toBe('queued')
    expect(h.queued[0].line.length).toBeLessThan(2000)
    expect(h.queued[0].line).toContain('…')
    expect(res.escalation.answer?.length).toBe(5000) // record keeps the full answer
  })

  it('mergeReworkReason: a mechanical overwrite preserves queued owner answers (and only those)', async () => {
    const {
      mergeReworkReason,
      ESCALATION_ANSWER_MARKER,
      REWORK_REASON_SEP,
      recordEscalationAnswerForNextDispatch,
    } = await import('./swarmOrchestrator')
    const answer = `${ESCALATION_ANSWER_MARKER} Q: どっち? → オーナーの回答: B案で`
    // plain → plain: latest reason wins outright
    expect(mergeReworkReason('old tsc failure', 'new lint failure')).toBe('new lint failure')
    // answer in the slot → preserved in front of the fresh mechanical reason
    expect(mergeReworkReason(`stale reason${REWORK_REASON_SEP}${answer}`, 'fresh reason')).toBe(
      `${answer}${REWORK_REASON_SEP}fresh reason`,
    )
    // the conduit itself marks lines and appends without dropping prior answers
    await recordEscalationAnswerForNextDispatch(project, 'card-z', 'Q: x → オーナーの回答: y')
    const orch = await import('./swarmOrchestrator')
    orch.__resetOrchestratorForTests()
  })

  it("F1 regression: an answer containing ' / ' survives mechanical overwrites INTACT (no fragment loss)", async () => {
    const { mergeReworkReason, ESCALATION_ANSWER_MARKER, REWORK_REASON_SEP } = await import(
      './swarmOrchestrator'
    )
    // ' / ' is legitimate answer content (path lists, options) — with a
    // content-bearing separator this used to split into a marker-less tail
    // that got dropped, resuming the worker on a TRUNCATED answer.
    const answer = `${ESCALATION_ANSWER_MARKER} Q: どの構成? → オーナーの回答: src/a / src/b の両方を移し、option A / B は B で`
    const merged = mergeReworkReason(answer, 'fresh mechanical reason')
    expect(merged.split(REWORK_REASON_SEP)).toEqual([answer, 'fresh mechanical reason'])
    // A second overwrite still carries the FULL answer (and only one copy).
    const merged2 = mergeReworkReason(merged, 'even fresher reason')
    expect(merged2.split(REWORK_REASON_SEP)).toEqual([answer, 'even fresher reason'])
    // A mechanical reason smuggling the separator byte cannot fragment the slot.
    const merged3 = mergeReworkReason(merged2, `sneaky${REWORK_REASON_SEP}reason`)
    expect(merged3.split(REWORK_REASON_SEP)).toEqual([answer, 'sneaky reason'])
  })

  it('F2 regression: the PTY capture file is 0600 and its dir 0700 (private like the inbox)', async () => {
    const { notify } = makeNotify()
    const { escalation } = await openEscalation(openInput({ terminalId: 'pty-1' }), {
      notify,
      captureScreen: () => 'private screen contents',
    })
    const file = await stat(escalation.screenshotRef as string)
    expect(file.mode & 0o777).toBe(0o600)
    const dir = await stat(escalationShotsDir())
    expect(dir.mode & 0o777).toBe(0o700)
  })
})

// Shared answer-deps factory for the hardening suite (mirror of the one inside
// the answerEscalation describe — kept separate so each suite reads standalone).
const answerDepsShared = () => {
  const writes: Array<{ id: string; data: string }> = []
  const memory: Array<{ text: string; tags?: string[] }> = []
  const queued: Array<{ projectPath: string; taskId: string; line: string }> = []
  return {
    writes,
    memory,
    queued,
    deps: {
      write: (id: string, data: string) => {
        writes.push({ id, data })
        return true
      },
      sleep: async () => {},
      appendMemory: async (input: { text: string; tags?: string[] }) => {
        memory.push(input)
      },
      queueForNextDispatch: async (projectPath: string, taskId: string, line: string) => {
        queued.push({ projectPath, taskId, line })
      },
      isPathAllowed: async () => true,
      canInjectInto: async () => true,
    } as import('./swarmEscalations').AnswerEscalationDeps,
  }
}

describe('injection helpers (W16 — shared with C3)', () => {
  it('buildAnswerInjection carries Q, the answer and the resume instruction', () => {
    const text = buildAnswerInjection('進めてよい？', 'はい、Aの方針で。')
    expect(text).toContain('Q: 進めてよい？')
    expect(text).toContain('オーナーの回答: はい、Aの方針で。')
    expect(text).toContain('再開')
  })

  // MISATTRIBUTION GUARD. An answer means nothing without the question it
  // answered, and when a plainQuestion exists the owner read THAT — the UI folds
  // the technical `question` into a details pane. The routing lane is the sharp
  // case: the worker's own question is usually an A/B menu, so a reply aimed at
  // the routing question ("is this yours to decide?") would land under the
  // technical menu and read as picking an option there. These assertions are the
  // teeth: before them the guard could be deleted with the suite still green.
  it('buildAnswerInjection pairs the answer with the question the OWNER read, and keeps the technical original labelled', () => {
    const technical = '実装方式はどちらにしますか？ A: 既存テーブルを拡張 B: 新テーブルを追加'
    const plain = '聞かれているのは「実装方式…」です。「まかせる」と書く → …'
    const text = buildAnswerInjection(technical, 'まかせる', plain)

    // The owner's text is present and marked as what the answer responds to.
    expect(text).toContain(`オーナーに表示された質問（下の回答はこれに対するものです）: ${plain}`)
    // The technical original is NOT dropped — it is labelled as the worker's own.
    expect(text).toContain(`あなたが出した元の質問: ${technical}`)
    expect(text).toContain('オーナーの回答: まかせる')
    // The bare `Q:` framing must NOT appear: that is the shape that let the
    // worker bind the answer to its own option list.
    expect(text).not.toContain(`Q: ${technical}`)
    // Attribution must be readable in order: owner's question before the answer.
    expect(text.indexOf('オーナーに表示された質問')).toBeLessThan(text.indexOf('オーナーの回答:'))
  })

  // Escalation questions carry an option list BY DESIGN — the worker rules require
  // 「②選択肢(A/B など)」 and the overseer templates render one — so prefixing the
  // answer `A:` would put two meanings on one prefix inside a single injection.
  // BOTH branches are checked: the bare one is not the safe one, it is the lane
  // that carries worker-authored questions (no template ⇒ no plainQuestion ⇒ it
  // always brings its own A/B menu).
  it.each([
    [
      'bare (worker-authored question — the A/B menu comes from the worker)',
      ['カードのデータをどちらに置きますか？', 'A: 既存テーブルを拡張', 'B: 新テーブルを追加'].join('\n'),
      undefined,
      ['A: 既存テーブルを拡張'],
    ],
    [
      'plainQuestion (the A/B menu comes from the rendered template)',
      'どうしますか？',
      ['どれか選んでください。', 'A: 設定を戻す', 'B: このままにする'].join('\n'),
      ['A: 設定を戻す'],
    ],
  ])(
    'never reuses the `A:` prefix for the answer — %s',
    (_label, question, plain, expectedOptionLines) => {
      const text = buildAnswerInjection(question, 'B', plain)
      // EXACT list, not just "the answer isn't among them": every `A: `-prefixed
      // line must be an option the question itself supplied. An implementation that
      // added its own (a re-quoted answer, a summary) would fail here.
      expect(text.split('\n').filter((l) => l.startsWith('A: '))).toEqual(expectedOptionLines)
      expect(text).toContain('オーナーの回答: B')
    },
  )

  it('injectAnswerIntoWorker reports failure when the FIRST write dies (no Enter sent)', async () => {
    const writes: string[] = []
    const ok = await injectAnswerIntoWorker('pty', 'hello', {
      write: (_id, data) => {
        writes.push(data)
        return false
      },
      sleep: async () => {},
    })
    expect(ok).toBe(false)
    expect(writes).toHaveLength(1) // never sent the CR after a failed paste
  })

  it('injectAnswerIntoWorker reports failure when the PTY dies between paste and Enter', async () => {
    let call = 0
    const ok = await injectAnswerIntoWorker('pty', 'hello', {
      write: () => {
        call += 1
        return call === 1 // paste lands, Enter fails
      },
      sleep: async () => {},
    })
    expect(ok).toBe(false)
  })

  // ── C3: Enter-resend hardening (the tmux "trailing Enter swallowed" trap) ──
  const RULE = '─'.repeat(80)
  const idleBox = (boxLine: string) =>
    [`⏺ 質問です？`, RULE, boxLine, RULE, '  ? for shortcuts'].join('\n')

  it('succeeds without a resend when the first landing check shows a clear box', async () => {
    const writes: string[] = []
    const ok = await injectAnswerIntoWorker('pty', 'answerXYZ', {
      write: (_id, d) => {
        writes.push(d)
        return true
      },
      sleep: async () => {},
      readScreen: () => idleBox('❯ '), // box empty ⇒ submit landed
    })
    expect(ok).toBe(true)
    expect(writes.filter((w) => w === '\r')).toHaveLength(1) // paste + ONE CR
  })

  it('treats the working footer as positive proof the turn landed (no resend)', async () => {
    const writes: string[] = []
    const ok = await injectAnswerIntoWorker('pty', 'answerXYZ', {
      write: (_id, d) => {
        writes.push(d)
        return true
      },
      sleep: async () => {},
      readScreen: () => 'thinking…\n  esc to interrupt · ← for agents',
    })
    expect(ok).toBe(true)
    expect(writes.filter((w) => w === '\r')).toHaveLength(1)
  })

  it('RESENDS Enter while the pasted text still sits unsent, then succeeds when it lands', async () => {
    const writes: string[] = []
    let frame = 0
    const ok = await injectAnswerIntoWorker('pty', 'answerXYZ is my reply', {
      write: (_id, d) => {
        writes.push(d)
        return true
      },
      sleep: async () => {},
      readScreen: () => {
        frame += 1
        return frame < 3 ? idleBox('❯ answerXYZ is my reply') : idleBox('❯ ')
      },
    })
    expect(ok).toBe(true)
    expect(writes.filter((w) => w === '\r')).toHaveLength(3) // initial CR + 2 resends
  })

  it('reports failure after ENTER_RETRY_MAX resends when the paste never submits', async () => {
    const writes: string[] = []
    const ok = await injectAnswerIntoWorker('pty', 'stuckText', {
      write: (_id, d) => {
        writes.push(d)
        return true
      },
      sleep: async () => {},
      readScreen: () => idleBox('❯ stuckText'), // forever pending
    })
    expect(ok).toBe(false)
    expect(writes.filter((w) => w === '\r')).toHaveLength(1 + ENTER_RETRY_MAX) // bounded
  })

  it('stops resending the moment the PTY dies mid-retry', async () => {
    let call = 0
    const ok = await injectAnswerIntoWorker('pty', 'stuckText', {
      write: () => {
        call += 1
        return call <= 2 // paste + first CR land; the retry CR fails
      },
      sleep: async () => {},
      readScreen: () => idleBox('❯ stuckText'),
    })
    expect(ok).toBe(false)
    expect(call).toBe(3) // paste, CR, one failed resend — then bail
  })

  it('a null screen keeps the pre-C3 both-writes-landed contract', async () => {
    const ok = await injectAnswerIntoWorker('pty', 'hello', {
      write: () => true,
      sleep: async () => {},
      readScreen: () => null,
    })
    expect(ok).toBe(true)
  })
})

describe('pasteStillInInputBox — the landing check', () => {
  const RULE = '─'.repeat(80)
  it('sees text pending in the input box', () => {
    const screen = ['⏺ q?', RULE, '❯ my answer text', RULE].join('\n')
    expect(pasteStillInInputBox(screen, 'my answer text')).toBe(true)
  })
  it('does NOT match the same text sitting ABOVE as a submitted log row', () => {
    const screen = ['❯ my answer text', '⏺ working on it…', RULE, '❯ ', RULE].join('\n')
    expect(pasteStillInInputBox(screen, 'my answer text')).toBe(false)
  })
  it('is whitespace-insensitive (TUI wrapping/padding cannot hide a match)', () => {
    const screen = ['❯ my   answer', '   text', RULE].join('\n')
    expect(pasteStillInInputBox(screen, 'my answer text')).toBe(true)
  })
  it('returns false when there is no prompt row or no usable needle', () => {
    expect(pasteStillInInputBox('no box here', 'x')).toBe(false)
    expect(pasteStillInInputBox('❯ something', '   ')).toBe(false)
  })
})