import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, MessageCircle, Plus, Trash2 } from 'lucide-react'
import {
  NewTaskComposer,
  TaskThread,
  type ComposerDraft,
} from './ProjectPanel'
import { RunStatusBadge } from './RunStatusBadge'
import { runKind } from '@/lib/runStatus'
import { newId } from '@/lib/ids'
import type { ProjectTask, RunEntry, RunSession } from '@/lib/types'
import type { RunTaskOpts } from '@/lib/useRuns'

interface Props {
  projectPath: string
  /** The Canvas this sidebar belongs to. Forwarded to runs as
   *  `canvasContext` so Claude knows which Canvas it's editing and
   *  the observer can route CANVAS_ADD markers to the right file. */
  canvasId: string
  chats: ProjectTask[]
  activeChatId: string | null
  open: boolean
  width: number
  onOpenChange: (open: boolean) => void
  onWidthChange: (width: number) => void
  onChatsChange: (chats: ProjectTask[]) => void
  onActiveChatChange: (id: string | null) => void
  /** Shared with Chats tab — same runner, same SSE, same task ids. */
  taskRuns: Map<string, RunSession>
  allTaskRuns: Map<string, RunSession[]>
  onRunTask: (task: ProjectTask, opts?: RunTaskOpts) => void
  onCancelTask: (taskId: string) => void
  /** Drop a chat message onto the surrounding canvas as a sticky. */
  onPasteToCanvas: (text: string) => void
}

const COLLAPSED_WIDTH = 40
const MIN_WIDTH = 240
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 360

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// Trim a label down to something that actually fits in a sidebar row. Counts
// fullwidth chars as 2 against an effective budget so JP+EN mixed lines wrap at
// the same visual length.
const clip = (s: string, max = 28): string => {
  let width = 0
  let out = ''
  for (const ch of s) {
    const w = /[\x00-\x7F]/.test(ch) ? 1 : 2
    if (width + w > max * 2) {
      return out + '…'
    }
    width += w
    out += ch
  }
  return out
}

// Pull the entry that represents the chat's "current topic": prefer the most
// recently started session's first entry, since each chat round spawns a new
// session and the freshest one carries the most recent topic label.
const latestEntry = (sessions: RunSession[]): RunEntry | null => {
  let best: RunSession | null = null
  for (const s of sessions) {
    if (!best || Date.parse(s.startedAt) > Date.parse(best.startedAt)) best = s
  }
  return best?.entries[0] ?? null
}

// One-line label for the sidebar row. The authoritative source is the most
// recent run's `topic` field — Claude writes it explicitly each turn as a
// noun-phrase headline for the conversation. Everything else is just a
// fallback for runs that haven't completed yet or pre-`topic` history.
const chatTitle = (chat: ProjectTask, sessions: RunSession[]): string => {
  const entry = latestEntry(sessions)
  const topic = entry?.parsedResult?.topic?.trim()
  if (topic) return clip(oneLine(topic))
  // Run still in flight (no parsedResult yet) — show the user's latest message
  // so the row isn't blank. This is the only time we fall back to raw feedback.
  const isLive =
    entry &&
    (entry.status === 'pending' || entry.status === 'running') &&
    entry.feedback?.trim()
  if (isLive) return clip(oneLine(entry!.feedback!))
  // Legacy runs (pre-topic): use the assistant summary's first sentence so it
  // at least looks summarized, not a raw transcript.
  const summary = entry?.parsedResult?.summary?.trim()
  if (summary) {
    const firstSentence = summary.split(/[。．.!?！？\n]/)[0] ?? summary
    return clip(oneLine(firstSentence))
  }
  const question = entry?.parsedResult?.question?.trim()
  if (question) return clip(oneLine(question))
  const title = oneLine(chat.title ?? '')
  return title ? clip(title) : '無題のチャット'
}

