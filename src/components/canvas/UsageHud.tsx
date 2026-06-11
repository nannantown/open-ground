import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { RotateCcw, RefreshCw } from 'lucide-react'
import type { ClaudeUsage } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'

const POLL_MS = 60_000

export const UsageHud = () => {
  const { t } = useT()
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const aborter = useRef<AbortController | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // Re-render every 30s so the relative "resets in" / "updated" labels tick.
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const id = setInterval(() => force(), 30_000)
    return () => clearInterval(id)
  }, [])

  const fetchUsage = useCallback(async (forceScrape = false) => {
    aborter.current?.abort()
    const ac = new AbortController()
    aborter.current = ac
    try {
      const res = await fetch(forceScrape ? '/api/usage?refresh=1' : '/api/usage', {
        cache: 'no-store',
        signal: ac.signal,
      })
      const data = (await res.json()) as ClaudeUsage
      if (!('error' in data)) setUsage(data)
    } catch {
      /* keep last value */
    }
  }, [])

  useEffect(() => {
    fetchUsage()
    const poll = setInterval(() => fetchUsage(), POLL_MS)
    return () => {
      clearInterval(poll)
      aborter.current?.abort()
    }
  }, [fetchUsage])

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const refresh = async () => {
    setRefreshing(true)
    await fetchUsage(true)
    setRefreshing(false)
  }

  // Headline % is the CLI scrape ONLY (accurate). The local estimate is rough
  // for Claude Code, so it lives only in the hover tooltip.
  const cliSession = usage?.cli?.session ?? null
  const cliWeek = usage?.cli?.weekAll ?? null
  const pct = cliSession?.pct ?? null
  const ratio = pct != null ? Math.min(1, pct / 100) : 0
  const model = usage?.currentModel ? shortModel(usage.currentModel) : null

  const fillTone =
    pct == null ? 'bg-line-strong' : pct >= 95 ? 'bg-accent' : pct >= 80 ? 'bg-ochre' : 'bg-moss'
  const textTone =
    pct == null
      ? 'text-ink-faint'
      : pct >= 95
        ? 'text-accent'
        : pct >= 80
          ? 'text-ochre'
          : 'text-ink-muted'

  const resetClock = cliSession?.resetsAt ?? null
  const resetClockShort = resetClock ? resetClock.replace(/\s*\([^)]*\)\s*$/, '') : ''
  const resetRel = cliSession ? formatRelative(parseCliReset(cliSession.resetsAt)) : ''
  const resetRelOk = resetRel && resetRel !== 'now' ? resetRel : ''
  // Reset TIME on the chip: prefer the absolute clock ("7:20 pm"), since that's
  // the "when"; the popover carries the relative countdown too.
  const chipReset = resetClockShort || resetRelOk
  const ago = formatAgo(usage?.cli?.capturedAt ?? null, t)

  const tooltip = [
    cliSession ? t('misc.usage.live') : t('misc.usage.waiting'),
    pct != null && resetClock ? `${pct}% · ${t('misc.usage.resetsAt', { time: resetClock })}` : '',
    cliWeek ? `${t('misc.usage.week')}: ${cliWeek.pct}%` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={tooltip}
        aria-label={t('misc.usage.heading')}
        className="flex items-center gap-2 rounded-[3px] px-2 py-1 text-[11px] tabular-nums tracking-[0.04em] select-none transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {model && <span className="hidden md:inline text-ink-subtle">{model}</span>}
        <div className="relative h-1.5 w-24 rounded-full bg-line-soft overflow-hidden">
          <div
            className={`absolute inset-y-0 left-0 ${fillTone} transition-[width] duration-500 ease-out`}
            style={{ width: `${pct != null ? Math.max(2, ratio * 100) : 0}%` }}
          />
        </div>
        <span className={`${textTone} font-medium`}>{pct != null ? `${pct}%` : '—'}</span>
        {chipReset && (
          /* Narrow window: drop the reset clock from the chip (still in the
             tooltip and the popover) so the gauge + % always fit. */
          <span className="hidden sm:inline-flex items-center gap-1 whitespace-nowrap text-ink-subtle">
            <RotateCcw size={10} strokeWidth={1.75} className="text-ink-faint shrink-0" />
            {chipReset}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-[264px] rounded-[3px] border border-line bg-bg-card p-3.5 text-ink shadow-card-hover">
          <div className="mb-2.5 flex items-baseline justify-between">
            <p className="label-cap text-ink-muted">{t('misc.usage.heading')}</p>
            {model && <span className="text-[11px] text-ink-subtle">{model}</span>}
          </div>

          {pct != null ? (
            <>
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] text-ink-muted">{t('misc.usage.session')}</span>
                <span className={`text-[16px] font-medium tabular-nums ${textTone}`}>{pct}%</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-line-soft overflow-hidden">
                <div className={`h-full ${fillTone}`} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
              </div>
              {(resetClockShort || resetRelOk) && (
                <p className="mt-2 text-[11px] text-ink-subtle">
                  {resetClockShort && t('misc.usage.resetsAt', { time: resetClockShort })}
                  {resetRelOk && (
                    <span className="text-ink-faint"> · {t('misc.usage.resetsIn', { rel: resetRelOk })}</span>
                  )}
                </p>
              )}
              {cliWeek && (
                <div className="mt-3 flex items-baseline justify-between border-t border-line-soft pt-2.5">
                  <span className="text-[12px] text-ink-muted">{t('misc.usage.week')}</span>
                  <span className="text-[12px] tabular-nums text-ink">{cliWeek.pct}%</span>
                </div>
              )}
            </>
          ) : (
            <p className="text-[12px] leading-relaxed text-ink-subtle">{t('misc.usage.waiting')}</p>
          )}

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-soft pt-2.5">
            <span className="min-w-0 truncate text-[10px] text-ink-faint">
              {ago ? t('misc.usage.updated', { ago }) : ''}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[2px] border border-line px-2 py-1 label-cap text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink hover:border-line-strong disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
              {t('misc.usage.refresh')}
            </button>
          </div>
          {pct != null && (
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">{t('misc.usage.live')}</p>
          )}
        </div>
      )}
    </div>
  )
}

// "1h 20m" / "47m" / "30s" — future countdown for the reset.
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

// "just now" / "2m ago" / "3h ago" — how stale the displayed scrape is.
const formatAgo = (iso: string | null, t: (k: string, v?: Record<string, string | number>) => string): string => {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return t('misc.usage.justNow')
  if (min < 60) return t('misc.usage.minAgo', { n: min })
  return t('misc.usage.hourAgo', { n: Math.floor(min / 60) })
}

// claude /usage prints resets as "12:30pm (Asia/Tokyo)" or "May 25 at 3pm
// (Asia/Tokyo)". Convert to ISO for the countdown; parse failure → no relative.
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
    if (candidate.getTime() < now.getTime()) candidate.setDate(candidate.getDate() + 1)
    return candidate.toISOString()
  }
  const trimmed = label.replace(/\s*\([^)]+\)\s*$/, '').replace(/\s+at\s+/, ' ')
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// "claude-opus-4-8" → "Opus 4.8"; "claude-haiku-4-5-20251001" → "Haiku 4.5"
const shortModel = (m: string): string => {
  const cleaned = m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const parts = cleaned.split('-')
  if (parts.length === 0) return m
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).join('.')
  return version ? `${name} ${version}` : name
}
