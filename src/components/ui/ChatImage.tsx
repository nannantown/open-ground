import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@/i18n/I18nContext'
import { Overlay } from './overlay'

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

/** An image in a chat line (docs/CHAT_SPEC.md §9.4) — the owner's photo or one
 *  an agent sent: a thumbnail at most 160 px high; a click opens it large over
 *  everything, and a click (on it or around it) or Esc closes it again, focus
 *  back on the thumbnail. One that cannot be loaded shows its alt words and does
 *  not open. */
export function ChatImage({ src, alt, onLoad, onError }: { src: string; alt: string; onLoad?: () => void; onError?: () => void }): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  const thumb = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    thumb.current?.focus()
  }
  return (
    <>
      <button
        ref={thumb}
        type="button"
        // Not loaded: the browser shows its alt words in place; nothing to open large.
        disabled={broken}
        onClick={() => setOpen(true)}
        title={t('misc.chatImage.open')}
        className={`block max-w-full rounded-[10px] transition-opacity duration-150 enabled:hover:opacity-85 enabled:active:opacity-70 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
      >
        <img
          src={src}
          alt={alt}
          onLoad={() => {
            setBroken(false)
            onLoad?.()
          }}
          onError={() => {
            setBroken(true)
            onError?.()
          }}
          className="block max-h-40 max-w-full rounded-[10px] border border-line object-contain"
        />
      </button>
      {open &&
        createPortal(
          <Overlay onClose={close} aria-label={alt} layer="top" backdrop="scrimStrong">
            <button type="button" autoFocus onClick={close} title={t('common.close')} className={`rounded-[10px] ${focusRing}`}>
              <img src={src} alt={alt} className="block max-h-[88vh] max-w-[92vw] rounded-[10px] object-contain" />
            </button>
          </Overlay>,
          document.body,
        )}
    </>
  )
}
