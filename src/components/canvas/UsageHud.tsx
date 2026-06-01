import { useEffect, useReducer, useRef, useState } from 'react'
import type { ClaudeUsage, Settings } from '@/lib/types'
import { api } from '@/lib/api-client'

const POLL_MS = 60_000

// Unofficial per-window token allowances — Anthropic does not publish exact
// numbers, so these are community estimates. Used only to convert raw usage
// into the gauge fill percentage.
const PLAN_LIMITS: Record<NonNullable<Settings['claudePlan']>, number> = {
  pro: 44_000,
  max5x: 220_000,
  max20x: 880_000,
}

interface Props {
  plan: Settings['claudePlan'] | undefined
}

export const UsageHud = ({ plan }: Props) => {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const aborter = useRef<AbortController | null>(null)
  // The visible "リセット 19:30 (1h 20m)" countdown is computed at render
  // time. The usage poll only fires once a minute, but if the user is just
  // watching the HUD, the relative-time label should still tick down. A
  // standalone 30s tick keeps the label fresh without re-hitting the
  // usage endpoint.
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const t = setInterval(() => force(), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      aborter.current?.abort()
      const ac = new AbortController()
      aborter.current = ac
      try {
        const res = await api.api.usage.$get(
          {},
          { init: { cache: 'no-store', signal: ac.signal } },
        )
        const data = (await res.json()) as ClaudeUsage
        if (!cancelled && !('error' in data)) setUsage(data)
      } catch {
        /* keep last value */
      }
    }
    fetchOnce()
    const poll = setInterval(fetchOnce, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(poll)
      aborter.current?.abort()
    }
  }, [])

  // The CLI scrape (parsed from `claude /usage`) is authoritative — it
  // matches what the user sees in Claude's own settings dialog. Use it when
  // available; fall back to the local jsonl estimate for the first ~9s after
  // a cold start while the scrape is in flight.
  const cliSession = usage?.cli?.session ?? null
  const cliWeek = usage?.cli?.weekAll ?? null
  const billable = usage ? usage.tokens.input + usage.tokens.output : 0
  // Default to Max 20× scale when no plan is picked, so the gauge is always
  // useful at a glance. Picking a plan in Settings rescales it precisely.
  const limit = plan ? PLAN_LIMITS[plan] : PLAN_LIMITS.max20x
  const estimatedPct = Math.min(999, Math.round((billable / limit) * 100))
  // Prefer CLI percentage; fall back to local estimate.
  const pct = cliSession?.pct ?? estimatedPct
  const ratio = Math.min(1, pct / 100)
  const model = usage?.currentModel ? shortModel(usage.currentModel) : null
  const sourceLabel = cliSession ? 'CLI' : 'est'

  // Gauge colour mirrors how close we are to the cap.
  const fillTone =
    pct >= 95 ? 'bg-accent' : pct >= 80 ? 'bg-ochre' : 'bg-moss'
  const textTone =
    pct >= 95
      ? 'text-accent'
      : pct >= 80
        ? 'text-ochre'
        : 'text-ink-muted'

  const planSuffix = plan ? '' : ' · scale: Max 5× (pick a plan in Settings)'
  // CLI gives an absolute reset time as a verbatim string ("12:30pm
  // (Asia/Tokyo)") — re-use it directly when we have it; otherwise compute
  // from the local-jsonl 5h window.
  const resetIso = usage?.nextResetAt ?? null
  const resetClock = cliSession?.resetsAt ?? formatTime(resetIso)
  const resetIn = cliSession
    ? formatRelative(parseCliReset(cliSession.resetsAt))
    : formatRelative(resetIso)

  return (
    <div
      className="flex items-center gap-2 text-[11px] tabular-nums tracking-[0.04em] select-none"
      title={[
        cliSession
          ? `Source: claude /usage (refreshed ${formatTime(usage?.cli?.capturedAt ?? null)})`
          : `Source: local jsonl estimate (claude /usage scrape unavailable)`,
        `Session: ${pct}% · resets ${resetClock}${resetIn ? ` (${resetIn})` : ''}`,
        cliWeek
          ? `Week (all models): ${cliWeek.pct}% · resets ${cliWeek.resetsAt}`
          : '',
        `Local tokens: ${formatTokens(billable)} (input + output), plan ${plan ?? 'unset'}${planSuffix}`,
      ]
        .filter(Boolean)
        .join('\n')}
    >
      {model && <span className="text-ink-subtle">{model}</span>}
      <div className="relative h-1.5 w-32 rounded-full bg-line-soft overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 ${fillTone} transition-[width] duration-500 ease-out`}
          style={{ width: `${Math.max(2, ratio * 100)}%` }}
        />
      </div>
      <span className={`${textTone} font-medium`}>{pct}%</span>
      <span className="text-ink-faint">{sourceLabel}</span>
      {resetClock !== '—' && (
        <span className="text-ink-subtle">
          リセット {resetClock}
          {resetIn && <span className="ml-1 text-ink-faint">({resetIn})</span>}
        </span>
      )}
    </div>
  )
}

// e.g. "1h 20m" / "47m" / "30s" — used for the visible reset countdown.
const formatRelative = (iso: string | null): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return `${Math.round(ms / 1000)}s`
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// claude /usage prints resets in two shapes:
//   "12:30pm (Asia/Tokyo)"           — same-day clock time
//   "May 25 at 3pm (Asia/Tokyo)"     — future calendar date
// Convert to an ISO string we can diff against now() for the countdown. Best
// effort: a parse failure just disables the relative label, the clock string
// still shows.
const parseCliReset = (label: string): string | null => {
  const todayClock = label.match(/^(\d{1,2}):?(\d{2})?\s*([ap]m)/i)
  if (todayClock) {
    const now = new Date()
    let hour = Number(todayClock[1])
    const min = todayClock[2] ? Number(todayClock[2]) : 0
    const meridiem = todayClock[3].toLowerCase()
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    const candidate = new Date(now)
    candidate.setHours(hour, min, 0, 0)
    // If the parsed time is already past today, the reset is tomorrow.
    if (candidate.getTime() < now.getTime()) {
      candidate.setDate(candidate.getDate() + 1)
    }
    return candidate.toISOString()
  }
  // Calendar form: rely on JS Date parsing.
  const trimmed = label.replace(/\s*\([^)]+\)\s*$/, '').replace(/\s+at\s+/, ' ')
  const ms = Date.parse(trimmed)
  if (Number.isFinite(ms)) return new Date(ms).toISOString()
  return null
}

const formatTokens = (n: number): string => {
  if (n < 1000) return n.toString()
  if (n < 10_000) return (n / 1000).toFixed(2) + 'k'
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
}

const formatTime = (iso: string | null): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

// "claude-opus-4-7" → "Opus 4.7"; "claude-haiku-4-5-20251001" → "Haiku 4.5"
const shortModel = (m: string): string => {
  const cleaned = m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const parts = cleaned.split('-')
  if (parts.length === 0) return m
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).join('.')
  return version ? `${name} ${version}` : name
}
