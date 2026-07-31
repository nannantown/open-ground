// sdkEvents — the ANATOMY of an Agent SDK message stream, in one place.
//
// This is the SDK-side counterpart of `@/lib/claudeScreen`, and it exists for
// the same reason that file gives: when three consumers each grow their own
// idea of what a message means, one of them grows a wrong one. claudeScreen
// records what that cost — a private re-implementation of the frame model got
// the position rule wrong "in the expensive direction", and the sensor went
// silent on the exact event it exists for. So the distillation lives HERE,
// once, and the SSE feed, the worker classifier and the consumption tally all
// read the SAME {@link SdkEvent}s.
//
// The structural advantage over screen scraping is the whole point of the
// migration: "the CLI said this" and "the assistant quoted that" are different
// message shapes here, not two readings of the same pixels.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §3.3.

import { summarizeInput } from './transcript'

/** Why a turn ended. Mirrors the CLI's `result.terminal_reason`, left open
 *  because the CLI may add reasons and an unknown one must not be coerced. */
export type SdkTerminalReason = 'completed' | 'aborted_streaming' | 'api_error' | (string & {})

export type SdkSessionStatus =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'quota-parked'
  | 'exited'
  | 'failed'

export interface SdkTurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
}

export type SdkEvent =
  /** A lifecycle transition (see the state machine in the migration plan §6). */
  | { kind: 'status'; status: SdkSessionStatus; detail?: string }
  /** Assistant prose. `fromSubagent` marks text forwarded from a sub-agent. */
  | { kind: 'text'; text: string; fromSubagent?: boolean }
  /** Thinking is COUNTED, never carried: the UI shows "thought N chars" and the
   *  engine does not reason about its content. */
  | { kind: 'thinking'; chars: number; fromSubagent?: boolean }
  | { kind: 'tool_use'; name: string; detail: string; fromSubagent?: boolean }
  | { kind: 'tool_result'; ok: boolean; head: string; fromSubagent?: boolean }
  | { kind: 'turn_end'; reason: SdkTerminalReason; isError: boolean; usage?: SdkTurnUsage }
  /** The pre-refusal warning channel the PTY path never had: utilization arrives
   *  BEFORE the wall, so the engine can cool a tier proactively. */
  | { kind: 'rate_limit'; utilization: number; resetsAt: number | null; limitType: string }
  | { kind: 'api_error'; status: number | null; head: string }
  /** The CLI's own "you've hit your limit" — matched against the SDK's exported
   *  prefix list, never a private copy of the wording. */
  | { kind: 'quota_refusal'; raw: string }

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Case-insensitive prefix match against the CLI's own refusal vocabulary.
 *
 *  ⚠ THE PREFIX LIST IS NOT OURS. It is `USAGE_LIMIT_ERROR_PREFIXES`, exported
 *  by the SDK and verified importable at runtime (12 entries, measured
 *  2026-07-30 — migration plan appendix B-5). Do not inline a copy: the whole
 *  reason quota detection moves here is to stop maintaining a private mirror of
 *  Anthropic's wording, which is exactly what swarmRateLimitText had to do.
 *  Callers pass the list in so this stays a pure function. */
export const matchesQuotaRefusal = (text: string, prefixes: readonly string[]): boolean => {
  const t = oneLine(text).toLowerCase()
  if (!t) return false
  return prefixes.some((p) => t.startsWith(oneLine(p).toLowerCase()))
}

