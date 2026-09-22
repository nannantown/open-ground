// Guards for scripts/trending-cost-scan.ts — the free-only classifier.
//
// WHY THIS FILE EXISTS, precisely. The owner's rule is "only tools that are free
// to use" (2026-09-22). The first implementation of that filter was a grep for
// "API key", and it was measured WRONG on two of the twenty-two candidates in
// the same sitting:
//
//   • JuliusBrussee/caveman says "One command, no account, no API key." The grep
//     counted two hits and reported it as needing a key — rejecting a free tool.
//   • destructive_command_guard's hits are deny-patterns that PROTECT keys
//     ("API key deletion", "rotating API keys"). Same false rejection.
//
// And in the other direction, colbymchenry/codegraph's README carries `$0.54`,
// `$2.43` … which are the AGENT's token costs in a benchmark table, not a price.
// A "$" detector calls that a paid product and rejects a tool that states "No
// API keys. No external services."
//
// So a cost filter is not a word count: wrong in one direction it throws away
// the free tool, wrong in the other it recommends the paid one, and both look
// like a confident answer. Every case below is one of those traps, taken from
// the real READMEs, and each was measured RED against a mutated classifier
// before being kept.

import { describe, it, expect } from 'vitest'
import { classifyCostSignals, detectLicense, freeVerdict } from '../../scripts/trending-cost-scan'

describe('classifyCostSignals — the key question', () => {
  it('reads "no account, no API key" as NOT needing a key (the caveman trap)', () => {
    const s = classifyCostSignals('⚡ **One command, no account, no API key.** `npx skills add x -g`')
    expect(s.needsKey).toBe('no')
    expect(s.evidence.join('\n')).toContain('no API key')
  })

  it('does NOT read deny-patterns that PROTECT keys as needing one (the dcg trap)', () => {
    const s = classifyCostSignals(
      '- `email.sendgrid` - Protects against destructive SendGrid API operations like template deletion, API key deletion, and domain authentication removal.\n' +
        '- `payment.stripe` - … deleting customers, or rotating API keys without coordination.',
    )
    expect(s.needsKey).toBe('unclear')
    expect(s.paidTier).toEqual([])
  })

  it('reads an actual credential assignment as needing a key', () => {
    expect(classifyCostSignals('export OPENAI_API_KEY=sk-...').needsKey).toBe('yes')
    expect(classifyCostSignals('  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \\').needsKey).toBe('yes')
  })

  it('reads "you need an OpenAI API key" as needing a key (the claude-context trap)', () => {
    const s = classifyCostSignals('You need an OpenAI API key for the embedding model. You can get one by signing up.')
    expect(s.needsKey).toBe('yes')
  })

  it('lets an explicit no-key claim beat a later OPTIONAL credential example', () => {
    // caveman and ruflo both do this: "no API key" for the default path, then a
    // provider table further down. Reading the last match wins gets both wrong.
    const s = classifyCostSignals(
      'One command, no account, no API key.\n\n## Advanced\nFor other providers: export OPENAI_API_KEY=sk-...',
    )
    expect(s.needsKey).toBe('no')
  })
})

describe('classifyCostSignals — running on a subscription instead of a key', () => {
  it('spots the local-CLI provider (the SkillSpector finding)', () => {
    const s = classifyCostSignals('# Local Claude CLI — no API key; uses your existing `claude auth login` session')
    expect(s.subscriptionOk).toBe(true)
    expect(s.needsKey).toBe('no')
  })

  it('spots delegation to the caller\'s own agent (the open-code-review finding)', () => {
    const s = classifyCostSignals(
      '- [Delegation Mode](https://x/docs/delegate) — your coding agent runs the review using its own LLM; no OCR API key required',
    )
    expect(s.subscriptionOk).toBe(true)
    expect(s.needsKey).toBe('no')
  })

  it('spots "works with your subscriptions on …" (the t3code finding)', () => {
    const s = classifyCostSignals('Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode.')
    expect(s.subscriptionOk).toBe(true)
  })
})

describe('classifyCostSignals — prices versus numbers that merely have a $', () => {
  it('does NOT call a benchmark cost table a paid tier (the codegraph trap)', () => {
    const s = classifyCostSignals(
      '| **VS Code** | Time / Tools / Tokens / Cost | 58s / 2 / 155k / $0.53 | 2m 10s / 28 / 670k / $1.80 |\n' +
        '| **Excalidraw** | … | 45s / 2 / 156k / $0.54 | 2m 42s / 43 / 991k / $2.43 |',
    )
    expect(s.paidTier).toEqual([])
  })

  it('does catch a real recurring price (the ECC trap)', () => {
    const s = classifyCostSignals('Install free · Private repos from $19/seat/mo')
    expect(s.paidTier).toEqual(['$19/seat/mo'])
  })

  it('catches the per-month and per-year spellings too', () => {
    expect(classifyCostSignals('TradingView Premium $60/month').paidTier).toEqual(['$60/month'])
    expect(classifyCostSignals('Bloomberg Terminal $2,400 per year').paidTier).toEqual(['$2,400 per year'])
  })

  it('reports each price once even when repeated', () => {
    expect(classifyCostSignals('$19/seat/mo … later again $19/seat/mo').paidTier).toEqual(['$19/seat/mo'])
  })
})

