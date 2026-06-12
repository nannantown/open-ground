import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, TerminalSquare, X, Plus } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'

// A raw `claude` terminal embedded anywhere (a Board card, the Canvas/Doc dock,
// a custom tab's module dock). PTY-based and subscription-only, so it bypasses
// the session JSONL that recent claude versions stopped writing for
// --session-id sessions (which broke the run/observer and chat surfaces). One
// PTY per `slot`, remembered in localStorage so reopening reattaches; a dead id
// (server restart / quit) falls back to the launch button via
// ClaudeTerminalPane's onExit.
//
// The localStorage namespace defaults to the project path but can be overridden
// (`storageId`) for surfaces whose identity isn't a project — e.g. a custom
// tab's module, which is global across projects. Launching defaults to
// POST /api/terminal/claude in the project cwd; `launchOverride` swaps in a
// different spawner (it must resolve to the new terminal id, or throw a
// user-presentable Error).

const embtermKey = (storageId: string, slot: string) =>
  `openground.embterm.${storageId}:${slot}`

/** Best-effort kill of every embedded PTY bound under a storage identity, plus
 *  its dock open/tabs state. Used when the surface itself is deleted (e.g. a
 *  custom module): its docks never mount again, so no later sweep could reach
 *  these bindings. The server side may also kill by cwd — this is the client
 *  half of that teardown. */
export const killEmbeddedTerminals = (storageId: string) => {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (
        k.startsWith(`openground.embterm.${storageId}:`) ||
        k.startsWith(`openground.dockterm.${storageId}:`)
      ) {
        doomed.push(k)
      }
    }
    for (const k of doomed) {
      if (k.startsWith('openground.embterm.')) {
        const tid = localStorage.getItem(k)
        if (tid) void fetch(`/api/terminal/${tid}`, { method: 'DELETE' }).catch(() => {})
      }
      localStorage.removeItem(k)
    }
  } catch {}
}

export const EmbeddedClaudeTerminal = ({
  projectPath,
  slot,
  storageId,
  initialPrompt,
  hint,
  launchOverride,
  autoLaunch,
  onLaunched,
}: {
  projectPath: string
  slot: string
  /** localStorage namespace; defaults to projectPath. */
  storageId?: string
  initialPrompt?: string
  hint?: string
  /** Replace the default claude-in-project spawn. Resolves to the terminal id;
   *  throws a user-presentable Error on failure. */
  launchOverride?: () => Promise<string>
  /** Spawn on mount when no stored PTY exists (single-flighted, so dev
   *  StrictMode's doubled effect can't start twins). */
  autoLaunch?: boolean
  /** Fires once per ACTUAL spawn (not on reattach) with the new id. */
  onLaunched?: (terminalId: string) => void
}) => {
  const { t } = useT()
  const sid = storageId ?? projectPath
  const [terminalId, setTerminalId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(embtermKey(sid, slot))
    } catch {
      return null
    }
  })
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Single-flight: concurrent callers (StrictMode's doubled autoLaunch effect,
  // or a click racing it) join the in-flight spawn instead of starting a twin.
  const inFlightRef = useRef<Promise<void> | null>(null)
  const onLaunchedRef = useRef(onLaunched)
  onLaunchedRef.current = onLaunched

  const launch = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current
    const run = (async () => {
      setLaunching(true)
      setError(null)
      try {
        let id: string
        if (launchOverride) {
          id = await launchOverride()
        } else {
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
          id = info.id
        }
        try {
          localStorage.setItem(embtermKey(sid, slot), id)
        } catch {}
        setTerminalId(id)
        onLaunchedRef.current?.(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLaunching(false)
      }
    })().finally(() => {
      inFlightRef.current = null
    })
    inFlightRef.current = run
    return run
  }, [projectPath, sid, slot, initialPrompt, launchOverride])

  // Surfaces whose whole point is the terminal (the custom-tab module dock)
  // spawn as soon as the slot mounts; reattach-able sessions skip the spawn.
  useEffect(() => {
    if (!autoLaunch || terminalId) return
    void launch()
    // Mount-time decision only — a later exit falls back to the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onExit = useCallback(() => {
    try {
      localStorage.removeItem(embtermKey(sid, slot))
    } catch {}
    setTerminalId(null)
  }, [sid, slot])

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
        disabled={launching || (!projectPath && !launchOverride)}
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

const dockKey = (storageId: string, context: string) =>
  `openground.dockterm.${storageId}:${context}`

const loadDock = (storageId: string, context: string): DockState => {
  try {
    const raw = localStorage.getItem(dockKey(storageId, context))
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
  storageId,
  launchOverride,
  autoLaunch,
  onLaunched,
  initialOpen,
}: {
  projectPath: string
  context: string
  title?: string
  hint?: string
  /** localStorage namespace for the dock + its tabs; defaults to projectPath
   *  (a custom tab passes its module identity instead). */
  storageId?: string
  /** Forwarded to every tab's EmbeddedClaudeTerminal. */
  launchOverride?: () => Promise<string>
  autoLaunch?: boolean
  onLaunched?: (terminalId: string) => void
  /** Open on mount regardless of the persisted state (one-shot, e.g. the
   *  create-flow's first reveal). Not persisted until the user interacts. */
  initialOpen?: boolean
}) => {
  const { t } = useT()
  const sid = storageId ?? projectPath
  // Default tab title is translated at render (not as a parameter default) so
  // it follows the live language setting.
  const dockTitle = title ?? t('projectPanel.dockTitle')
  const [state, setState] = useState<DockState>(() => {
    const s = loadDock(sid, context)
    return initialOpen ? { ...s, open: true } : s
  })
  const update = (next: DockState) => {
    setState(next)
    try {
      localStorage.setItem(dockKey(sid, context), JSON.stringify(next))
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
      const k = embtermKey(sid, `${context}:${id}`)
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
        storageId={sid}
        slot={`${context}:${activeId}`}
        hint={hint}
        launchOverride={launchOverride}
        autoLaunch={autoLaunch}
        onLaunched={onLaunched}
      />
    </div>
  )
}