const usageOf = (raw: unknown): SdkTurnUsage | undefined => {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage
  if (!u || typeof u !== 'object') return undefined
  const num = (k: string): number => {
    const v = (u as Record<string, unknown>)[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const costRaw = (raw as { total_cost_usd?: unknown }).total_cost_usd
  return {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
    cacheCreationTokens: num('cache_creation_input_tokens'),
    costUsd: typeof costRaw === 'number' && Number.isFinite(costRaw) ? costRaw : null,
  }
}

/** Distil ONE raw SDK message into zero or more {@link SdkEvent}s.
 *
 *  Zero is a normal outcome (a message type we deliberately ignore) — but note
 *  the asymmetry that matters: an UNRECOGNISED message must yield nothing
 *  rather than being folded into a neighbouring event. claudeScreen's trap ④ is
 *  the same lesson from the screen era: a table that folds rows it does not
 *  know turns "API Error: 529 Overloaded" from harmless into fatal, because the
 *  real line gets absorbed into the notice above it.
 *
 *  @param msg      one message from the SDK's async iterator
 *  @param prefixes the SDK's USAGE_LIMIT_ERROR_PREFIXES (injected — see above) */
export const distillSdkMessage = (msg: unknown, prefixes: readonly string[]): SdkEvent[] => {
  const m = msg as Record<string, any> | null
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return []
  const out: SdkEvent[] = []

  switch (m.type) {
    case 'assistant': {
      const fromSubagent = Boolean(m.parent_tool_use_id)
      const blocks = m.message?.content
      if (!Array.isArray(blocks)) return []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          // A refusal the CLI emits arrives as ordinary assistant text; the
          // prefix list is what separates it from the assistant merely
          // discussing a limit.
          if (matchesQuotaRefusal(b.text, prefixes)) {
            out.push({ kind: 'quota_refusal', raw: oneLine(b.text) })
          }
          out.push({ kind: 'text', text: b.text.replace(/\s+$/, ''), ...(fromSubagent ? { fromSubagent } : {}) })
        } else if (b.type === 'thinking') {
          out.push({
            kind: 'thinking',
            chars: typeof b.thinking === 'string' ? b.thinking.length : 0,
            ...(fromSubagent ? { fromSubagent } : {}),
          })
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          out.push({
            kind: 'tool_use',
            name: b.name,
            detail: summarizeInput(b.name, b.input),
            ...(fromSubagent ? { fromSubagent } : {}),
          })
        }
      }
      return out
    }

    case 'user': {
      const fromSubagent = Boolean(m.parent_tool_use_id)
      const blocks = m.message?.content
      if (!Array.isArray(blocks)) return []
      for (const b of blocks) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue
        let content: unknown = b.content
        if (Array.isArray(content)) {
          content = content
            .filter((c: any) => c?.type === 'text')
            .map((c: any) => c.text)
            .join(' ')
        }
        out.push({
          kind: 'tool_result',
          ok: !b.is_error,
          head: truncate(oneLine(String(content ?? '')), 160),
          ...(fromSubagent ? { fromSubagent } : {}),
        })
      }
      return out
    }

    case 'rate_limit_event': {
      const info = m.rate_limit_info ?? {}
      const util = typeof info.utilization === 'number' ? info.utilization : null
      if (util === null) return []
      return [
        {
          kind: 'rate_limit',
          utilization: util,
          resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
          limitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown',
        },
      ]
    }

    case 'result': {
      // ⚠ `subtype` LIES. A genuine API error still reports subtype 'success'
      // (measured 2026-07-30 — SDK_CLIENT_INVESTIGATION §3-A). `terminal_reason`
      // is the field that separates completed / aborted_streaming / api_error.
      const reason: SdkTerminalReason =
        typeof m.terminal_reason === 'string' ? m.terminal_reason : 'completed'
      const resultText = typeof m.result === 'string' ? m.result : ''

      if (reason === 'api_error') {
        if (resultText && matchesQuotaRefusal(resultText, prefixes)) {
          out.push({ kind: 'quota_refusal', raw: oneLine(resultText) })
        } else {
          out.push({
            kind: 'api_error',
            status: typeof m.api_error_status === 'number' ? m.api_error_status : null,
            head: truncate(oneLine(resultText), 200),
          })
        }
      }
      out.push({
        kind: 'turn_end',
        reason,
        isError: Boolean(m.is_error),
        ...(usageOf(m) ? { usage: usageOf(m) } : {}),
      })
      return out
    }

    // 'system' (init and friends), 'stream_event', hook lifecycle and anything
    // the CLI adds later: deliberately nothing. Status is owned by the session
    // machine (sdkSession.ts), not inferred here.
    default:
      return []
  }
}

/** The status a {@link SdkEvent} implies, or null when it implies nothing.
 *  Kept next to the distiller so "what does this event mean for the machine"
 *  has one answer. `quota_refusal` parks; a turn boundary frees the session. */
export const statusAfter = (ev: SdkEvent): SdkSessionStatus | null => {
  if (ev.kind === 'quota_refusal') return 'quota-parked'
  if (ev.kind === 'turn_end') return 'waiting'
  return null
}
