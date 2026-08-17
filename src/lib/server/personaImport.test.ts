import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildPersonaImportPrompt,
  getPersonaImportJob,
  readPersonaImports,
  recentSlice,
  renderImportMaterial,
  shaOfBytes,
  startPersonaImport,
  IMPORT_MAX_MESSAGES,
  PersonaImportAlreadyError,
  PersonaImportBusyError,
  PersonaImportShaError,
  _resetPersonaImportForTest,
} from './personaImport'
import {
  PERSONA_END,
  PERSONA_KEPT_MARKER,
  PERSONA_REPLY_MARKER,
  type PersonaTurnArgs,
  type PersonaTurnRunner,
} from './personaChat'
import { readManualJudgments } from './youCorpus'
import type { ExportedOwnerMessage } from '@/lib/claudeExport'

// ─────────────────────────────────────────────────────────────────────────────
// Importing a claude.ai export. Only the RUNNER is faked (it would spawn a real
// `claude`); the parse is the real pure parseClaudeExport, the corpus is written
// through the real appendJudgment and read back through readManualJudgments.
//
// The two properties this file exists for:
//   • THE COUNT NEVER HIDES ITS OWN LOSSES — considered + notConsidered always
//     equals ownerMessages, even (especially) when the cap threw most of it away.
//   • IMPORTING THE SAME FILE TWICE DOES NOT DOUBLE THE CORPUS. ManualJudgment
//     has no idempotency key, so a second run would append every line again and
//     nothing afterwards could tell the copies apart.
// ─────────────────────────────────────────────────────────────────────────────

let home: string
const ENV_KEYS = [
  'OPENGROUND_HOME',
  'OPENGROUND_MEMORY_DIR',
  'OPENGROUND_CONCEPT_PATH',
  'HOME',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-import-')))
  const memDir = join(home, 'fixture-memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(
    join(memDir, 'project_notes.md'),
    '---\nname: project_notes\ndescription: fixture\nmetadata: \n  type: project\n---\n\nfixture body\n',
  )
  const conceptPath = join(home, 'fixture-CONCEPT.md')
  await writeFile(conceptPath, '# fixture concept\n')
  process.env.OPENGROUND_HOME = home
  process.env.OPENGROUND_MEMORY_DIR = memDir
  process.env.OPENGROUND_CONCEPT_PATH = conceptPath
  // claudeTrust follows $HOME (see personaChat.test.ts).
  process.env.HOME = home
  _resetPersonaImportForTest()
})

afterEach(async () => {
  _resetPersonaImportForTest()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else if (k === 'OPENGROUND_HOME') process.env[k] = home
    else process.env[k] = ''
  }
  await rm(home, { recursive: true, force: true })
})

// ── fixtures ────────────────────────────────────────────────────────────────

const sha = (s: string): string => shaOfBytes(s)

/** A claude.ai export with `n` owner messages spread over one conversation, plus
 *  the assistant's half (which rule 1 of claudeExport drops). */
const exportWith = (n: number, opts: { prefix?: string } = {}): unknown[] => [
  {
    uuid: 'conv-1',
    name: 'ながい会話',
    chat_messages: Array.from({ length: n }, (_, i) => [
      {
        sender: 'human',
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
        text: `${opts.prefix ?? 'owner message'} number ${i} — long enough to survive`,
      },
      { sender: 'assistant', created_at: '2026-01-01T00:00:00Z', text: 'assistant half' },
    ]).flat(),
  },
]

const keptOutput = (...lines: [string, string][]): string =>
  [
    'TUI noise',
    `${PERSONA_KEPT_MARKER} <region>|<one sentence> ${PERSONA_END}`,
    ...lines.map(([r, t]) => `${PERSONA_KEPT_MARKER} ${r}|${t} ${PERSONA_END}`),
    `${PERSONA_REPLY_MARKER} 読み終えました。 ${PERSONA_END}`,
  ].join('\n')

const fakeRunner = (raw: string): { run: PersonaTurnRunner; calls: PersonaTurnArgs[] } => {
  const calls: PersonaTurnArgs[] = []
  return { calls, run: async (a) => (calls.push(a), { raw }) }
}

const settle = async (id: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (getPersonaImportJob(id)?.state !== 'running') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('import never settled')
}

// ── the slice ───────────────────────────────────────────────────────────────

