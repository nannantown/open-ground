import { useState } from 'react'
import { Play, TerminalSquare } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'

// The Board card's terminal view. It does NOT own a PTY: the task's terminal
// is tracked board-side in ProjectPanel's taskTerminals map (taskId → PTY id)
// and renders ONLY here in the drawer — the Terminal tab is plain shells and
// knows nothing about tasks. This component is purely presentational: given
// the task's live claude terminal id (or null), render the raw terminal or
// the launch CTA.

export const BoardTaskTerminal = ({
  terminalId,
  onLaunch,
  onExit,
}: {
  /** The task slot's claudeTerminalId when launched and not exited; else null. */
  terminalId: string | null
  onLaunch: () => Promise<void> | void
  onExit: () => void
}) => {
  const { t } = useT()
  const [launching, setLaunching] = useState(false)

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
        {t('board.taskTerminal.hint')}
      </p>
      <button
        type="button"
        onClick={async () => {
          setLaunching(true)
          try {
            await onLaunch()
          } finally {
            setLaunching(false)
          }
        }}
        disabled={launching}
        className="flex items-center gap-1.5 rounded-[4px] border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        <Play size={11} strokeWidth={2.5} />
        {launching ? t('projectPanel.launchingClaude') : t('projectPanel.launchClaude')}
      </button>
    </div>
  )
}
