// ResearchModule — the per-project "Research" tab: a read-only library over
// the research reports a project has accumulated under <project>/docs/research/
// (the /research skill's default placement).
//
// SERVER SEAM: GET /api/research/reports (list, newest first) and
// GET /api/research/report (one file's raw markdown) — server/routes/research.ts
// → src/lib/server/researchReports.ts, which confines every read to
// docs/research/ (strict filename charset + realpath containment). This
// component never writes anything; reports are produced by research-shaped
// Board cards and land here once the work is merged.
//
// SAFETY: the markdown is rendered by the line-based renderer below, which
// builds React NODES — never innerHTML — so a hostile report can only ever
// render as text. Only http(s) URLs become anchors; everything else stays
// inert. No markdown dependency, no dangerouslySetInnerHTML, by design.
//
// (canvas/Markdown.tsx is a SEPARATE mini-renderer — the AI-compiled Doc's,
// whose construct set is pinned by its compile prompt. Deliberately not merged:
// the two surfaces change for different reasons, and a shared renderer would
// repaint the Doc every time a report needs one more construct.)

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BookOpenText,
  ChevronDown,
  ChevronUp,
  MessagesSquare,
  RotateCw,
  Send,
  Sparkles,
  Square,
  Volume2,
} from 'lucide-react'
import { api } from '@/lib/api-client'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import type {
  ProjectMeta,
  ResearchJobStartResponse,
  ResearchJobStateResponse,
  ResearchKnowledgeResponse,
  ResearchReportMeta,
  ResearchReportResponse,
  ResearchReportsResponse,
} from '@/lib/types'

// ─── Markdown, safe by construction ─────────────────────────────────────────
// `[text](https://…)` and bare http(s) URLs. Only http(s) can match, so a
// `javascript:` payload never becomes a clickable href — it stays plain text.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>)\]]+/g

const LINK_CLS = 'break-all text-accent underline underline-offset-2 hover:text-accent-hover'
const INLINE_CODE_CLS = 'rounded-[2px] bg-bg-inset px-1 py-px font-mono text-[0.85em] text-ink'

/** `*italic*` on a plain string. Both edges must be non-space, so `2 * 3 * 4`
 *  stays arithmetic. `_underscores_` are deliberately NOT emphasis: reports
 *  quote identifiers (`user_id`) far more often than they italicise with
 *  underscores, and silently mangling an identifier is the worse failure. */
