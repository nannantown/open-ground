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
// SAFETY: the markdown is rendered by the small line-based renderer below,
// which builds React NODES — never innerHTML — so a hostile report can only
// ever render as text. Only http(s) URLs become anchors; everything else stays
// inert. No markdown dependency, no dangerouslySetInnerHTML, by design.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpenText, RotateCw } from 'lucide-react'
import { api } from '@/lib/api-client'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import type {
  ProjectMeta,
  ResearchReportMeta,
  ResearchReportResponse,
  ResearchReportsResponse,
} from '@/lib/types'

// ─── Markdown, safe by construction ─────────────────────────────────────────
// `[text](https://…)` and bare http(s) URLs. Only http(s) can match, so a
// `javascript:` payload never becomes a clickable href — it stays plain text.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>)\]]+/g

const LINK_CLS = 'break-all text-accent underline underline-offset-2 hover:text-accent-hover'

/** Inline pass: split a line into plain strings and <a> nodes. */
const inlineNodes = (text: string, keyBase: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  // Array.from, not for-of over the iterator: no downlevelIteration in tsconfig.
  Array.from(text.matchAll(LINK_RE)).forEach((m, i) => {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const href = m[2] ?? m[0]
    out.push(
      <a key={`${keyBase}-a${i}`} href={href} target="_blank" rel="noreferrer" className={LINK_CLS}>
        {m[2] !== undefined ? m[1] : m[0]}
      </a>,
    )
    last = at + m[0].length
  })
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Line-based block pass: #/##/### headings, -/* bullets, ``` fences, links,
 *  everything else a whitespace-pre-wrap paragraph line. Pure — string in,
 *  React nodes out. */
export const renderMarkdown = (md: string): ReactNode[] => {
  const out: ReactNode[] = []
  let code: string[] | null = null // non-null ⇔ inside a ``` fence
  let bullets: ReactNode[] = []
  const codeCls =
    'overflow-x-auto rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-meta leading-relaxed text-ink'
  const flushBullets = (key: string) => {
    if (bullets.length === 0) return
    out.push(
      <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
        {bullets}
      </ul>,
    )
    bullets = []
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
      flushBullets(`ul-${key}`)
      code = [] // the fence line itself (incl. any language tag) is dropped
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushBullets(`ul-${key}`)
      const cls =
        heading[1].length === 1
          ? 'mt-2 font-display text-title tracking-tightest text-ink'
          : heading[1].length === 2
            ? 'mt-2 text-ui font-semibold text-ink'
            : 'mt-1 text-ui font-medium text-ink'
      out.push(
        heading[1].length === 1 ? (
          <h1 key={key} className={cls}>{inlineNodes(heading[2], key)}</h1>
        ) : heading[1].length === 2 ? (
          <h2 key={key} className={cls}>{inlineNodes(heading[2], key)}</h2>
        ) : (
          <h3 key={key} className={cls}>{inlineNodes(heading[2], key)}</h3>
        ),
      )
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      bullets.push(
        <li key={key} className="text-ui leading-relaxed text-ink">
          {inlineNodes(bullet[1], key)}
        </li>,
      )
      continue
    }
    flushBullets(`ul-${key}`)
    if (line.trim() === '') continue
    out.push(
      <p key={key} className="whitespace-pre-wrap text-ui leading-relaxed text-ink">
        {inlineNodes(line, key)}
      </p>,
    )
  }
  flushBullets('ul-eof')
  // Unclosed fence at EOF — render what accumulated rather than dropping it.
  if (code !== null) out.push(<pre key="code-eof" className={codeCls}>{code.join('\n')}</pre>)
  return out
}

// ─── The tab ────────────────────────────────────────────────────────────────

export interface ResearchModuleProps {
  /** Same shape the sibling modules receive; only `path` feeds the API. */
  project: ProjectMeta
}

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

  const openReport = useCallback(
    async (file: string) => {
      selectedRef.current = file
      setSelected(file)
      setContent(null)
      setReadError(false)
      setCopied(false)
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
    [project.path],
  )

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
      <section className="min-h-0 flex-1 overflow-y-auto">
        {selected === null ? (
          <div className="px-8 py-6 text-ui text-ink-subtle">{t('research.select')}</div>
        ) : readError ? (
          <div className="px-8 py-6 text-ui text-ink-subtle">{t('research.loadError')}</div>
        ) : content === null ? null : (
          <div className="mx-auto flex max-w-[720px] flex-col gap-2.5 px-8 py-6">
            <div className="flex items-center justify-end">
              <Btn variant="ghost" size="xs" onClick={copyMarkdown}>
                {t(copied ? 'research.copied' : 'research.copy')}
              </Btn>
            </div>
            {renderMarkdown(content)}
          </div>
        )}
      </section>
    </div>
  )
}
