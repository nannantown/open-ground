import { useEffect, useRef, useState } from 'react'
import { X, Loader2, Send, CheckCircle2 } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { api } from '@/lib/api-client'

interface Props {
  open: boolean
  onClose: () => void
}

const MAX_LEN = 5000

// In-app feedback. POSTs through the local Hono proxy (/api/feedback) which
// forwards to Supabase server-side — no anon key in the client bundle. The
// toolbar only mounts this modal when /api/feedback/config reports enabled,
// so by the time it's open the route is wired; we still handle a 503 (env went
// away mid-session) by showing the error inline rather than a native alert.
export const FeedbackModal = ({ open, onClose }: Props) => {
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  // Fresh form whenever the modal reopens.
  useEffect(() => {
    if (open) {
      setMessage('')
      setEmail('')
      setError(null)
      setBusy(false)
      setSent(false)
      setTimeout(() => messageRef.current?.focus(), 0)
    }
  }, [open])

  if (!open) return null

  const submit = async () => {
    const clean = message.trim()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.api.feedback.$post({
        json: { message: clean, email: email.trim() },
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? 'フィードバックを送信できませんでした')
        setBusy(false)
        return
      }
      setSent(true)
      setBusy(false)
      // Auto-dismiss shortly after the success state shows.
      setTimeout(onClose, 1200)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'フィードバックを送信できませんでした')
      setBusy(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  const over = message.length > MAX_LEN

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="flex flex-col w-[460px] max-w-[92vw] bg-bg-card border border-line shadow-card-hover overflow-hidden rounded-[3px]"
      >
        <header className="shrink-0 rule-double flex items-baseline justify-between px-6 pt-5 pb-4">
          <div>
            <p className="label-cap text-accent mb-1.5">フィードバック</p>
            <h2
              className="font-display text-[22px] text-ink leading-none tracking-tightest"
              style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}
            >
              フィードバックを送る
            </h2>
          </div>
          <Btn variant="icon" size="sm" onClick={onClose} aria-label="閉じる">
            <X size={16} />
          </Btn>
        </header>

        {sent ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <CheckCircle2 size={28} strokeWidth={1.5} className="text-accent" />
            <p className="text-[13px] text-ink leading-relaxed">
              ありがとうございます。フィードバックを送信しました。
            </p>
          </div>
        ) : (
          <>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="label-cap text-ink-muted block mb-1.5">
                  メッセージ
                </label>
                <textarea
                  ref={messageRef}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="良かった点・うまく動かない点・こうだったらいいのに、など…"
                  maxLength={MAX_LEN + 100}
                  className="w-full min-h-[120px] rounded-[2px] border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent resize-y leading-relaxed"
                />
                <p
                  className={[
                    'mt-1 text-[10px] text-right tabular-nums',
                    over ? 'text-accent' : 'text-ink-faint',
                  ].join(' ')}
                >
                  {message.length} / {MAX_LEN}
                </p>
              </div>

              <div>
                <label className="label-cap text-ink-muted block mb-1.5">
                  メール{' '}
                  <span className="text-ink-faint normal-case tracking-normal">
                    （任意 — 返信が必要な場合のみ）
                  </span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
                />
              </div>

              {error && (
                <p className="text-[12px] text-accent leading-relaxed">{error}</p>
              )}
            </div>

            <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
              <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>
                キャンセル
              </Btn>
              <Btn
                variant="primary"
                size="md"
                onClick={submit}
                disabled={busy || !message.trim() || over}
              >
                {busy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
                送信
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
