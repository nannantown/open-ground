// Full-screen in-app manual. A calm, editorial reader in the app's own paper /
// cartographic language: Fraunces headings, label-cap eyebrows, thin rules.
// Left = a sticky table of contents; right = the scrollable content rendered
// from manualContent.tsx (the bilingual source of truth). Language follows the
// app-wide toggle (useT), with its own EN/JA switch in the header for quick
// flipping while reading.
import { useCallback, useEffect, useRef, useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { OpenGroundMark } from '@/components/canvas/OpenGroundMark'
import { Overlay, DialogHeader } from '@/components/ui/overlay'
import { MANUAL_SECTIONS, type Bi, type Block, type Section } from './manualContent'

// Fraunces optical-size axis for large display headings (matches EmptyState).
const DISPLAY: React.CSSProperties = { fontVariationSettings: "'opsz' 32, 'SOFT' 30" }

// Split a string on `backtick` spans and render the odd segments as inline code.
function inline(text: string): React.ReactNode {
  const parts = text.split('`')
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <code
        key={i}
        className="whitespace-pre-wrap break-words rounded-[2px] border border-line bg-bg-inset px-1 py-px font-mono text-[0.9em] text-accent-deeper"
      >
        {p}
      </code>
    ) : (
      <span key={i}>{p}</span>
    ),
  )
}

const NOTE_TONES = {
  info: { bar: 'border-azure/45', bg: 'bg-azure-soft/45', tag: 'text-azure', label: { en: 'Note', ja: 'メモ' } },
  tip: { bar: 'border-moss/45', bg: 'bg-moss-soft/50', tag: 'text-moss', label: { en: 'Tip', ja: 'ヒント' } },
  warn: { bar: 'border-ochre/50', bg: 'bg-ochre-soft/50', tag: 'text-ochre', label: { en: 'Heads-up', ja: '注意' } },
} as const

