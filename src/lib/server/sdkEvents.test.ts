import { describe, it, expect } from 'vitest'
import { distillSdkMessage, matchesQuotaRefusal, statusAfter, type SdkEvent } from './sdkEvents'

// The real list, as exported by the SDK (12 entries, verified importable at
// runtime — migration plan appendix B-5). Imported rather than hand-copied on
// purpose: a private mirror of Anthropic's wording is the thing this module
// exists to stop maintaining.
import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'

const P = USAGE_LIMIT_ERROR_PREFIXES

const kinds = (evs: SdkEvent[]) => evs.map((e) => e.kind)

describe('matchesQuotaRefusal', () => {
  it('matches the CLI refusal wording actually observed in the wild', () => {
    // Captured from ~/.claude/projects (158 occurrences) — the exact line
    // ownerDeskLimit/swarmRateLimitText hunt for on screen today.
    expect(
      matchesQuotaRefusal(
        "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
        P,
      ),
    ).toBe(true)
    expect(matchesQuotaRefusal("You've hit your session limit · resets 3pm (Asia/Tokyo)", P)).toBe(true)
  })

  it('does NOT match the assistant merely QUOTING a refusal — the whole point', () => {
    // This shape is the commander's daily work (swarmRateLimitText.ts:401) and
    // the one false-positive class the screen model could not exclude.
    expect(
      matchesQuotaRefusal(
        `worker-2 is stuck, here is what its screen says: You've reached your Fable 5 limit.`,
        P,
      ),
    ).toBe(false)
  })

  it('is whitespace- and case-tolerant but still anchored at the start', () => {
    expect(matchesQuotaRefusal("  you've   HIT your weekly limit · resets 3pm", P)).toBe(true)
    expect(matchesQuotaRefusal('', P)).toBe(false)
  })
})

describe('distillSdkMessage — assistant', () => {
  it('splits text / thinking / tool_use, counting thinking rather than carrying it', () => {
    const evs = distillSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'x'.repeat(42) },
            { type: 'text', text: 'hello there   ' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/foo.ts' } },
          ],
        },
      },
      P,
    )
    expect(kinds(evs)).toEqual(['thinking', 'text', 'tool_use'])
    expect(evs[0]).toMatchObject({ kind: 'thinking', chars: 42 })
    expect(evs[1]).toMatchObject({ kind: 'text', text: 'hello there' })
    // Rendered by transcript.summarizeInput so the PTY transcript view and this
    // one spell a tool call the same way.
    expect(evs[2]).toMatchObject({ kind: 'tool_use', name: 'Edit', detail: 'b/foo.ts' })
  })

  it('flags sub-agent output via parent_tool_use_id', () => {
    const evs = distillSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { content: [{ type: 'text', text: 'from the sub-agent' }] },
      },
      P,
    )
    expect(evs[0]).toMatchObject({ kind: 'text', fromSubagent: true })
  })

  it('emits quota_refusal ALONGSIDE the text when the CLI refuses', () => {
    const evs = distillSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: "You've reached your Fable 5 limit. Run /usage-credits" }],
        },
      },
      P,
    )
    expect(kinds(evs)).toEqual(['quota_refusal', 'text'])
  })

  it('does NOT emit quota_refusal when the model is quoting one', () => {
    const evs = distillSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `the worker said: You've reached your Fable 5 limit.` }],
        },
      },
      P,
    )
    expect(kinds(evs)).toEqual(['text'])
  })
})

describe('distillSdkMessage — tool results', () => {
  it('reports ok/error and a one-line head', () => {
    const evs = distillSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', is_error: true, content: 'boom\n  happened\there' }],
        },
      },
      P,
    )
    expect(evs[0]).toMatchObject({ kind: 'tool_result', ok: false, head: 'boom happened here' })
  })

  it('flattens an array content payload', () => {
    const evs = distillSdkMessage(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          ],
        },
      },
      P,
    )
    expect(evs[0]).toMatchObject({ kind: 'tool_result', ok: true, head: 'a b' })
  })
})

describe('distillSdkMessage — result', () => {
  it('reads terminal_reason, NOT subtype (subtype says success on a real error)', () => {
    // Measured 2026-07-30: a genuine API error reports subtype:'success' with
    // is_error:true and terminal_reason:'api_error'.
    const evs = distillSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 404,
        result: "There's an issue with the selected model (bogus).",
      },
      P,
    )
    expect(kinds(evs)).toEqual(['api_error', 'turn_end'])
    expect(evs[0]).toMatchObject({ kind: 'api_error', status: 404 })
    expect(evs[1]).toMatchObject({ kind: 'turn_end', reason: 'api_error', isError: true })
  })

  it('classifies an api_error whose text IS a quota refusal as quota_refusal', () => {
    const evs = distillSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        result: "You've reached your Fable 5 limit. Run /usage-credits to continue.",
      },
      P,
    )
    expect(kinds(evs)).toEqual(['quota_refusal', 'turn_end'])
  })

  it('surfaces an interrupt as turn_end aborted_streaming, not as an error class', () => {
    const evs = distillSdkMessage(
      { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' },
      P,
    )
    expect(kinds(evs)).toEqual(['turn_end'])
    expect(evs[0]).toMatchObject({ reason: 'aborted_streaming' })
  })

  it('carries usage on a completed turn', () => {
    const evs = distillSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        terminal_reason: 'completed',
        total_cost_usd: 0.2,
        usage: {
          input_tokens: 2,
          output_tokens: 4,
          cache_read_input_tokens: 15498,
          cache_creation_input_tokens: 19614,
        },
      },
      P,
    )
    expect(evs[0]).toMatchObject({
      kind: 'turn_end',
      reason: 'completed',
      usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 15498, cacheCreationTokens: 19614, costUsd: 0.2 },
    })
  })

  it('defaults an ABSENT terminal_reason to completed rather than guessing', () => {
    const evs = distillSdkMessage({ type: 'result', subtype: 'success' }, P)
    expect(evs[0]).toMatchObject({ kind: 'turn_end', reason: 'completed', isError: false })
  })
})

