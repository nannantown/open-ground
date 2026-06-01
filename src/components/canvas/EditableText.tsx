import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

// Read-only text that turns editable on double-click or the pencil button —
// so a field isn't a permanent input box, but editing stays one gesture away.
// The pencil is always shown (faint) so it's clear the text can be changed.
export const EditableText = ({
  value,
  onSave,
  placeholder = 'Add a description…',
}: {
  value: string
  onSave: (next: string) => void
  placeholder?: string
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!editing || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editing])

  const start = () => {
    setDraft(value)
    setEditing(true)
  }
  const commit = () => {
    setEditing(false)
    if (draft.trim() !== value.trim()) onSave(draft.trim())
  }

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        onChange={e => {
          setDraft(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${e.target.scrollHeight}px`
        }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        placeholder={placeholder}
        className="w-full resize-none rounded-[2px] border border-accent bg-bg-card px-2 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
      />
    )
  }

  return (
    <div
      onDoubleClick={start}
      className="group/ed -mx-1 flex items-start gap-1.5 rounded-[2px] px-1 py-0.5"
    >
      <p
        className={[
          'flex-1 text-[12px] leading-relaxed',
          value ? 'text-ink-muted' : 'italic text-ink-faint',
        ].join(' ')}
      >
        {value || placeholder}
      </p>
      <button
        onClick={start}
        title="編集（ダブルクリックでも可）"
        className="mt-px shrink-0 rounded-sm p-0.5 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink-muted"
      >
        <Pencil size={11} />
      </button>
    </div>
  )
}
