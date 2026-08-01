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
  /** The conversation was compacted — its history summarised to make room.
   *
   *  WHY THIS IS DISTILLED AND NOT IGNORED LIKE ITS 'system' SIBLINGS. "What
   *  happens to a long-running desk when its context fills?" was the ONE
   *  unmeasured risk left in the SDK migration, and a commander desk is exactly
   *  the session that runs long enough to find out. The CLI answers it —
   *  `compact_boundary` is in the streamed message union — so the honest fix is
   *  not to assert that auto-compact works but to SHOW each compaction when it
   *  happens, with the token counts that prove it did. An unknown you can watch
   *  is not the same risk as an unknown you cannot. */
  | {
      kind: 'compact'
      /** 'auto' (context filled) or 'manual' (/compact). Left open: the CLI may
       *  add triggers and an unknown one must not be coerced to 'auto'. */
      trigger: 'auto' | 'manual' | (string & {})
      preTokens: number
      /** Absent on some boundaries — null, never 0, so "unknown" and "compacted
       *  to nothing" stay distinguishable. */
      postTokens: number | null
    }

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

    case 'system': {
      // The ONE 'system' subtype worth distilling. Its siblings (init,
      // commands_changed, informational notices …) stay ignored — see below.
      if (m.subtype !== 'compact_boundary') return []
      const md = (m.compact_metadata ?? {}) as Record<string, unknown>
      const pre = md.pre_tokens
      const post = md.post_tokens
      return [
        {
          kind: 'compact',
          trigger: typeof md.trigger === 'string' ? md.trigger : 'auto',
          preTokens: typeof pre === 'number' && Number.isFinite(pre) ? pre : 0,
          postTokens: typeof post === 'number' && Number.isFinite(post) ? post : null,
        },
      ]
    }

    // 'stream_event', hook lifecycle and anything the CLI adds later:
    // deliberately nothing. Status is owned by the session machine
    // (sdkSession.ts), not inferred here.
    default:
      return []
  }
}

/** The status a {@link SdkEvent} implies, or null when it implies nothing.
 *  Kept next to the distiller so "what does this event mean for the machine"
 *  has one answer. `quota_refusal` parks; a turn boundary frees the session. */
/** Does this event PROVE the desk is doing work AT THIS MOMENT?
 *
 *  ⚠ ARRIVAL IS NOT WORK. The SDK stream is not turn-scoped: the CLI keeps
 *  talking between turns — `background_tasks_changed` when a background job it
 *  started ends, `session_state_changed`(state:'idle') AFTER the result flushes,
 *  task notifications, auth-status and rate-limit updates. Every one of those
 *  distils to ZERO events here (they fall through 'system'/default), so a
 *  promotion written as "a message arrived ⇒ working" fires on messages that
 *  prove the opposite. And nothing takes it back: the only routes to 'waiting'
 *  are a turn_end and the park's second boundary, neither of which can happen
 *  when no turn is running — so the desk reads 作業中 until somebody injects a
 *  new turn AND it completes. That is the dead-worker-shows-running failure
 *  inverted: a desk sitting on the owner, never saying so.
 *
 *  ⚠ NOT THE PARK'S EXIT RULE, even though it looks like one. Leaving
 *  'quota-parked' takes a TOOL CALL or a second turn boundary — deliberately
 *  NOT `text`, because the CLI's refusal is emitted as ordinary text too and a
 *  text-based exit un-parks the session on the refusal's own sentence. Here
 *  `text` is correct (an assistant sentence is a turn in flight); there it is
 *  wrong. Do not unify these two predicates. */
export const isWorkEvidence = (ev: SdkEvent): boolean =>
  ev.kind === 'text' ||
  ev.kind === 'thinking' ||
  ev.kind === 'tool_use' ||
  ev.kind === 'tool_result' ||
  ev.kind === 'compact'

export const statusAfter = (ev: SdkEvent): SdkSessionStatus | null => {
  if (ev.kind === 'quota_refusal') return 'quota-parked'
  if (ev.kind === 'turn_end') return 'waiting'
  return null
}
