import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, GitBranch, TerminalSquare, Wrench } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { SdkRenderItem } from '@/lib/sdkTranscript'
import { EventRow, ProseBlocks } from './SdkWorkerPane'

type ToolItem = Extract<SdkRenderItem, { kind: 'tool' }>
const activityButton = 'flex min-h-7 max-w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-meta text-ink-subtle transition-colors duration-150 hover:bg-plane hover:text-ink active:bg-line active:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2'

/** These details are only the public, bounded detail/head in the SDK frames.
 * The chat never fetches native tool transcripts, environment or credentials. */
const PresidentToolActivity = ({ item }: { item: ToolItem }) => {
  const { t } = useT()
  const failed = item.result?.ok === false
  const [open, setOpen] = useState(failed)
  useEffect(() => { if (failed) setOpen(true) }, [failed])
  const command = item.use.name === 'Bash'
  const read = item.use.name === 'Read'
  const review = item.use.name === 'Agent'
  const Icon = command ? TerminalSquare : read ? FileText : review ? GitBranch : Wrench
  const label = failed ? t('projectPanel.swarm.chat.toolFailed', { name: item.use.name })
    : t(`projectPanel.swarm.chat.${command ? 'command' : read ? 'read' : review ? 'review' : 'tool'}${item.result ? 'Done' : 'Running'}`, { name: item.use.name })
  return <div className="my-3 min-w-0" data-chat-activity>
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
      className={`${activityButton} ${failed ? 'text-error' : ''}`}>
      <Icon size={15} strokeWidth={1.6} className="shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{label}</span>
      {open ? <ChevronDown size={12} className="shrink-0" aria-hidden /> : <ChevronRight size={12} className="shrink-0" aria-hidden />}
    </button>
    {open && <div className="ml-2 mt-1 min-w-0 border-l border-line pl-4 text-meta text-ink-muted">
      {item.use.detail && <pre className="whitespace-pre-wrap break-words font-mono text-meta [overflow-wrap:anywhere]">{item.use.detail}</pre>}
      {item.result && <pre className={`mt-2 whitespace-pre-wrap break-words font-mono text-meta [overflow-wrap:anywhere] ${failed ? 'text-error' : ''}`}>{item.result.head}</pre>}
    </div>}
  </div>
}

/** The president uses the same structured words for either provider. */
export interface PresidentPublicLine { kind: 'input' | 'text'; text: string }
export const PresidentChatTranscript = ({ items, publicLines }: { items: SdkRenderItem[]; publicLines?: PresidentPublicLine[] }) => {
  const { t } = useT()
  // Public history owns the words. Tail frames add recent activities only;
  // capture may precede the pool event, so never merge text from both sources.
  const body: SdkRenderItem[] = publicLines ? publicLines.map((line, index) => ({ kind: 'event', seq: index, ev: line.kind === 'input' ? { kind: 'input', text: line.text } : { kind: 'text', text: line.text } })) : items
  const activities = publicLines ? items.filter(item => item.kind === 'tool' || (item.ev.kind !== 'input' && item.ev.kind !== 'text' && item.ev.kind !== 'thinking' && item.ev.kind !== 'turn_end' && item.ev.kind !== 'status')) : []
  const failureSeq = activities.filter(item => item.kind === 'tool' ? item.result?.ok === false
    : item.ev.kind === 'api_error' || item.ev.kind === 'quota_refusal' || item.ev.kind === 'tool_result' && !item.ev.ok).at(-1)?.seq
  const [activityOpen, setActivityOpen] = useState(failureSeq !== undefined)
  useEffect(() => { if (failureSeq !== undefined) setActivityOpen(true) }, [failureSeq])
  const renderItem = (item: SdkRenderItem, prefix: string) => {
    const key = `${prefix}-${item.seq}`
    if (item.kind === 'tool') return <PresidentToolActivity key={key} item={item} />
    const ev = item.ev
    if (ev.kind === 'input') return <div key={key} className="flex justify-end pt-2" data-chat-role="owner">
      <div className="max-w-[88%] whitespace-pre-wrap rounded-[20px] bg-plane px-4 py-3 text-ui leading-relaxed text-ink [overflow-wrap:anywhere]">{ev.text}</div>
    </div>
    if (ev.kind === 'text') return <article key={key} aria-label={t('projectPanel.swarm.chat.reply')} data-chat-role="assistant"
      className="min-w-0 [overflow-wrap:anywhere] [&_pre]:max-w-full">
      <ProseBlocks text={ev.text} subagent={ev.fromSubagent} />
    </article>
    if (ev.kind === 'turn_end') return <div key={key} className="h-1" aria-hidden />
    if (ev.kind === 'thinking' || ev.kind === 'status') return null
    return <EventRow key={key} ev={ev} t={t} />
  }
  return <div className="mx-auto w-full min-w-0 max-w-[760px] space-y-5 pb-4 font-body">
    {body.map(item => renderItem(item, publicLines ? 'public' : 'frame'))}
    {activities.length > 0 && <section aria-label={t('projectPanel.swarm.chat.activity')} className="pt-2">
      <button type="button" aria-expanded={activityOpen} onClick={() => setActivityOpen(open => !open)} className={activityButton}>
        {activityOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {t('projectPanel.swarm.chat.activity')}
        <span className="text-ink-faint" aria-hidden>{activities.length}</span>
      </button>
      {activityOpen && activities.map(item => renderItem(item, 'activity'))}
    </section>}
  </div>
}