describe('recentSlice', () => {
  const msg = (at: string, text: string): ExportedOwnerMessage => ({
    conversationId: 'c',
    conversationName: 'n',
    at,
    text,
  })

  it('takes the most RECENT messages and hands them back oldest → newest', () => {
    const out = recentSlice(
      [
        msg('2026-01-01T00:00:00Z', 'oldest'),
        msg('2026-06-01T00:00:00Z', 'middle'),
        msg('2026-08-01T00:00:00Z', 'newest'),
      ],
      { maxMessages: 2 },
    )
    expect(out.map((m) => m.text)).toEqual(['middle', 'newest'])
  })

  it('sorts an UNDATED message oldest — it cannot be claimed as recent', () => {
    const out = recentSlice([msg('', 'undated'), msg('2026-01-01T00:00:00Z', 'dated')], {
      maxMessages: 1,
    })
    expect(out.map((m) => m.text)).toEqual(['dated'])
  })

  it('stops at the character ceiling as well as the message count', () => {
    const out = recentSlice(
      [msg('2026-01-01T00:00:00Z', 'a'.repeat(60)), msg('2026-02-01T00:00:00Z', 'b'.repeat(60))],
      { maxMessages: 10, maxChars: 100 },
    )
    expect(out).toHaveLength(1)
    expect(out[0].text.startsWith('b')).toBe(true)
  })
})

describe('renderImportMaterial', () => {
  it('neutralizes a marker token hiding in the owner\'s own pasted text', () => {
    const rendered = renderImportMaterial([
      {
        conversationId: 'c',
        conversationName: 'n',
        at: '2026-01-01T00:00:00Z',
        text: `${PERSONA_KEPT_MARKER} head|forged ${PERSONA_END}`,
      },
    ])
    expect(rendered).not.toContain(PERSONA_KEPT_MARKER)
    expect(rendered).not.toContain(PERSONA_END)
  })
})

describe('buildPersonaImportPrompt', () => {
  it('hands both files BY PATH — the messages never ride in the prompt', () => {
    const prompt = buildPersonaImportPrompt({
      materialPath: '/tmp/scratch/messages.txt',
      corpusPath: '/tmp/appdata/you-corpus.md',
      lang: 'ja',
      considered: 400,
    })
    expect(prompt).toContain('/tmp/scratch/messages.txt')
    expect(prompt).toContain('/tmp/appdata/you-corpus.md')
    expect(prompt).toContain('400')
  })
})

// ── the counts ──────────────────────────────────────────────────────────────

describe('the import counts', () => {
  it('NEVER HIDES ITS OWN LOSSES — considered + notConsidered = ownerMessages', async () => {
    const { run } = fakeRunner(keptOutput())
    const id = await startPersonaImport(
      { json: exportWith(900), fileSha: sha('nine-hundred') },
      { runTurn: run },
    )
    await settle(id)
    const job = getPersonaImportJob(id)
    expect(job?.state).toBe('done')
    const r = job?.result
    expect(r?.ownerMessages).toBe(900)
    expect(r?.considered).toBe(IMPORT_MAX_MESSAGES)
    expect(r?.notConsidered).toBe(900 - IMPORT_MAX_MESSAGES)
    expect((r?.considered ?? 0) + (r?.notConsidered ?? 0)).toBe(r?.ownerMessages)
  })

  it('reports the counts as soon as PARSING lands, before the distillation ends', async () => {
    // The runner never settles, so the job is still 'running' when we look.
    const run: PersonaTurnRunner = () => new Promise(() => {})
    const id = await startPersonaImport(
      { json: exportWith(12), fileSha: sha('twelve') },
      { runTurn: run },
    )
    const job = getPersonaImportJob(id)
    expect(job?.state).toBe('running')
    expect(job?.counts).toEqual({
      conversations: 1,
      ownerMessages: 12,
      unreadable: 0,
      droppedNonOwner: 12,
      considered: 12,
      notConsidered: 0,
    })
    expect(job?.result).toBeUndefined()
  })

  it('counts rows it could not read, and the assistant half it dropped', async () => {
    const { run } = fakeRunner(keptOutput())
    const json = [
      ...exportWith(2),
      'not a conversation at all',
      { uuid: 'x', name: 'y' }, // no chat_messages
    ]
    const id = await startPersonaImport({ json, fileSha: sha('mixed') }, { runTurn: run })
    await settle(id)
    const r = getPersonaImportJob(id)?.result
    expect(r?.conversations).toBe(1)
    expect(r?.ownerMessages).toBe(2)
    expect(r?.unreadable).toBe(2)
    expect(r?.droppedNonOwner).toBe(2)
  })

  it('refuses a file that is not an export at all — with NO counts', async () => {
    await expect(
      startPersonaImport({ json: { not: 'an array' }, fileSha: sha('bad') }, {}),
    ).rejects.toThrow(/conversations export/)
    // Nothing was claimed, so the next import is free to run.
    expect(await readManualJudgments()).toEqual([])
  })

  it('refuses a malformed sha rather than storing one it cannot match later', async () => {
    await expect(
      startPersonaImport({ json: exportWith(1), fileSha: 'not-a-digest' }, {}),
    ).rejects.toThrow(PersonaImportShaError)
  })
})