export function ManualPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { lang, setLang } = useT()
  const L = useCallback((b: Bi) => b[lang], [lang])

  const [active, setActive] = useState(MANUAL_SECTIONS[0].id)
  const scrollRef = useRef<HTMLDivElement>(null)
  const secRefs = useRef<Record<string, HTMLElement | null>>({})

  // Reset to the top each time the manual is opened.
  useEffect(() => {
    if (open) {
      setActive(MANUAL_SECTIONS[0].id)
      scrollRef.current?.scrollTo({ top: 0 })
    }
  }, [open])

  // Scroll-spy: the active TOC entry is the last section whose top has passed a
  // small threshold below the viewport top.
  const onScroll = useCallback(() => {
    const sc = scrollRef.current
    if (!sc) return
    const top = sc.scrollTop
    let cur = MANUAL_SECTIONS[0].id
    for (const s of MANUAL_SECTIONS) {
      const el = secRefs.current[s.id]
      if (el && el.offsetTop - 96 <= top) cur = s.id
    }
    setActive(cur)
  }, [])

  const go = useCallback((id: string) => {
    const el = secRefs.current[id]
    const sc = scrollRef.current
    if (el && sc) sc.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })
  }, [])

  if (!open) return null

  const renderBlock = (b: Block, i: number): JSX.Element => {
    switch (b.kind) {
      case 'subhead':
        return (
          <h3 key={i} className="pt-3 text-[12px] font-semibold uppercase text-ink-faint">
            {L(b.text)}
          </h3>
        )
      case 'p':
        return (
          <p key={i} className="text-[14px] leading-relaxed text-ink-muted">
            {inline(L(b.text))}
          </p>
        )
      case 'steps':
        return (
          <ol key={i} className="space-y-2.5">
            {b.items.map((it, n) => (
              <li key={n} className="flex gap-3 text-[14px] leading-relaxed text-ink-muted">
                <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line bg-bg-inset text-[11px] font-medium tabular-nums text-ink-faint">
                  {n + 1}
                </span>
                <span>{inline(L(it))}</span>
              </li>
            ))}
          </ol>
        )
      case 'bullets':
        return (
          <ul key={i} className="space-y-2">
            {b.items.map((it, n) => (
              <li key={n} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-muted">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                <span>{inline(L(it))}</span>
              </li>
            ))}
          </ul>
        )
      case 'note': {
        const t = NOTE_TONES[b.tone ?? 'info']
        return (
          <div key={i} className={`rounded-[3px] border-l-2 ${t.bar} ${t.bg} px-3.5 py-2.5`}>
            <span className={`label-cap ${t.tag}`}>{t.label[lang]}</span>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{inline(L(b.text))}</p>
          </div>
        )
      }
      case 'rows': {
        const mono = b.mono !== false
        return (
          <div key={i} className="overflow-hidden rounded-[4px] border border-line">
            {b.rows.map((r, n) => (
              <div key={n} className={`flex gap-3 px-3 py-2 ${n ? 'border-t border-line-soft' : ''}`}>
                <div className="w-[42%] shrink-0">
                  {mono ? (
                    <code className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-ink">
                      {r.k}
                    </code>
                  ) : (
                    <span className="text-[13px] font-medium text-ink">{r.k}</span>
                  )}
                </div>
                <div className="flex-1 text-[13px] leading-snug text-ink-muted">{inline(L(r.v))}</div>
              </div>
            ))}
          </div>
        )
      }
      case 'diagram':
        return (
          <div key={i} className="rounded-[4px] border border-line bg-bg-card p-4 shadow-card">
            {b.id === 'layers' ? <LayersDiagram lang={lang} /> : b.id === 'board' ? <BoardDiagram lang={lang} /> : null}
          </div>
        )
    }
  }

  const renderSection = (s: Section): JSX.Element => (
    <section
      key={s.id}
      id={s.id}
      ref={(el) => {
        secRefs.current[s.id] = el
      }}
      className="border-line-soft pb-12 [&:not(:first-child)]:mt-4 [&:not(:first-child)]:border-t [&:not(:first-child)]:pt-12"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-accent">
          {s.icon}
        </span>
        <span className="label-cap text-ink-faint">{L(s.kicker)}</span>
      </div>
      <h2 className="font-display text-[26px] leading-[1.15] tracking-tight text-ink" style={DISPLAY}>
        {L(s.title)}
      </h2>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-subtle">{L(s.intro)}</p>
      <div className="mt-6 space-y-4">{s.blocks.map(renderBlock)}</div>
    </section>
  )

  return (
    <Overlay
      position="fixed"
      layer="top"
      backdrop="paper"
      placement="fill"
      onClose={onClose}
      aria-label={lang === 'ja' ? 'マニュアル' : 'Manual'}
      className="font-body"
    >
      {/* Header */}
      <DialogHeader
        separator="line"
        density="panel"
        align="center"
        // The manual's header keeps its raised frosted-bar treatment (a tone
        // lighter than the bg-bg paper body, with a soft shadow + blur) — the
        // shared bar provides the structure, this surface adds its own bg.
        className="bg-bg-card/95 shadow-card backdrop-blur"
        onBack={onClose}
        backLabel={lang === 'ja' ? '戻る' : 'Back'}
        leading={
          <div className="flex min-w-0 items-center gap-2.5">
            <OpenGroundMark size={20} className="shrink-0 select-none" />
            <div className="flex min-w-0 flex-col leading-none">
              <span className="label-cap label-cap-latin text-ink-faint">OPEN GROUND</span>
              <span className="mt-0.5 font-display text-[15px] tracking-tight text-ink" style={DISPLAY}>
                {lang === 'ja' ? 'マニュアル' : 'Manual'}
              </span>
            </div>
          </div>
        }
        actions={
          /* Language toggle */
          <div className="flex items-center rounded-[3px] border border-line bg-bg-card p-0.5">
            {(['en', 'ja'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                className={[
                  'rounded-[2px] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors',
                  lang === l ? 'bg-accent text-bg-card' : 'text-ink-muted hover:bg-plane hover:text-ink',
                ].join(' ')}
              >
                {l}
              </button>
            ))}
          </div>
        }
      />

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Table of contents */}
        <nav className="no-scrollbar hidden w-[236px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-3 md:flex">
          {MANUAL_SECTIONS.map((s) => {
            const on = active === s.id
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => go(s.id)}
                className={[
                  'flex items-center gap-2.5 rounded-[3px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  on ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-plane hover:text-ink',
                ].join(' ')}
              >
                <span className={`shrink-0 ${on ? 'text-accent' : 'text-ink-faint'}`}>{s.icon}</span>
                <span className="truncate">{L(s.title)}</span>
              </button>
            )
          })}
        </nav>

        {/* Content */}
        <div ref={scrollRef} onScroll={onScroll} className="relative min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[760px] px-6 py-10 md:px-12">
            {MANUAL_SECTIONS.map(renderSection)}
            <footer className="mt-2 flex items-center gap-1.5 border-t border-line-soft pt-6 text-[11px] text-ink-faint">
              <CornerDownRight size={12} strokeWidth={1.75} className="shrink-0" />
              <span>
                {lang === 'ja'
                  ? 'このページは実装に追従する生きた仕様です。動作を変えたら、対応するセクションも更新してください。'
                  : 'This page is a living spec that tracks the build. When behaviour changes, update the matching section.'}
              </span>
            </footer>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

