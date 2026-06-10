import { useCallback, useState } from 'react'
import { Play, TerminalSquare, X, Plus } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'

// A raw `claude` terminal embedded anywhere (a Board card, the Canvas/Doc dock).
// PTY-based and subscription-only, so it bypasses the session JSONL that recent
// claude versions stopped writing for --session-id sessions (which broke the
// run/observer and chat surfaces). One PTY per `slot`, remembered in
// localStorage so reopening reattaches; a dead id (server restart / quit) falls
// back to the launch button via ClaudeTerminalPane's onExit.

const embtermKey = (projectPath: string, slot: string) =>
  `openground.embterm.${projectPath}:${slot}`

export const EmbeddedClaudeTerminal = ({
  projectPath,
  slot,
  initialPrompt,
  hint,
}: {
  projectPath: string
  slot: string
  initialPrompt?: string
  hint?: string
}) => {
  const { t } = useT()
  const [terminalId, setTerminalId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(embtermKey(projectPath, slot))
    } catch {
      return null
    }
  })
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const launch = useCallback(async () => {
    setLaunching(true)
    setError(null)
    try {
      const res = await fetch('/api/terminal/claude', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cwd: projectPath,
          ...(initialPrompt ? { initialPrompt } : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`)
      }
      const info = (await res.json()) as { id?: string }
      if (!info?.id) throw new Error('no terminal id')
      try {
        localStorage.setItem(embtermKey(projectPath, slot), info.id)
      } catch {}
      setTerminalId(info.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLaunching(false)
    }
  }, [projectPath, slot, initialPrompt])

  const onExit = useCallback(() => {
    try {
      localStorage.removeItem(embtermKey(projectPath, slot))
    } catch {}
    setTerminalId(null)
  }, [projectPath, slot])

  if (terminalId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ClaudeTerminalPane terminalId={terminalId} chrome={false} onExit={onExit} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <TerminalSquare size={20} className="text-ink-faint" />
      <p className="max-w-[85%] text-[12px] leading-relaxed text-ink-faint">
        {hint ?? t('projectPanel.embTermHint')}
      </p>
      <button
        type="button"
        onClick={() => void launch()}
        disabled={launching || !projectPath}
        className="flex items-center gap-1.5 rounded-[4px] border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        <Play size={11} strokeWidth={2.5} />
        {launching ? t('projectPanel.launchingClaude') : t('projectPanel.launchClaude')}
      </button>
      {error && <p className="text-[11px] text-accent">{error}</p>}
    </div>
  )
}

// ── Collapsible, TABBED terminal dock ────────────────────────────────────────
// A right-side dock with Chrome-style tabs, each tab a parallel `claude` PTY.
// Used by Canvas and Doc (the assistant/marker pipeline they used is JSONL-
// backed and hidden in terminal-only mode). A narrow dock can't usefully
// horizontal-split, so tabs are how you run several claudes in parallel:
// inactive tabs' PTYs keep running server-side and reattach when re-selected;
// closing a tab kills its PTY.

type DockState = { open: boolean; tabs: string[]; activeId: string }

const dockKey = (projectPath: string, context: string) =>
  `openground.dockterm.${projectPath}:${context}`

const loadDock = (projectPath: string, context: string): DockState => {
  try {
    const raw = localStorage.getItem(dockKey(projectPath, context))
    if (raw) {
      const s = JSON.parse(raw) as Partial<DockState>
      if (Array.isArray(s.tabs) && s.tabs.length) {
        const tabs = s.tabs.map(String)
        return {
          open: !!s.open,
          tabs,
          activeId: tabs.includes(String(s.activeId)) ? String(s.activeId) : tabs[0],
        }
      }
    }
  } catch {}
  return { open: false, tabs: ['1'], activeId: '1' }
}

export const TerminalDock = ({
  projectPath,
  context,
  title,
  hint,
}: {
  projectPath: string
  context: string
  title?: string
  hint?: string
}) => {
  const { t } = useT()
  // Default tab title is translated at render (not as a parameter default) so
  // it follows the live language setting.
  const dockTitle = title ?? t('projectPanel.dockTitle')
  const [state, setState] = useState<DockState>(() => loadDock(projectPath, context))
  const update = (next: DockState) => {
    setState(next)
    try {
      localStorage.setItem(dockKey(projectPath, context), JSON.stringify(next))
    } catch {}
  }
  const { open, tabs, activeId } = state

  const addTab = () => {
    const next = String(Math.max(0, ...tabs.map(t => parseInt(t, 10) || 0)) + 1)
    update({ open: true, tabs: [...tabs, next], activeId: next })
  }

  const closeTab = (id: string) => {
    // Kill this tab's PTY (if it was launched) so it doesn't linger.
    try {
      const k = embtermKey(projectPath, `${context}:${id}`)
      const tid = localStorage.getItem(k)
      if (tid) {
        void fetch(`/api/terminal/${tid}`, { method: 'DELETE' }).catch(() => {})
        localStorage.removeItem(k)
      }
    } catch {}
    const rest = tabs.filter(t => t !== id)
    if (rest.length === 0) {
      update({ open, tabs: ['1'], activeId: '1' })
      return
    }
    update({ open, tabs: rest, activeId: activeId === id ? rest[rest.length - 1] : activeId })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => update({ ...state, open: true })}
        title={t('projectPanel.dockOpen', { title: dockTitle })}
        className="flex shrink-0 items-center border-l border-line bg-bg-card px-2.5 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
      >
        <TerminalSquare size={15} />
      </button>
    )
  }

  return (
    <div className="flex w-[460px] min-w-[320px] shrink-0 flex-col border-l border-line bg-bg">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map(id => {
            const on = id === activeId
            return (
              <div
                key={id}
                className={[
                  'flex shrink-0 items-center gap-1 rounded-[3px] px-1.5 py-1 text-[10px] transition-colors',
                  on ? 'bg-accent/15 text-ink' : 'text-ink-faint hover:bg-bg-inset hover:text-ink',
                ].join(' ')}
              >
                <button
                  type="button"
                  onClick={() => update({ ...state, activeId: id })}
                  className="flex items-center gap-1 focus-visible:outline-none"
                >
                  <TerminalSquare size={10} />
                  {dockTitle} {id}
                </button>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => closeTab(id)}
                    title={t('projectPanel.dockCloseTab')}
                    className="rounded-[2px] text-ink-faint transition-colors hover:text-accent"
                  >
                    <X size={9} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            onClick={addTab}
            title={t('projectPanel.dockAddTab')}
            className="shrink-0 rounded-[3px] p-1 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Plus size={11} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => update({ ...state, open: false })}
          title={t('projectPanel.dockClose')}
          className="shrink-0 rounded-[2px] p-0.5 text-ink-faint transition-colors hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X size={13} />
        </button>
      </div>
      {/* Only the active tab is mounted; inactive tabs' PTYs keep running
       *  server-side and reattach (replay) when re-selected. */}
      <EmbeddedClaudeTerminal
        key={`${context}:${activeId}`}
        projectPath={projectPath}
        slot={`${context}:${activeId}`}
        hint={hint}
      />
    </div>
  )
}