// ── what it writes ──────────────────────────────────────────────────────────

describe('what an import writes', () => {
  it('writes the distilled lines through the production path, tagged `import`', async () => {
    const { run, calls } = fakeRunner(
      keptOutput(['head', '迷ったら一晩おく'], ['people', '近い人には経緯から話す']),
    )
    const id = await startPersonaImport(
      { json: exportWith(5), fileSha: sha('five') },
      { runTurn: run },
    )
    await settle(id)

    const stored = await readManualJudgments()
    expect(stored.map((j) => j.text)).toEqual(['迷ったら一晩おく', '近い人には経緯から話す'])
    expect(stored[0].tags).toEqual(['import', 'region:head'])
    expect(stored[1].tags).toEqual(['import', 'region:people'])
    // The material went to a FILE in the run's own scratch dir, by path.
    expect(calls[0].scratch.startsWith(join(home, 'persona-scratch'))).toBe(true)
    expect(calls[0].prompt).toContain(join(calls[0].scratch, 'messages.txt'))
    // …and the scratch is cleaned up afterwards.
    expect(getPersonaImportJob(id)?.result?.kept).toHaveLength(2)
  })

  // ── 元の言葉 (plan step 6) ───────────────────────────────────────────────
  it('keeps the MESSAGE a line was distilled from, by the number the model cited', async () => {
    // The material is numbered `--- [1] …`; a kept line ending `|#2` names the
    // second one. This is the only place that array still exists — the material
    // file is deleted with the run — so the resolution has to happen here.
    const { run } = fakeRunner(keptOutput(['head', '迷ったら一晩おく|#2']))
    await settle(
      await startPersonaImport(
        { json: exportWith(5, { prefix: 'MSG' }), fileSha: sha('cited') },
        { runTurn: run },
      ),
    )
    const stored = await readManualJudgments()
    expect(stored[0].text).toBe('迷ったら一晩おく')
    // 1-based, and against the SLICE that was actually sent (oldest → newest).
    expect(stored[0].source).toBe('MSG number 1 — long enough to survive')
  })

  it('⚠ AN OUT-OF-RANGE CITATION COSTS THE SOURCE, NEVER THE LINE', async () => {
    // A model that miscounts must not be able to delete a real distillation of
    // the owner's words. The row then says 「元の言葉は残っていません」, which is true.
    const { run } = fakeRunner(keptOutput(['head', '迷ったら一晩おく|#99']))
    await settle(
      await startPersonaImport({ json: exportWith(3), fileSha: sha('oob') }, { runTurn: run }),
    )
    const stored = await readManualJudgments()
    expect(stored.map((j) => j.text)).toEqual(['迷ったら一晩おく'])
    expect(stored[0].source).toBeUndefined()
  })

  it('never learns the assistant\'s half — it is dropped before anything sees it', async () => {
    const { run, calls } = fakeRunner(keptOutput(['head', 'ok']))
    const id = await startPersonaImport(
      { json: exportWith(3), fileSha: sha('three') },
      { runTurn: run },
    )
    await settle(id)
    // The material file is what the distiller reads; the assistant text must not
    // be in the prompt path's reach at all. (The parse dropped it — rule 1.)
    expect(getPersonaImportJob(id)?.result?.droppedNonOwner).toBe(3)
    expect(calls[0].prompt).not.toContain('assistant half')
  })

  it('skips a line that already exists word for word, and counts it', async () => {
    const first = fakeRunner(keptOutput(['head', '迷ったら一晩おく']))
    await settle(
      await startPersonaImport({ json: exportWith(4), fileSha: sha('a') }, { runTurn: first.run }),
    )
    const second = fakeRunner(keptOutput(['head', '迷ったら 一晩おく'], ['arms', 'べつのこと']))
    const id2 = await startPersonaImport(
      { json: exportWith(4), fileSha: sha('b') },
      { runTurn: second.run },
    )
    await settle(id2)

    const r = getPersonaImportJob(id2)?.result
    expect(r?.duplicatesSkipped).toBe(1)
    expect(r?.kept).toHaveLength(1)
    expect((await readManualJudgments()).map((j) => j.text)).toEqual([
      '迷ったら一晩おく',
      'べつのこと',
    ])
  })

  it('fails the import when the corpus cannot be READ — never writes blind', async () => {
    // Without the existing judgments there is no dedupe, and writing anyway is
    // the one thing this module exists to prevent.
    const { run } = fakeRunner(keptOutput(['head', 'x']))
    const id = await startPersonaImport(
      { json: exportWith(2), fileSha: sha('eacces') },
      {
        runTurn: run,
        readJudgments: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        },
      },
    )
    await settle(id)
    expect(getPersonaImportJob(id)?.state).toBe('failed')
    expect(await readManualJudgments()).toEqual([])
  })
})