// Left-side chat sidebar for the Canvas workspace. Reuses TaskThread /
// NewTaskComposer verbatim — the only differences vs. the Chats tab are
//   • where the chat list lives (ProjectTask[] from the Canvas file, not tasks.json)
//   • the collapse-to-rail affordance so the drawing surface can breathe when not in use
//
// Per-Canvas state (open / width / activeChatId) is owned by CanvasWorkspace
// so it persists into the Canvas file alongside the drawing surface.
export const CanvasChatSidebar = ({
  projectPath,
  canvasId,
  chats,
  activeChatId,
  open,
  width,
  onOpenChange,
  onWidthChange,
  onChatsChange,
  onActiveChatChange,
  taskRuns,
  allTaskRuns,
  onRunTask,
  onCancelTask,
  onPasteToCanvas,
}: Props) => {
  // Curry the canvas id onto every runTask coming out of this sidebar so
  // children don't have to know about Canvas-vs-Chats wiring. Anything they
  // pass through `runWithCanvas(task, opts)` gets `canvasContext` filled in
  // automatically — the server then surfaces the right prompt section and
  // the observer routes CANVAS_ADD markers to this exact Canvas.
  const runWithCanvas = (task: ProjectTask, opts?: RunTaskOpts) => {
    onRunTask(task, { ...opts, canvasContext: { canvasId } })
  }
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({})
  const widthRef = useRef(width)
  widthRef.current = width

  const activeChat = useMemo(
    () => chats.find((t) => t.id === activeChatId) ?? null,
    [chats, activeChatId],
  )

  // Persist live width into the parent only on drop, not every mousemove —
  // saves IO during the drag.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    let liveW = startW
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (ev.clientX - startX)))
      liveW = next
      onWidthChange(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onWidthChange(liveW)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const updateDraft = (taskId: string, updater: (prev: ComposerDraft) => ComposerDraft) => {
    setDrafts((prev) => {
      const current = prev[taskId] ?? { text: '', images: [] }
      const next = updater(current)
      if (next.text === '' && next.images.length === 0) {
        if (!(taskId in prev)) return prev
        const { [taskId]: _, ...rest } = prev
        return rest
      }
      return { ...prev, [taskId]: next }
    })
  }

  const createChat = (
    title: string,
    images: ProjectTask['images'],
    planMode?: boolean,
    skill?: string | null,
  ) => {
    const task: ProjectTask = {
      id: newId(),
      title,
      done: false,
      milestoneId: null,
      createdAt: new Date().toISOString(),
      ...(images && images.length > 0 ? { images } : {}),
      ...(skill ? { activeSkill: skill } : {}),
    }
    onChatsChange([task, ...chats])
    onActiveChatChange(task.id)
    runWithCanvas(task, {
      permissionMode: planMode ? 'plan' : undefined,
      skill: skill ?? null,
    })
  }

  const deleteChat = (taskId: string) => {
    onChatsChange(chats.filter((t) => t.id !== taskId))
    if (activeChatId === taskId) onActiveChatChange(null)
    setDrafts((prev) => {
      if (!(taskId in prev)) return prev
      const { [taskId]: _, ...rest } = prev
      return rest
    })
  }

  const patchChat = (taskId: string, patch: Partial<ProjectTask>) => {
    onChatsChange(chats.map((t) => (t.id === taskId ? { ...t, ...patch } : t)))
  }

  if (!open) {
    return (
      <div
        style={{ width: COLLAPSED_WIDTH }}
        className="relative flex h-full shrink-0 flex-col items-center border-r border-line bg-bg-card pt-3"
      >
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          title="チャットを開く (⌘+/)"
          className="flex h-8 w-8 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg hover:text-ink"
        >
          <MessageCircle size={15} strokeWidth={1.75} />
        </button>
        {chats.length > 0 && (
          <span className="mt-1 label-cap text-ink-faint">{chats.length}</span>
        )}
      </div>
    )
  }

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-line bg-bg-card"
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-line-soft px-2.5">
        <div className="flex items-center gap-1.5 label-cap text-ink-muted">
          <MessageCircle size={11} strokeWidth={2} />
          <span>Chat</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onActiveChatChange(null)}
            title="新しいチャット"
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg hover:text-ink"
          >
            <Plus size={12} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title="閉じる (⌘+/)"
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg hover:text-ink"
          >
            <ChevronLeft size={13} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <ul className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line-soft py-1">
          {chats.length === 0 && (
            <li className="px-3 py-3 text-[12px] text-ink-faint">
              まだチャットがありません。下の入力欄から始めてください。
            </li>
          )}
          {chats.map((t) => {
            const isActive = t.id === activeChatId
            const entry = taskRuns.get(t.id)?.entries[0]
            const kind = entry ? runKind(entry) : null
            const label = chatTitle(t, allTaskRuns.get(t.id) ?? [])
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onActiveChatChange(t.id)}
                  className={[
                    'group flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] leading-snug transition-colors',
                    isActive
                      ? 'bg-bg text-ink'
                      : 'text-ink-muted hover:bg-bg/60 hover:text-ink',
                  ].join(' ')}
                  title={label}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {kind && <RunStatusBadge kind={kind} />}
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm('このチャットを削除します。')) deleteChat(t.id)
                    }}
                    title="このチャットを削除"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-faint opacity-0 transition-opacity hover:bg-bg-inset hover:text-accent group-hover:opacity-100"
                  >
                    <Trash2 size={11} strokeWidth={1.75} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex min-h-0 flex-1 flex-col">
          {activeChat ? (
            <TaskThread
              variant="pane"
              task={activeChat}
              projectPath={projectPath}
              run={taskRuns.get(activeChat.id)}
              allRuns={allTaskRuns.get(activeChat.id) ?? []}
              draft={drafts[activeChat.id] ?? { text: '', images: [] }}
              onDraftChange={(updater) => updateDraft(activeChat.id, updater)}
              onRun={(opts) => runWithCanvas(activeChat, opts)}
              onUpdate={(patch) => patchChat(activeChat.id, patch)}
              onCancel={() => onCancelTask(activeChat.id)}
              onDelete={() => deleteChat(activeChat.id)}
              onPasteToCanvas={onPasteToCanvas}
              enableSkillPicker
              paneContentClassName="px-4 py-4"
            />
          ) : (
            <NewTaskComposer
              projectPath={projectPath}
              hasOtherChats={chats.length > 0}
              enableSkillPicker
              onCreate={(title, images, opts) => createChat(title, images, opts?.planMode, opts?.skill)}
            />
          )}
        </div>
      </div>

      <div
        onMouseDown={startResize}
        title="ドラッグで幅を変更"
        className="absolute bottom-0 right-0 top-0 z-10 -mr-1 w-2 cursor-col-resize transition-colors hover:bg-accent/40"
      />
    </aside>
  )
}

CanvasChatSidebar.COLLAPSED_WIDTH = COLLAPSED_WIDTH
CanvasChatSidebar.DEFAULT_WIDTH = DEFAULT_WIDTH
