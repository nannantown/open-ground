import { useEffect, useRef, useState } from 'react'
import { X, Loader2, Send, CheckCircle2, ImagePlus } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { Overlay, DialogCard, DialogHeader } from '@/components/ui/overlay'
import { api } from '@/lib/api-client'
import { useT } from '@/i18n/I18nContext'
import type { FeedbackImage } from '@/lib/types'
import { MAX_FEEDBACK_IMAGES_TOTAL_B64 } from '@/lib/schemas'
import {
  fileToFeedbackImage,
  feedbackImageDataUrl,
  isFeedbackImageFile,
  FEEDBACK_IMAGE_MAX_COUNT,
} from '@/lib/feedbackImages'

interface Props {
  open: boolean
  onClose: () => void
  /** Optional UI context this feedback is about (e.g. a per-project tab). When
   *  set, a small "About: {label}" chip shows near the top and `source` is sent
   *  with the submission. Unset → unchanged general feedback. */
  context?: { source: string; label: string } | null
}

const MAX_LEN = 5000

// In-app feedback. POSTs through the local Hono proxy (/api/feedback) which
// forwards to Supabase server-side — no anon key in the client bundle. The
// toolbar only mounts this modal when /api/feedback/config reports enabled,
// so by the time it's open the route is wired; we still handle a 503 (env went
// away mid-session) by showing the error inline rather than a native alert.
//
// Images: users can paste (Cmd/Ctrl+V), drag-and-drop, or browse to attach
// screenshots. Each is downscaled + re-encoded to a small WebP in the browser
// (see src/lib/feedbackImages.ts) and sent INLINE as base64 in the `images`
// field — the owner reads them back in the Settings inbox. No object storage.
export const FeedbackModal = ({ open, onClose, context }: Props) => {
  const { t } = useT()
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [images, setImages] = useState<FeedbackImage[]>([])
  // Count of in-flight compressions (not a boolean): several files can process
  // at once, and the send button must stay disabled until ALL settle.
  const [attachBusy, setAttachBusy] = useState(0)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // dragenter/leave fire per descendant, so a plain boolean flickers as the
  // cursor crosses children. Counting depth keeps the highlight steady until the
  // pointer truly leaves the modal.
  const dragDepth = useRef(0)

  // Fresh form whenever the modal reopens.
  useEffect(() => {
    if (open) {
      setMessage('')
      setEmail('')
      setError(null)
      setBusy(false)
      setSent(false)
      setImages([])
      setAttachBusy(0)
      setAttachError(null)
      setDragging(false)
      dragDepth.current = 0
      setTimeout(() => messageRef.current?.focus(), 0)
    }
  }, [open])

  if (!open) return null

  // Compress + append picked / pasted / dropped image files, respecting the
  // count cap. Each file is processed independently so one undecodable file
  // doesn't sink the batch; per-file failures collapse into one inline notice.
  const addFiles = async (files: File[]) => {
    const imageFiles = files.filter(isFeedbackImageFile)
    if (imageFiles.length === 0) return
    setAttachError(null)

    const remaining = FEEDBACK_IMAGE_MAX_COUNT - images.length
    if (remaining <= 0) {
      setAttachError(t('modals.feedback.attachTooMany', { max: FEEDBACK_IMAGE_MAX_COUNT }))
      return
    }
    const accepted = imageFiles.slice(0, remaining)
    const overflowed = imageFiles.length > remaining

    setAttachBusy((n) => n + accepted.length)
    let failed = 0
    let tooLarge = false
    await Promise.all(
      accepted.map(async (file) => {
        try {
          const img = await fileToFeedbackImage(file)
          setImages((prev) => {
            // Re-check BOTH caps at COMMIT time: a racing paste/drop could push
            // past the count, and the total byte size is only known once each
            // file finishes compressing. Mirrors the server's caps so we fail in
            // the UI (clear message) instead of on a 400 from zod.
            if (prev.length >= FEEDBACK_IMAGE_MAX_COUNT) return prev
            const total =
              prev.reduce((n, im) => n + im.data.length, 0) + img.data.length
            if (total > MAX_FEEDBACK_IMAGES_TOTAL_B64) {
              tooLarge = true
              return prev
            }
            return [...prev, img]
          })
        } catch {
          failed += 1
        } finally {
          setAttachBusy((n) => Math.max(0, n - 1))
        }
      }),
    )
    // Surface the most actionable reason, in priority order.
    if (tooLarge) setAttachError(t('modals.feedback.attachTooLarge'))
    else if (failed > 0) setAttachError(t('modals.feedback.attachFailed'))
    else if (overflowed)
      setAttachError(t('modals.feedback.attachTooMany', { max: FEEDBACK_IMAGE_MAX_COUNT }))
  }

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
    setAttachError(null)
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Reset so picking the SAME file again still fires change.
    e.target.value = ''
    void addFiles(files)
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(isFeedbackImageFile)
    if (files.length === 0) return
    // Only swallow the paste when there's no accompanying text — a screenshot
    // paste shouldn't also dump a path, but a normal text paste must pass
    // through untouched (and we never interfere with IME composition).
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    void addFiles(files)
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files).filter(isFeedbackImageFile)
    if (files.length) void addFiles(files)
  }

  const submit = async () => {
    const clean = message.trim()
    // Block while images are still compressing so we never send a partial set.
    if (!clean || busy || attachBusy > 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.api.feedback.$post({
        json: {
          message: clean,
          email: email.trim(),
          ...(context ? { context: context.source } : {}),
          ...(images.length ? { images } : {}),
        },
      })
      const data = (await res.json().catch(() => ({}))) as { error?: unknown }
      if (!res.ok) {
        // A zValidator 400 body is { success:false, error:<ZodError object> } —
        // NOT a string. Guard so we never setError(object), which would crash
        // the JSX ("Objects are not valid as a React child").
        const msg =
          typeof data.error === 'string' ? data.error : t('modals.feedback.sendFailed')
        setError(msg)
        setBusy(false)
        return
      }
      setSent(true)
      setBusy(false)
      // Auto-dismiss shortly after the success state shows.
      setTimeout(onClose, 1200)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('modals.feedback.sendFailed'))
      setBusy(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    // Never hijack an Enter/Escape that is committing or cancelling an IME
    // composition — repo convention (CustomTabCreateDialog, BoardModule, …).
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  const over = message.length > MAX_LEN
  const canAddMore = images.length < FEEDBACK_IMAGE_MAX_COUNT

  return (
    <Overlay
      onClose={onClose}
      // The card's onKeyDown (onKey) owns Esc + ⌘Enter, so the Overlay must NOT
      // also wire its own Esc→close. data-esc-overlay still renders (escOverlay
      // default) so App's global Escape defers to us.
      closeOnEsc={false}
      aria-label={t('modals.feedback.title')}
      // Backstop: a file dropped on the dim backdrop (outside the card) must not
      // navigate the app away to that file. Swallow it here without attaching.
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
      }}
    >
      <DialogCard
        // `relative` is load-bearing: the inner z-10 drag-highlight (absolute
        // inset-0) pins to this card.
        className="relative w-[460px] max-w-[92vw]"
        ariaLabel={t('modals.feedback.title')}
        onKeyDown={onKey}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <DialogHeader
          align="baseline"
          eyebrow={t('modals.feedback.label')}
          title={
            <span style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}>
              {t('modals.feedback.title')}
            </span>
          }
          titleClassName="font-display text-head text-ink tracking-tightest"
          onClose={onClose}
          closeLabel={t('common.close')}
        />

        {sent ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <CheckCircle2 size={28} strokeWidth={1.5} className="text-accent" />
            <p className="text-ui text-ink leading-relaxed">
              {t('modals.feedback.thanks')}
            </p>
          </div>
        ) : (
          <>
            <div className="px-6 py-5 space-y-4">
              {context && (
                <div className="inline-flex max-w-full items-center rounded-[2px] border border-line bg-bg-inset px-2 py-1">
                  <span className="truncate text-ui text-ink-muted">
                    {t('modals.feedback.about', { label: context.label })}
                  </span>
                </div>
              )}
              <div>
                <label className="label-cap text-ink-muted block mb-1.5">
                  {t('modals.feedback.messageLabel')}
                </label>
                <textarea
                  ref={messageRef}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onPaste={onPaste}
                  placeholder={t('modals.feedback.messagePlaceholder')}
                  maxLength={MAX_LEN + 100}
                  className="w-full min-h-[120px] rounded-[2px] border border-line bg-bg px-3 py-2 text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent resize-y leading-relaxed"
                />
                <p
                  className={[
                    'mt-1 text-micro text-right tabular-nums',
                    over ? 'text-accent' : 'text-ink-faint',
                  ].join(' ')}
                >
                  {message.length} / {MAX_LEN}
                </p>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="label-cap text-ink-muted">
                    {t('modals.feedback.attachLabel')}{' '}
                    <span className="text-ink-faint normal-case tracking-normal">
                      {t('modals.feedback.attachOptional')}
                    </span>
                  </label>
                  {(images.length > 0 || attachBusy > 0) && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!canAddMore}
                      title={
                        canAddMore
                          ? undefined
                          : t('modals.feedback.attachTooMany', { max: FEEDBACK_IMAGE_MAX_COUNT })
                      }
                      className="inline-flex items-center gap-1 label-cap text-ink-subtle transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 rounded-[2px]"
                    >
                      <ImagePlus size={12} />
                      {t('modals.feedback.attachAdd')}
                    </button>
                  )}
                </div>

                {images.length > 0 || attachBusy > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {images.map((img, i) => (
                      <span key={i} className="relative inline-flex">
                        <img
                          src={feedbackImageDataUrl(img)}
                          alt={img.name || t('modals.feedback.attachLabel')}
                          className="h-14 w-14 rounded-[2px] border border-line object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(i)}
                          title={t('modals.feedback.attachRemove')}
                          aria-label={t('modals.feedback.attachRemove')}
                          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-bg-card text-ink-muted transition-colors hover:bg-accent hover:text-bg-card hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                    {attachBusy > 0 && (
                      <span
                        role="status"
                        aria-label={t('modals.feedback.attachBusy')}
                        className="flex h-14 w-14 items-center justify-center rounded-[2px] border border-dashed border-line text-ink-faint"
                      >
                        <Loader2 size={14} className="animate-spin" />
                      </span>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full items-center justify-center gap-2 rounded-[2px] border border-dashed border-line bg-bg px-3 py-3 text-ui text-ink-faint transition-colors hover:border-ink-faint hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <ImagePlus size={14} />
                    {t('modals.feedback.attachHint')}
                  </button>
                )}

                {attachError && (
                  <p className="mt-1 text-micro text-accent leading-relaxed">{attachError}</p>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={onPickFiles}
                  className="hidden"
                />
              </div>

              <div>
                <label className="label-cap text-ink-muted block mb-1.5">
                  {t('modals.feedback.emailLabel')}{' '}
                  <span className="text-ink-faint normal-case tracking-normal">
                    {t('modals.feedback.emailOptional')}
                  </span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
                />
              </div>

              {error && (
                <p className="text-ui text-accent leading-relaxed">{error}</p>
              )}
            </div>

            <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
              <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Btn>
              <Btn
                variant="primary"
                size="md"
                onClick={submit}
                disabled={busy || !message.trim() || over || attachBusy > 0}
              >
                {busy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
                {t('common.send')}
              </Btn>
            </div>
          </>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[3px] border-2 border-dashed border-accent bg-bg-card/85 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2 text-accent">
              <ImagePlus size={24} strokeWidth={1.5} />
              <p className="text-ui font-medium">{t('modals.feedback.attachDrop')}</p>
            </div>
          </div>
        )}
      </DialogCard>
    </Overlay>
  )
}
