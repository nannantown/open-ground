/**
 * you-corpus — CLI for the proxy's externalised JUDGMENT AXIS ("あなたの判断軸").
 *
 * Run via `npm run you-corpus <cmd>` (tsx). Works offline (no running server),
 * so it can be used to refresh + read the corpus at proxy bootstrap.
 *
 *   npm run you-corpus status                  # path + source counts (default)
 *   npm run you-corpus rebuild                 # re-assemble from all sources
 *   npm run you-corpus append "<判断>" [--tags a,b] [--context "…"]
 *   npm run you-corpus print                   # full corpus → stdout (for injection)
 *   npm run you-corpus path                    # just the file path
 *
 * The corpus is PERSONAL and lives only under ~/.openground — never git-shared.
 */
import {
  assembleYouCorpus,
  appendJudgment,
  readYouCorpus,
  getCorpusStatus,
} from '../src/lib/server/youCorpus'
import { youCorpusFile } from '../src/lib/server/paths'

// `print` streams the whole (large) corpus to stdout, so a downstream reader
// that closes early — `you-corpus print | head`, or a proxy launcher that stops
// reading — raises EPIPE on the write side. That is the normal end of a pipe,
// not an error: exit quietly instead of crashing with an unhandled 'error'
// event (the standard Node idiom for a pipe-friendly CLI).
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

// Minimal flag parser: pulls `--tags a,b` and `--context "…"` out, returns the
// remaining positionals.
const parse = (argv: string[]): { positionals: string[]; tags?: string[]; context?: string } => {
  const positionals: string[] = []
  let tags: string[] | undefined
  let context: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tags') {
      tags = (argv[++i] ?? '').split(',').map((t) => t.trim()).filter(Boolean)
    } else if (a === '--context') {
      context = argv[++i] ?? ''
    } else {
      positionals.push(a)
    }
  }
  return { positionals, tags, context }
}

const main = async (): Promise<void> => {
  const [cmd = 'status', ...rest] = process.argv.slice(2)
  const { positionals, tags, context } = parse(rest)

  switch (cmd) {
    case 'status': {
      const s = await getCorpusStatus()
      console.log(`you-corpus: ${s.path}`)
      console.log(`  assembled: ${s.exists ? s.assembledAt : '(not yet — run `rebuild`)'}`)
      console.log(`  size: ${s.sizeBytes} bytes`)
      console.log(`  auto-memory: ${s.memoryCount}${s.memoryDirExists ? '' : ' (dir not found)'}`)
      console.log(`    dir: ${s.memoryDir ?? '(unresolved)'}`)
      console.log(`  CONCEPT.md: ${s.conceptExists ? '✓' : '–'} (${s.conceptPath ?? '?'})`)
      console.log(`  business_model_vision: ${s.businessVisionExists ? '✓' : '–'}`)
      console.log(`  hand-added judgments: ${s.manualCount}`)
      break
    }
    case 'rebuild': {
      const m = await assembleYouCorpus()
      console.log(`rebuilt ${m.path}`)
      console.log(
        `  ${m.sizeBytes} bytes · auto-memory ${m.memoryCount} · manual ${m.manualCount} · ` +
          `CONCEPT ${m.conceptIncluded ? '✓' : '–'} · business_vision ${m.businessVisionIncluded ? '✓' : '–'}`,
      )
      break
    }
    case 'append': {
      const text = positionals.join(' ').trim()
      if (!text) {
        console.error('usage: npm run you-corpus append "<判断>" [--tags a,b] [--context "…"]')
        process.exitCode = 1
        return
      }
      const { judgment, meta } = await appendJudgment({ text, tags, context })
      console.log(`added judgment ${judgment.id}`)
      console.log(`  "${judgment.text}"`)
      if (judgment.tags?.length) console.log(`  tags: ${judgment.tags.join(', ')}`)
      console.log(`  → ${meta.path} (${meta.manualCount} hand-added, ${meta.sizeBytes} bytes)`)
      break
    }
    case 'print':
    case 'cat': {
      process.stdout.write(await readYouCorpus())
      break
    }
    case 'path': {
      console.log(youCorpusFile())
      break
    }
    default: {
      console.error(`unknown command: ${cmd}`)
      console.error('commands: status | rebuild | append | print | path')
      process.exitCode = 1
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