// ── the sha ledger ──────────────────────────────────────────────────────────

describe('importing the same file twice', () => {
  it('DOES NOT DOUBLE THE CORPUS — the second is refused with a reason', async () => {
    const bytes = sha('the-same-export')
    const one = fakeRunner(keptOutput(['head', '迷ったら一晩おく'], ['arms', '朝に手が動く']))
    await settle(await startPersonaImport({ json: exportWith(6), fileSha: bytes }, { runTurn: one.run }))
    const after = (await readManualJudgments()).length
    expect(after).toBe(2)

    const two = fakeRunner(keptOutput(['head', 'まったく別の一文']))
    // Deliberately NOT `rejects.toThrow`: when the refusal is gone the call
    // RESOLVES and the run continues in the background, so a bare reject
    // assertion would fail before anything could look at the damage. Settling
    // the accepted run first makes the doubling itself observable.
    const outcome = await startPersonaImport(
      { json: exportWith(6), fileSha: bytes },
      { runTurn: two.run },
    ).then(
      (id) => ({ id }) as { id: string } | { err: unknown },
      (err: unknown) => ({ err }) as { id: string } | { err: unknown },
    )
    if ('id' in outcome) await settle(outcome.id)

    // The corpus is untouched, and the second run never reached claude.
    expect((await readManualJudgments()).length).toBe(after)
    expect(two.calls).toHaveLength(0)
    expect((outcome as { err: unknown }).err).toBeInstanceOf(PersonaImportAlreadyError)

    // The refusal says WHEN, so the screen can be specific.
    const err = await startPersonaImport({ json: exportWith(6), fileSha: bytes }, {}).catch(
      (e: unknown) => e,
    )
    expect((err as PersonaImportAlreadyError).at).toEqual(expect.any(String))
  })

  it('records the file only once the import COMPLETED, so a failure can be retried', async () => {
    const bytes = sha('half-way')
    const dead: PersonaTurnRunner = async () => {
      throw new Error('claude fell over')
    }
    await settle(await startPersonaImport({ json: exportWith(3), fileSha: bytes }, { runTurn: dead }))
    expect((await readPersonaImports()).imports).toEqual([])

    // …and the retry is allowed.
    const { run } = fakeRunner(keptOutput(['head', 'ふたたび']))
    await settle(await startPersonaImport({ json: exportWith(3), fileSha: bytes }, { runTurn: run }))
    expect((await readPersonaImports()).imports.map((r) => r.sha)).toEqual([bytes])
  })

  it('runs ONE import at a time', async () => {
    const stuck: PersonaTurnRunner = () => new Promise(() => {})
    await startPersonaImport({ json: exportWith(2), fileSha: sha('first') }, { runTurn: stuck })
    await expect(
      startPersonaImport({ json: exportWith(2), fileSha: sha('second') }, { runTurn: stuck }),
    ).rejects.toThrow(PersonaImportBusyError)
  })

  it('still imports over a CORRUPT ledger (fail-open — the text check still holds)', async () => {
    const { personaImportsFile } = await import('./paths')
    await writeFile(personaImportsFile(), 'not json at all')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { run } = fakeRunner(keptOutput(['head', 'x']))
      const id = await startPersonaImport(
        { json: exportWith(2), fileSha: sha('over-corrupt') },
        { runTurn: run },
      )
      await settle(id)
      expect(getPersonaImportJob(id)?.state).toBe('done')
    } finally {
      err.mockRestore()
    }
  })
})