describe('classifyCostSignals — local-only claims and evidence', () => {
  it('spots the local-only claim', () => {
    expect(classifyCostSignals('| **100% Local** | No data leaves your machine.').localOnly).toBe(true)
    expect(classifyCostSignals('No Neo4j required, no server, runs entirely locally.').localOnly).toBe(true)
  })

  it('never asserts a verdict without a quote behind it', () => {
    const s = classifyCostSignals('A perfectly ordinary README with nothing to say about money.')
    expect(s).toMatchObject({ needsKey: 'unclear', subscriptionOk: false, localOnly: false, paidTier: [] })
    expect(s.evidence).toEqual([])
  })

  it('reads prose out of HTML markup rather than being defeated by it', () => {
    // Markup INSIDE the phrase, which is how real READMEs write it (<sub>, <b>,
    // <br/> between words). An earlier version of this case put the tags only
    // AROUND the phrase — measured GREEN with stripping removed (mutant C8,
    // 2026-09-22), i.e. it proved nothing, because `\bno account\b` matches
    // straight through a neighbouring tag. This spelling does not.
    const s = classifyCostSignals('<p align="center">One command, no <em>API key</em> needed.</p>')
    expect(s.needsKey).toBe('no')
  })
})

describe('freeVerdict', () => {
  const sig = (over: Partial<ReturnType<typeof classifyCostSignals>> = {}) => ({
    needsKey: 'unclear' as const,
    subscriptionOk: false,
    paidTier: [] as string[],
    localOnly: false,
    evidence: [] as string[],
    ...over,
  })

  it('is "free" only when the licence is known AND no key is needed', () => {
    expect(freeVerdict({ license: 'MIT', signals: sig({ needsKey: 'no' }) })).toBe('free')
  })

  it('is "cost?" when a price or a required key is present — even under MIT', () => {
    expect(freeVerdict({ license: 'MIT', signals: sig({ paidTier: ['$19/seat/mo'] }) })).toBe('cost?')
    expect(freeVerdict({ license: 'MIT', signals: sig({ needsKey: 'yes' }) })).toBe('cost?')
  })

  it('is "free?" — never "free" — when the licence could not be read', () => {
    expect(freeVerdict({ license: null, signals: sig({ needsKey: 'no' }) })).toBe('free?')
  })

  it('is "free?" when the README says nothing either way', () => {
    expect(freeVerdict({ license: 'Apache-2.0', signals: sig() })).toBe('free?')
  })

  it('is "unknown" when there was no README to read at all', () => {
    expect(freeVerdict({ license: 'MIT', signals: null })).toBe('unknown')
  })
})

describe('detectLicense', () => {
  it('names the licences that decide whether we may use it', () => {
    expect(detectLicense('MIT License\n\nCopyright (c) 2026')).toBe('MIT')
    expect(detectLicense('                                 Apache License\n                        Version 2.0')).toBe('Apache-2.0')
    expect(detectLicense('Elastic License 2.0\n\nAcceptance')).toBe('Elastic-2.0')
    expect(detectLicense('Business Source License 1.1')).toBe('BSL-1.1')
    expect(detectLicense('GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3')).toBe('AGPL')
  })

  it('prefers AGPL over the GPL substring inside it', () => {
    // "GNU AFFERO GENERAL PUBLIC LICENSE" contains no literal "GNU GENERAL
    // PUBLIC LICENSE", but the AGPL text quotes the GPL further down — so the
    // order of the table, not just its contents, is load-bearing.
    const agpl = 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n' + 'x'.repeat(200) + '\nGNU GENERAL PUBLIC LICENSE'
    expect(detectLicense(agpl)).toBe('AGPL')
  })

  it('returns null instead of guessing', () => {
    expect(detectLicense('All rights reserved. Contact sales for terms.')).toBeNull()
    expect(detectLicense('')).toBeNull()
  })

  it('reads the MIT grant sentence when the header is missing', () => {
    expect(detectLicense('Permission is hereby granted, free of charge, to any person obtaining a copy')).toBe('MIT')
  })
})
