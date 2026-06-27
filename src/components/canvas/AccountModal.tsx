import { useState } from 'react'
import { LogIn, LogOut, Loader2 } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { Overlay, DialogCard, DialogHeader } from '@/components/ui/overlay'
import { useAuth } from '@/lib/auth/AuthContext'
import { useT } from '@/i18n/I18nContext'

interface Props {
  open: boolean
  onClose: () => void
}

// The optional app-account modal. Modeled on FeedbackModal (same shell, Btn
// usage, ESC handling). Signed-out: Continue with Google / GitHub. Signed-in:
// show identity + Sign out. The login is optional and gates nothing — it is the
// seam a future entitlement check will read (see docs/BILLING_PLAN.md). The
// toolbar only mounts this when /api/auth/config reports enabled, so by the time
// it's open the routes are wired.
//
// Interactive-state coverage (per the project UI rules): the provider buttons
// use the shared Btn (`ghost`/`subtle`/`primary`) which already defines default
// / hover / disabled, plus focus-visible from the global stylesheet; busy state
// disables them and swaps in a spinner.
export const AccountModal = ({ open, onClose }: Props) => {
  const { user, status, signingIn, authError, signIn, signOut } = useAuth()
  const { t } = useT()
  // Fall back to initials if the provider avatar fails to load (broken/blocked URL).
  const [avatarError, setAvatarError] = useState(false)

  if (!open) return null

  // Disable the provider buttons during the initial session probe AND while a
  // sign-in round-trip is in flight, so they can't be re-clicked into a second
  // browser tab + poll.
  const busy = signingIn || status === 'loading'

  return (
    <Overlay onClose={onClose} aria-label={t('modals.account.label')}>
      <DialogCard className="w-[420px] max-w-[92vw]" ariaLabel={t('modals.account.label')}>
        <DialogHeader
          align="baseline"
          eyebrow={t('modals.account.label')}
          title={
            <span style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}>
              {user ? t('modals.account.titleSignedIn') : t('modals.account.titleSignedOut')}
            </span>
          }
          titleClassName="font-display text-[22px] leading-none tracking-tightest text-ink"
          onClose={onClose}
          closeLabel={t('common.close')}
        />

        {user ? (
          // --- Signed in --------------------------------------------------
          <>
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-center gap-3">
                {user.avatarUrl && !avatarError ? (
                  <img
                    src={user.avatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarError(true)}
                    className="h-11 w-11 rounded-full border border-line object-cover"
                  />
                ) : (
                  <div className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-bg-inset text-[15px] font-display text-ink">
                    {(user.name || user.email || '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  {user.name && (
                    <p className="text-[14px] text-ink leading-tight truncate">
                      {user.name}
                    </p>
                  )}
                  {user.email && (
                    <p className="text-[12px] text-ink-muted leading-tight truncate">
                      {user.email}
                    </p>
                  )}
                  <p className="label-cap text-ink-faint mt-1">
                    {t('modals.account.signedInWith', { provider: user.provider })}
                  </p>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
              <Btn variant="subtle" size="md" onClick={onClose}>
                {t('common.close')}
              </Btn>
              <Btn variant="ghost" size="md" onClick={() => signOut()} danger>
                <LogOut size={13} />
                {t('modals.account.signOut')}
              </Btn>
            </div>
          </>
        ) : (
          // --- Signed out -------------------------------------------------
          <>
            <div className="px-6 py-5 space-y-3">
              <p className="text-[13px] text-ink-muted leading-relaxed">
                {t('modals.account.intro')}
              </p>
              <div className="space-y-2 pt-1">
                <Btn
                  variant="ghost"
                  size="md"
                  onClick={() => signIn('google')}
                  disabled={busy}
                  className="w-full justify-center"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
                  {t('modals.account.continueWithGoogle')}
                </Btn>
                <Btn
                  variant="ghost"
                  size="md"
                  onClick={() => signIn('github')}
                  disabled={busy}
                  className="w-full justify-center"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
                  {t('modals.account.continueWithGitHub')}
                </Btn>
              </div>
              {authError ? (
                <p className="text-[12px] text-accent leading-relaxed pt-1">
                  {authError}
                </p>
              ) : signingIn ? (
                <p className="text-[11px] text-ink-faint leading-relaxed pt-1">
                  {t('modals.account.completeInBrowser')}
                </p>
              ) : (
                <p className="text-[11px] text-ink-faint leading-relaxed pt-1">
                  {t('modals.account.browserWillOpen')}
                </p>
              )}
            </div>

            <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
              <Btn variant="subtle" size="md" onClick={onClose}>
                {t('common.cancel')}
              </Btn>
            </div>
          </>
        )}
      </DialogCard>
    </Overlay>
  )
}