describe('distillSdkMessage — rate limit', () => {
  it('reports utilization BEFORE any refusal (the channel the PTY path never had)', () => {
    const evs = distillSdkMessage(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1785736800,
          rateLimitType: 'seven_day',
          utilization: 0.55,
        },
      },
      P,
    )
    expect(evs[0]).toMatchObject({
      kind: 'rate_limit',
      utilization: 0.55,
      resetsAt: 1785736800,
      limitType: 'seven_day',
    })
  })

  it('drops an event with no utilization rather than inventing 0', () => {
    expect(distillSdkMessage({ type: 'rate_limit_event', rate_limit_info: {} }, P)).toEqual([])
  })
})

describe('distillSdkMessage — the unknown', () => {
  it('yields NOTHING for message types it does not model, never folding them into a neighbour', () => {
    // claudeScreen trap ④, restated for the stream era: a table that absorbs
    // rows it does not know is how "API Error: 529 Overloaded" went from
    // harmless to fatal — the real line got folded into the notice above it.
    expect(distillSdkMessage({ type: 'system', subtype: 'init', session_id: 'x' }, P)).toEqual([])
    expect(distillSdkMessage({ type: 'some_future_event', payload: 1 }, P)).toEqual([])
    expect(distillSdkMessage(null, P)).toEqual([])
    expect(distillSdkMessage({ nope: true }, P)).toEqual([])
  })
})

describe('compact_boundary (the context-fills answer)', () => {
  // "What happens to a long-running desk when its context fills?" was the last
  // unmeasured risk in the SDK migration — and a commander desk is exactly the
  // session long enough to find out. The CLI answers it in the stream, so the
  // distiller must not swallow it with its 'system' siblings: an unknown you can
  // watch is a different risk from an unknown you cannot.
  const boundary = (md: Record<string, unknown>) => ({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: md,
    uuid: 'u',
    session_id: 's',
  })

  it('an automatic compaction carries the before/after token counts', () => {
    expect(
      distillSdkMessage(boundary({ trigger: 'auto', pre_tokens: 128_000, post_tokens: 31_500 }), P),
    ).toEqual([{ kind: 'compact', trigger: 'auto', preTokens: 128_000, postTokens: 31_500 }])
  })

  it('a manual /compact is distinguishable from an automatic one', () => {
    expect(distillSdkMessage(boundary({ trigger: 'manual', pre_tokens: 90_000 }), P)).toEqual([
      // post_tokens absent ⇒ null, NOT 0 — "unknown" and "compacted to nothing"
      // must not read the same.
      { kind: 'compact', trigger: 'manual', preTokens: 90_000, postTokens: null },
    ])
  })

  it('an unknown trigger is carried verbatim, never coerced to auto', () => {
    expect(distillSdkMessage(boundary({ trigger: 'future_thing', pre_tokens: 1 }), P)[0]).toMatchObject({
      trigger: 'future_thing',
    })
  })

  it('a malformed boundary still reports the compaction (the FACT outranks the numbers)', () => {
    // Losing the counts is cosmetic; losing "history was summarised" leaves the
    // reader wondering why the desk forgot.
    expect(distillSdkMessage(boundary({}), P)).toEqual([
      { kind: 'compact', trigger: 'auto', preTokens: 0, postTokens: null },
    ])
    expect(distillSdkMessage({ type: 'system', subtype: 'compact_boundary' }, P)).toHaveLength(1)
    expect(
      distillSdkMessage(boundary({ pre_tokens: 'lots', post_tokens: Number.NaN }), P),
    ).toEqual([{ kind: 'compact', trigger: 'auto', preTokens: 0, postTokens: null }])
  })

  it("its 'system' siblings are still ignored", () => {
    expect(distillSdkMessage({ type: 'system', subtype: 'init', session_id: 'x' }, P)).toEqual([])
    expect(distillSdkMessage({ type: 'system', subtype: 'commands_changed' }, P)).toEqual([])
    expect(distillSdkMessage({ type: 'system' }, P)).toEqual([])
  })

  it('compaction says nothing about the session status', () => {
    // It is bookkeeping inside a turn, not a lifecycle transition — treating it
    // as one would free a session that is still mid-work.
    expect(statusAfter({ kind: 'compact', trigger: 'auto', preTokens: 1, postTokens: 1 })).toBeNull()
  })
})

describe('statusAfter', () => {
  it('parks on a refusal and frees on a turn boundary', () => {
    expect(statusAfter({ kind: 'quota_refusal', raw: 'x' })).toBe('quota-parked')
    expect(statusAfter({ kind: 'turn_end', reason: 'completed', isError: false })).toBe('waiting')
  })

  it('implies nothing for ordinary content', () => {
    expect(statusAfter({ kind: 'text', text: 'hi' })).toBeNull()
    expect(statusAfter({ kind: 'rate_limit', utilization: 0.5, resetsAt: null, limitType: 'seven_day' })).toBeNull()
  })
})