const italicNodes = (text: string, keyBase: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  Array.from(text.matchAll(/\*(\S(?:[^*]*\S)?)\*/g)).forEach((m, i) => {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    out.push(<em key={`${keyBase}-i${i}`}>{m[1]}</em>)
    last = at + m[0].length
  })
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** `**bold**` first, `*italic*` only in the gaps — that order is what keeps
 *  `**x**` from reading as two empty italics wrapped around an asterisk. */
const emphasisNodes = (text: string, keyBase: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  Array.from(text.matchAll(/\*\*([^*]+)\*\*/g)).forEach((m, i) => {
    const at = m.index ?? 0
    if (at > last) out.push(...italicNodes(text.slice(last, at), `${keyBase}-p${i}`))
    out.push(
      <strong key={`${keyBase}-s${i}`} className="font-semibold text-ink">
        {m[1]}
      </strong>,
    )
    last = at + m[0].length
  })
  if (last < text.length) out.push(...italicNodes(text.slice(last), `${keyBase}-pt`))
  return out
}

/** Links + emphasis on a code-free string. A `[text](url)` label gets the
 *  emphasis pass too, so `[**bold** link](…)` renders whole. */
const linkNodes = (text: string, keyBase: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  // Array.from, not for-of over the iterator: no downlevelIteration in tsconfig.
  Array.from(text.matchAll(LINK_RE)).forEach((m, i) => {
    const at = m.index ?? 0
    if (at > last) out.push(...emphasisNodes(text.slice(last, at), `${keyBase}-t${i}`))
    const href = m[2] ?? m[0]
    out.push(
      <a key={`${keyBase}-a${i}`} href={href} target="_blank" rel="noreferrer" className={LINK_CLS}>
        {m[2] !== undefined ? emphasisNodes(m[1], `${keyBase}-al${i}`) : m[0]}
      </a>,
    )
    last = at + m[0].length
  })
  if (last < text.length) out.push(...emphasisNodes(text.slice(last), `${keyBase}-tt`))
  return out
}

/** Inline pass: `code` spans are lifted out FIRST, so nothing inside a span
 *  can become a link or emphasis — then links, then **bold** / *italic*. */
const inlineNodes = (text: string, keyBase: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  Array.from(text.matchAll(/`([^`\n]+)`/g)).forEach((m, i) => {
    const at = m.index ?? 0
    if (at > last) out.push(...linkNodes(text.slice(last, at), `${keyBase}-x${i}`))
    out.push(
      <code key={`${keyBase}-c${i}`} className={INLINE_CODE_CLS}>
        {m[1]}
      </code>,
    )
    last = at + m[0].length
  })
  if (last < text.length) out.push(...linkNodes(text.slice(last), `${keyBase}-xt`))
  return out
}

// ── tables ──────────────────────────────────────────────────────────────────

/** One pipe-table row → trimmed cells. `\|` is a literal pipe inside a cell. */
const splitRow = (line: string): string[] => {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur.trim())
  return cells
}

/** The `|---|:---:|` line that turns the row above it into a table header.
 *  Requires a pipe, so a bare `---` stays a horizontal rule. */
const isTableSeparator = (line: string): boolean => {
  const t = line.trim()
  if (!t.includes('|') || !t.includes('-')) return false
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t)
}

type CellAlign = 'left' | 'center' | 'right'
const cellAlign = (sep: string): CellAlign =>
  sep.startsWith(':') && sep.endsWith(':') ? 'center' : sep.endsWith(':') ? 'right' : 'left'
const ALIGN_CLS: Record<CellAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

/** Line-based block pass — string in, React nodes out, pure. Blocks: #–######
 *  headings, -/* bullets, `1.` numbered lists, ``` fences, GFM pipe tables,
 *  > quotes, --- rules; anything else is a whitespace-pre-wrap paragraph line. */
export const renderMarkdown = (md: string): ReactNode[] => {
  const out: ReactNode[] = []
  let code: string[] | null = null // non-null ⇔ inside a ``` fence
  let bullets: ReactNode[] = []
  let numbered: ReactNode[] = []
  let quotes: ReactNode[] = []
  const codeCls =
    'overflow-x-auto rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-meta leading-relaxed text-ink'
  // `except` keeps the CURRENT run open: a second bullet must land in the same
  // <ul>, but a bullet after a quote must first close the quote — without this,
  // interleaved runs all flush at the end and the page reorders itself.
  const flushBlocks = (key: string, except?: 'ul' | 'ol' | 'q') => {
    if (except !== 'ul' && bullets.length > 0) {
      out.push(
        <ul key={`ul-${key}`} className="flex list-disc flex-col gap-1 pl-5">
          {bullets}
        </ul>,
      )
      bullets = []
    }
    if (except !== 'ol' && numbered.length > 0) {
      out.push(
        <ol key={`ol-${key}`} className="flex list-decimal flex-col gap-1 pl-6">
          {numbered}
        </ol>,
      )
      numbered = []
    }
    if (except !== 'q' && quotes.length > 0) {
      out.push(
        <blockquote key={`q-${key}`} className="flex flex-col gap-1 border-l-2 border-line-strong pl-3">
          {quotes}
        </blockquote>,
      )
      quotes = []
    }
  }
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const key = `l${i}`
    if (code !== null) {
      if (line.trimStart().startsWith('```')) {
        out.push(<pre key={key} className={codeCls}>{code.join('\n')}</pre>)
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    if (line.trimStart().startsWith('```')) {
      flushBlocks(key)
      code = [] // the fence line itself (incl. any language tag) is dropped
      continue
    }
    // A pipe table: this row + a `|---|` separator right under it. Consumed as
    // ONE block, so the separator row is layout and never text on screen —
    // 「|---|---|」 printing as a paragraph was the owner's actual complaint.
    if (
      line.includes('|') &&
      line.trim() !== '' &&
      !isTableSeparator(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      flushBlocks(key)
      const header = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map(cellAlign)
      const alignCls = (c: number) => ALIGN_CLS[aligns[c] ?? 'left']
      const rows: string[][] = []
      let j = i + 2
      while (
        j < lines.length &&
        lines[j].trim() !== '' &&
        lines[j].includes('|') &&
        !lines[j].trimStart().startsWith('```')
      ) {
        rows.push(splitRow(lines[j]))
        j++
      }
      out.push(
        // Its own scroll container: a wide table must never make the whole
        // reader pan sideways.
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-ui leading-relaxed">
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th
                    key={c}
                    className={`border-b border-line px-3 py-1.5 font-semibold text-ink ${alignCls(c)}`}
                  >
                    {inlineNodes(cell, `${key}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, r) => (
                <tr key={r}>
                  {/* Ragged rows are padded to the HEADER's width — a worker
                   *  that drops a trailing cell should not shift the grid. */}
                  {header.map((_, c) => (
                    <td
                      key={c}
                      className={`border-b border-line-soft px-3 py-1.5 align-top text-ink-muted ${alignCls(c)}`}
                    >
                      {inlineNodes(cells[c] ?? '', `${key}-r${r}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      i = j - 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushBlocks(key)
      const level = heading[1].length
      const cls =
        level === 1
          ? 'mt-2 font-display text-title tracking-tightest text-ink'
          : level === 2
            ? 'mt-2 text-ui font-semibold text-ink'
            : level === 3
              ? 'mt-1 text-ui font-medium text-ink'
              : 'mt-1 text-ui font-medium text-ink-muted'
      out.push(
        level === 1 ? (
          <h1 key={key} className={cls}>{inlineNodes(heading[2], key)}</h1>
        ) : level === 2 ? (
          <h2 key={key} className={cls}>{inlineNodes(heading[2], key)}</h2>
        ) : level === 3 ? (
          <h3 key={key} className={cls}>{inlineNodes(heading[2], key)}</h3>
        ) : (
          <h4 key={key} className={cls}>{inlineNodes(heading[2], key)}</h4>
        ),
      )
      continue
    }
    // ---, ***, ___ alone on a line: a rule. (A table's `|---|` never reaches
    // here — the table branch consumed it, and the separator needs a pipe.)
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushBlocks(key)
      out.push(<hr key={key} className="border-t border-line" />)
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushBlocks(key, 'q')
      if (quote[1].trim() !== '')
        quotes.push(
          <p key={key} className="whitespace-pre-wrap text-ui leading-relaxed text-ink-muted">
            {inlineNodes(quote[1], key)}
          </p>,
        )
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flushBlocks(key, 'ul')
      bullets.push(
        <li key={key} className="text-ui leading-relaxed text-ink">
          {inlineNodes(bullet[1], key)}
        </li>,
      )
      continue
    }
    const num = /^\s*\d{1,4}[.)]\s+(.*)$/.exec(line)
    if (num) {
      flushBlocks(key, 'ol')
      numbered.push(
        <li key={key} className="text-ui leading-relaxed text-ink">
          {inlineNodes(num[1], key)}
        </li>,
      )
      continue
    }
    flushBlocks(key)
    if (line.trim() === '') continue
    out.push(
      <p key={key} className="whitespace-pre-wrap text-ui leading-relaxed text-ink">
        {inlineNodes(line, key)}
      </p>,
    )
  }
  flushBlocks('eof')
  // Unclosed fence at EOF — render what accumulated rather than dropping it.
  if (code !== null) out.push(<pre key="code-eof" className={codeCls}>{code.join('\n')}</pre>)
  return out
}

// ─── The tab ────────────────────────────────────────────────────────────────

export interface ResearchModuleProps {
  /** Same shape the sibling modules receive; only `path` feeds the API. */
  project: ProjectMeta
}

/** A running knowledge job as the CLIENT tracks it: which report it belongs to
 *  (a stale poll result must never paint another report's card) and when it
 *  started (the working line shows honest elapsed seconds). */
interface KnowledgeJob {
  id: string
  file: string
  startedAt: number
}

/** Why the last digest/ask attempt failed — the two claude preflight states get
 *  their own copy (install / sign in), everything else the generic line. */
type KnowledgeFail = 'error' | 'claudeMissing' | 'claudeLoggedOut'

export const ResearchModule = ({ project }: ResearchModuleProps) => {
  const { t, lang } = useT()
  const [reports, setReports] = useState<ResearchReportMeta[]>([])
  // "No research yet" is a CLAIM — only make it once a list read has finished
  // (same rule as PersonaModule's showNotes: never claim empty on a failed or
  // still-pending read).
  const [listLoaded, setListLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [readError, setReadError] = useState(false)
  const [copied, setCopied] = useState(false)
  // ── Knowledge layer (digest + Q&A + read-aloud) — per selected report ──
  // `knowledge === null` means "no successful read yet": the card then CLAIMS
  // nothing (no 「質問はまだありません」 over a failed read — pitch rule).
  const [knowledge, setKnowledge] = useState<ResearchKnowledgeResponse | null>(null)
  const [digestJob, setDigestJob] = useState<KnowledgeJob | null>(null)
  const [digestFail, setDigestFail] = useState<KnowledgeFail | null>(null)
  const [askJob, setAskJob] = useState<KnowledgeJob | null>(null)
  const [askFail, setAskFail] = useState<KnowledgeFail | null>(null)
  const [question, setQuestion] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The Q&A dock sticks to the reader's bottom edge; the owner can fold it
  // away, and it opens by default (owner, 2026-08-18: 「質問はボトムにstickして。
  // あと縮小もできるように。デフォルトは表示」). The choice survives switching
  // reports within one panel session — only the DEFAULT is "open".
  const [qaOpen, setQaOpen] = useState(true)
  // Reports whose digest auto-distill already fired this mount — one attempt
  // per report, so a failure never becomes a silent retry loop.
  const autoDigestTried = useRef<Set<string>>(new Set())
  // The dock's notebook scroller — kept pinned to the newest entry (the list
  // is chronological, chat-style, with the composer right under it).
  const qaListRef = useRef<HTMLDivElement | null>(null)

  const alive = useRef(true)
  // The file the reader is CURRENTLY meant to show — guards a slow response
  // for report A landing after the user already clicked report B.
  const selectedRef = useRef<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (copyTimer.current) clearTimeout(copyTimer.current)
      // Never keep talking after the tab is gone.
      try {
        window.speechSynthesis?.cancel()
      } catch {
        /* no speech engine here — nothing was speaking */
      }
    }
  }, [])

  const loadReports = useCallback(async () => {
    try {
      const res = await api.api.research.reports.$get({ query: { path: project.path } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ResearchReportsResponse
      if (alive.current) setReports(data.reports ?? [])
    } catch {
      /* Keep the last known list (nothing on first load); Reload retries. */
    } finally {
      if (alive.current) setListLoaded(true)
    }
  }, [project.path])

  useEffect(() => {
    void loadReports()
  }, [loadReports])

  const stopSpeech = useCallback(() => {
    try {
      window.speechSynthesis?.cancel()
    } catch {
      /* no speech engine — nothing to stop */
    }
    setSpeaking(false)
  }, [])

  // The report's knowledge sidecar (digest + Q&A + staleness). A failed read
  // leaves `knowledge` as-is (null on a fresh report) so the UI never claims
  // "no questions yet" about a file it could not read.
  const loadKnowledge = useCallback(
    async (file: string) => {
      try {
        const res = await api.api.research.knowledge.$get({
          query: { path: project.path, file },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as ResearchKnowledgeResponse
        if (alive.current && selectedRef.current === file) setKnowledge(data)
      } catch {
        /* keep the current state — the card simply doesn't claim anything */
      }
    },
    [project.path],
  )

  const openReport = useCallback(
    async (file: string) => {
      selectedRef.current = file
      setSelected(file)
      setContent(null)
      setReadError(false)
      setCopied(false)
      // Knowledge is per-report: reset the card and stop any read-aloud. A job
      // started on the previous report keeps running SERVER-side only — the
      // single-flight registry re-attaches if its button is pressed again.
      setKnowledge(null)
      setDigestJob(null)
      setDigestFail(null)
      setAskJob(null)
      setAskFail(null)
      setQuestion('')
      stopSpeech()
      // Read only — opening a report NEVER starts a claude run (pitch non-goal).
      void loadKnowledge(file)
      try {
        const res = await api.api.research.report.$get({
          query: { path: project.path, file },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as ResearchReportResponse
        if (!alive.current || selectedRef.current !== file) return
        setContent(data.content)
      } catch {
        if (alive.current && selectedRef.current === file) setReadError(true)
      }
    },
    [project.path, loadKnowledge, stopSpeech],
  )

  // EXPLICIT distill button. 503 carries the claude preflight discriminant so
  // the copy can say "install" vs "sign in" instead of a generic failure.
  const startDigest = useCallback(async () => {
    if (selected === null || digestJob !== null) return
    const file = selected
    setDigestFail(null)
    try {
      const res = await api.api.research.digest.$post({
        json: { path: project.path, file },
      })
      if (!alive.current || selectedRef.current !== file) return
      if (res.status === 503) {
        const body = (await res.json().catch(() => ({}))) as {
          claudeMissing?: boolean
          claudeLoggedOut?: boolean
        }
        setDigestFail(
          body.claudeMissing ? 'claudeMissing' : body.claudeLoggedOut ? 'claudeLoggedOut' : 'error',
        )
        return
      }
      if (res.status !== 202) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ResearchJobStartResponse
      setDigestJob({ id: data.jobId, file, startedAt: Date.now() })
    } catch {
      if (alive.current && selectedRef.current === file) setDigestFail('error')
    }
  }, [selected, digestJob, project.path])

  // The question stays in the input until the answer lands — a failed ask must
  // be retryable without retyping (research.qa.retry).
  const submitAsk = useCallback(async () => {
    const q = question.trim()
    if (selected === null || askJob !== null || q === '') return
    const file = selected
    setAskFail(null)
    try {
      const res = await api.api.research.ask.$post({
        json: { path: project.path, file, question: q },
      })
      if (!alive.current || selectedRef.current !== file) return
      if (res.status === 503) {
        const body = (await res.json().catch(() => ({}))) as {
          claudeMissing?: boolean
          claudeLoggedOut?: boolean
        }
        setAskFail(
          body.claudeMissing ? 'claudeMissing' : body.claudeLoggedOut ? 'claudeLoggedOut' : 'error',
        )
        return
      }
      if (res.status !== 202) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ResearchJobStartResponse
      setAskJob({ id: data.jobId, file, startedAt: Date.now() })
    } catch {
      if (alive.current && selectedRef.current === file) setAskFail('error')
    }
  }, [selected, askJob, question, project.path])

  const copyMarkdown = useCallback(() => {
    if (content === null) return
    try {
      navigator.clipboard
        .writeText(content)
        .then(() => {
          if (!alive.current) return
          setCopied(true)
          if (copyTimer.current) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => {
            if (alive.current) setCopied(false)
          }, 2000)
        })
        .catch(() => {
          /* Clipboard unavailable — silent no-op; the text stays on screen. */
        })
    } catch {
      /* navigator.clipboard missing entirely — same silent no-op. */
    }
  }, [content])

  // Poll one knowledge job (1.5s cadence, same as the describe poll). On any
  // terminal state the result is ALREADY persisted server-side, so the settle
  // path re-reads the sidecar. 404 = swept/unknown (dev server reloaded):
  // whatever finished is in the sidecar — re-read and stop, claiming nothing.
  const pollKnowledgeJob = useCallback(
    async (jobId: string, settle: (outcome: 'done' | 'error' | 'gone') => void): Promise<void> => {
      try {
        const res = await fetch(`/api/research/job/${encodeURIComponent(jobId)}`)
        if (res.status === 404) {
          settle('gone')
          return
        }
        if (!res.ok) return
        const state = (await res.json()) as ResearchJobStateResponse
        if (state.status === 'running') return
        settle(state.status === 'done' ? 'done' : 'error')
      } catch {
        /* transient (server reloading) — keep polling */
      }
    },
    [],
  )

  useEffect(() => {
    const job = digestJob
    if (job === null) return
    let cancelled = false
    let inFlight = false
    let settled = false
    const settle = (outcome: 'done' | 'error' | 'gone') => {
      if (cancelled || settled) return
      settled = true
      setDigestJob((prev) => (prev?.id === job.id ? null : prev))
      if (outcome === 'error') {
        if (selectedRef.current === job.file) setDigestFail('error')
      } else {
        void loadKnowledge(job.file)
      }
    }
    const tick = async () => {
      if (inFlight || cancelled || settled) return
      inFlight = true
      try {
        await pollKnowledgeJob(job.id, settle)
      } finally {
        inFlight = false
      }
    }
    void tick()
    const intervalId = window.setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
    // Keyed on the id: (id, file, startedAt) are set together and immutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digestJob?.id])

  useEffect(() => {
    const job = askJob
    if (job === null) return
    let cancelled = false
    let inFlight = false
    let settled = false
    const settle = (outcome: 'done' | 'error' | 'gone') => {
      if (cancelled || settled) return
      settled = true
      setAskJob((prev) => (prev?.id === job.id ? null : prev))
      if (outcome === 'error') {
        if (selectedRef.current === job.file) setAskFail('error')
      } else {
        // Clear the input only on an explicit 'done' — a swept job's outcome is
        // unknown, so the question stays retryable.
        if (outcome === 'done') setQuestion('')
        void loadKnowledge(job.file)
      }
    }
    const tick = async () => {
      if (inFlight || cancelled || settled) return
      inFlight = true
      try {
        await pollKnowledgeJob(job.id, settle)
      } finally {
        inFlight = false
      }
    }
    void tick()
    const intervalId = window.setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askJob?.id])

  // One shared 1s ticker drives the 「… {seconds}秒」 working lines.
  useEffect(() => {
    if (digestJob === null && askJob === null) return
    setNowMs(Date.now())
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [digestJob, askJob])
  const elapsedSec = (startedAt: number) => Math.max(0, Math.floor((nowMs - startedAt) / 1000))

  // Auto-distill on open (owner, 2026-08-18: 「要点はデフォルトでだしておこう」 —
  // amends the pitch's explicit-button-only non-goal). Fires ONLY when the open
  // report's knowledge read SUCCEEDED and holds no digest — so a stale digest is
  // never regenerated without the owner pressing 作り直す, an unreadable sidecar
  // never triggers a run, and one attempt per report per mount means a failure
  // (claude missing / signed out / error) never becomes a retry loop.
  useEffect(() => {
    if (selected === null || content === null || knowledge === null) return
    if (knowledge.file !== selected || knowledge.digest || digestJob !== null) return
    if (autoDigestTried.current.has(selected)) return
    autoDigestTried.current.add(selected)
    void startDigest()
  }, [selected, content, knowledge, digestJob, startDigest])

  // Keep the notebook pinned to its newest entry whenever one lands (or the
  // dock re-opens) — the list scrolls internally, the composer stays put.
  const qaCount = knowledge?.qa.length ?? 0
  useEffect(() => {
    const el = qaListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [qaCount, qaOpen, selected])

  // Read the digest aloud with the OS speech engine — the pitch's deliberate
  // NotebookLM-not: no generated audio show, no network, just the essence
  // spoken. Pressing again stops.
  const speakDigest = useCallback(() => {
    const digest = knowledge?.digest
    const synth = window.speechSynthesis
    if (!digest || !synth || typeof window.SpeechSynthesisUtterance !== 'function') return
    if (speaking) {
      stopSpeech()
      return
    }
    const u = new window.SpeechSynthesisUtterance([digest.tldr, ...digest.points].join('\n'))
    u.lang = digest.lang === 'ja' ? 'ja-JP' : 'en-US'
    u.onend = () => {
      if (alive.current) setSpeaking(false)
    }
    u.onerror = () => {
      if (alive.current) setSpeaking(false)
    }
    synth.cancel() // never queue behind a leftover utterance
    synth.speak(u)
    setSpeaking(true)
  }, [knowledge, speaking, stopSpeech])

  const failText = (f: KnowledgeFail, generic: string): string =>
    f === 'claudeMissing'
      ? t('research.knowledge.claudeMissing')
      : f === 'claudeLoggedOut'
        ? t('research.knowledge.claudeLoggedOut')
        : generic

  const dateOf = (mtime: number) =>
    new Date(mtime).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US')

  // Empty library: say what this tab is and how to feed it, instead of a bare
  // blank split view.
  if (listLoaded && reports.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[560px] flex-col gap-3 px-8 py-10">
          <div className="flex items-center gap-2 text-ink">
            <BookOpenText size={14} strokeWidth={2} />
            <h2 className="font-display text-title tracking-tightest">
              {t('research.empty.title')}
            </h2>
          </div>
          <p className="text-ui leading-relaxed text-ink-muted">{t('research.empty.how')}</p>
          <p className="text-ui leading-relaxed text-ink-subtle">
            {t('research.empty.channels')}
          </p>
          <div>
            <Btn variant="ghost" size="sm" onClick={() => void loadReports()}>
              <RotateCw size={11} strokeWidth={2.25} />
              {t('research.reload')}
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left: the report list (as served — newest first). */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h3 className="label-cap text-ink-faint">{t('research.list.heading')}</h3>
          <Btn variant="subtle" size="xs" onClick={() => void loadReports()}>
            <RotateCw size={11} strokeWidth={2.25} />
            {t('research.reload')}
          </Btn>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {reports.map((r) => (
            <button
              key={r.file}
              type="button"
              onClick={() => void openReport(r.file)}
              className={`flex w-full flex-col items-start gap-0.5 border-b border-line-soft px-4 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                selected === r.file
                  ? 'bg-plane text-ink'
                  : 'text-ink-muted hover:bg-plane hover:text-ink'
              }`}
            >
              <span className="w-full truncate text-ui" title={r.title}>
                {r.title}
              </span>
              <span className="text-meta text-ink-faint">{dateOf(r.mtime)}</span>
            </button>
          ))}
        </div>
      </aside>
      {/* Right: the reader. */}
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <div className="px-8 py-6 text-ui text-ink-subtle">{t('research.select')}</div>
          ) : readError ? (
            <div className="px-8 py-6 text-ui text-ink-subtle">{t('research.loadError')}</div>
          ) : content === null ? null : (
            <div className="mx-auto flex max-w-[720px] flex-col gap-3 px-8 py-6">
              {/* ── The knowledge card: 30 seconds of essence BEFORE the wall of
                   text (owner, 2026-08-18: 「文字が多くて読む気が失せる」). The
                   distill starts on its own for a report that has none yet. ── */}
              <section className="flex flex-col gap-2 rounded-[4px] border border-line bg-plane px-4 py-3 shadow-card">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="label-cap flex items-center gap-1.5 text-ink-faint">
                    <Sparkles size={12} strokeWidth={2} className="text-accent" />
                    {t('research.digest.heading')}
                  </h3>
                  {knowledge?.digest && digestJob === null && (
                    <div className="flex items-center gap-1">
                      <Btn variant="subtle" size="xs" onClick={speakDigest}>
                        {speaking ? (
                          <Square size={11} strokeWidth={2.25} />
                        ) : (
                          <Volume2 size={11} strokeWidth={2.25} />
                        )}
                        {t(speaking ? 'research.digest.speakStop' : 'research.digest.speak')}
                      </Btn>
                      <Btn variant="subtle" size="xs" onClick={() => void startDigest()}>
                        <RotateCw size={11} strokeWidth={2.25} />
                        {t('research.digest.remake')}
                      </Btn>
                    </div>
                  )}
                </div>
                {knowledge?.digest && (
                  <>
                    {/* The one sentence gets the house display face — it is the
                        card's reason to exist, so it reads like a headline. */}
                    <p className="font-display text-[1.0625rem] font-medium leading-relaxed text-ink">
                      {knowledge.digest.tldr}
                    </p>
                    <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-faint">
                      {knowledge.digest.points.map((point, i) => (
                        <li key={i} className="text-ui leading-relaxed text-ink">
                          {point}
                        </li>
                      ))}
                    </ul>
                    {knowledge.digestStale && (
                      <p role="note" className="text-meta leading-snug text-amber-500/90">
                        {t('research.digest.stale')}
                      </p>
                    )}
                    <p className="text-meta leading-snug text-ink-faint">
                      {t('research.digest.note')}
                    </p>
                  </>
                )}
                {digestJob !== null ? (
                  <p className="flex items-center gap-1.5 text-ui text-ink-subtle">
                    <Sparkles size={12} strokeWidth={2} className="animate-pulse text-accent" />
                    {t('research.digest.working', { seconds: elapsedSec(digestJob.startedAt) })}
                  </p>
                ) : (
                  <>
                    {digestFail !== null && (
                      <p className="text-ui text-error">
                        {failText(digestFail, t('research.digest.failed'))}
                      </p>
                    )}
                    {!knowledge?.digest && (
                      <div>
                        <Btn variant="ghost" size="sm" onClick={() => void startDigest()}>
                          <Sparkles size={11} strokeWidth={2.25} />
                          {t(
                            digestFail === 'error' ? 'research.digest.retry' : 'research.digest.make',
                          )}
                        </Btn>
                      </div>
                    )}
                  </>
                )}
              </section>
              {/* ── The full report — untouched, below the essence. ── */}
              <div className="mt-1 flex items-center justify-between gap-2 border-b border-line pb-1.5">
                <h3 className="label-cap text-ink-faint">{t('research.fulltext')}</h3>
                <Btn variant="ghost" size="xs" onClick={copyMarkdown}>
                  {t(copied ? 'research.copied' : 'research.copy')}
                </Btn>
              </div>
              <div className="flex flex-col gap-2.5">{renderMarkdown(content)}</div>
            </div>
          )}
        </div>
        {/* ── Q&A dock — pinned to the reader's bottom edge, foldable, open by
             default (owner, 2026-08-18). The notebook scrolls inside it,
             chat-style: chronological entries, composer underneath. ── */}
        {selected !== null && !readError && content !== null && (
          <section className="shrink-0 border-t border-line bg-plane">
            <div className="mx-auto w-full max-w-[720px] px-8 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="label-cap flex items-center gap-1.5 text-ink-faint">
                  <MessagesSquare size={12} strokeWidth={2} />
                  {t('research.qa.heading')}
                  {knowledge !== null && knowledge.qa.length > 0 && (
                    <span className="rounded-full bg-bg-inset px-1.5 py-px text-micro tabular-nums text-ink-faint">
                      {knowledge.qa.length}
                    </span>
                  )}
                </h3>
                <Btn
                  variant="icon"
                  size="xs"
                  onClick={() => setQaOpen((v) => !v)}
                  aria-label={t(qaOpen ? 'research.qa.collapse' : 'research.qa.expand')}
                >
                  {qaOpen ? (
                    <ChevronDown size={13} strokeWidth={2.25} />
                  ) : (
                    <ChevronUp size={13} strokeWidth={2.25} />
                  )}
                </Btn>
              </div>
              {qaOpen && (
                <div className="flex flex-col gap-2 pt-2">
                  {knowledge !== null && knowledge.qa.length > 0 && (
                    <div ref={qaListRef} className="flex max-h-[38vh] flex-col overflow-y-auto">
                      {knowledge.qa.map((entry, i) => (
                        <div
                          key={`${entry.at}-${i}`}
                          className="flex flex-col gap-1 border-t border-line-soft py-2 first:border-t-0 first:pt-0 last:pb-0"
                        >
                          <p className="text-ui font-medium leading-relaxed text-ink">{entry.q}</p>
                          <p className="whitespace-pre-wrap text-ui leading-relaxed text-ink-muted">
                            {entry.a}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  {knowledge !== null &&
                    knowledge.qa.length === 0 &&
                    askJob === null &&
                    askFail === null && (
                      <p className="text-meta text-ink-subtle">{t('research.qa.empty')}</p>
                    )}
                  {askJob !== null && (
                    <p className="flex items-center gap-1.5 text-ui text-ink-subtle">
                      <MessagesSquare
                        size={12}
                        strokeWidth={2}
                        className="animate-pulse text-accent"
                      />
                      {t('research.qa.working', { seconds: elapsedSec(askJob.startedAt) })}
                    </p>
                  )}
                  {askJob === null && askFail !== null && (
                    <div className="flex items-center gap-2">
                      <p className="text-ui text-error">
                        {failText(askFail, t('research.qa.failed'))}
                      </p>
                      {askFail === 'error' && (
                        <Btn variant="subtle" size="xs" onClick={() => void submitAsk()}>
                          {t('research.qa.retry')}
                        </Btn>
                      )}
                    </div>
                  )}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      void submitAsk()
                    }}
                    className="flex items-center gap-1.5 rounded-[8px] border border-line bg-bg-inset py-1.5 pl-3 pr-1.5 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-card-active"
                  >
                    <input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder={t('research.qa.placeholder')}
                      maxLength={500}
                      disabled={askJob !== null}
                      className="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
                    />
                    <button
                      type="submit"
                      disabled={askJob !== null || question.trim() === ''}
                      aria-label={t('research.qa.placeholder')}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-[6px] bg-accent text-bg-card shadow-card transition-colors hover:bg-accent-hover active:bg-accent-deeper disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Send size={13} strokeWidth={2.25} />
                    </button>
                  </form>
                </div>
              )}
            </div>
          </section>
        )}
      </section>
    </div>
  )
}