// ── Schematic diagrams (the app's own paper vocabulary, no decoration) ───────

function LayersDiagram({ lang }: { lang: 'en' | 'ja' }): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="label-cap mb-2 text-ink-faint">{lang === 'ja' ? 'レイヤー1 · グラウンド' : 'Layer 1 · Ground'}</div>
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="relative h-11 w-16 rounded-[2px] border border-line bg-bg-inset">
              {i === 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-azure" />}
              <div className="mt-2 space-y-1 px-1.5">
                <div className="h-1 w-9 rounded-full bg-line-strong/60" />
                <div className="h-1 w-11 rounded-full bg-line/70" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5 pl-1 text-ink-faint">
        <CornerDownRight size={13} strokeWidth={1.75} />
        <span className="text-[11px]">{lang === 'ja' ? 'カードを開く' : 'open a card'}</span>
      </div>
      <div>
        <div className="label-cap mb-2 text-ink-faint">{lang === 'ja' ? 'レイヤー2 · プロジェクト' : 'Layer 2 · the project'}</div>
        <div className="flex flex-wrap gap-2">
          {['Board', 'Canvas', 'Terminal'].map((t) => (
            <div key={t} className="rounded-[2px] border border-line bg-bg-card px-3 py-1.5 text-[12px] text-ink shadow-card">
              {t}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function BoardDiagram({ lang }: { lang: 'en' | 'ja' }): JSX.Element {
  const cols: { label: Bi; opt?: boolean; cards: number }[] = [
    { label: { en: 'To do', ja: '未着手' }, cards: 2 },
    { label: { en: 'In progress', ja: '実行中' }, cards: 1 },
    { label: { en: 'In review', ja: 'レビュー待ち' }, opt: true, cards: 1 },
    { label: { en: 'Done', ja: '完了' }, cards: 2 },
    { label: { en: 'Needs decision', ja: '判断待ち' }, cards: 0 },
  ]
  return (
    <div className="flex gap-2 overflow-x-auto">
      {cols.map((c, i) => (
        <div
          key={i}
          className={`min-w-[96px] flex-1 rounded-[3px] border bg-bg px-2 py-2 ${
            c.opt ? 'border-dashed border-line-strong' : 'border-line'
          }`}
        >
          <div className="label-cap truncate text-ink-subtle">{c.label[lang]}</div>
          <div className="mt-1.5 space-y-1">
            {Array.from({ length: c.cards }).map((_, n) => (
              <div key={n} className="h-3.5 rounded-[2px] border border-line bg-bg-card" />
            ))}
          </div>
          {c.opt && <div className="mt-1.5 text-[9px] leading-tight text-ink-faint">{lang === 'ja' ? '任意' : 'optional'}</div>}
        </div>
      ))}
    </div>
  )
}
