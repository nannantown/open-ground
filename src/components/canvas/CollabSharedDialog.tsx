import { useCallback, useEffect, useState } from 'react'
import { Clock, LogIn, Users, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import { FIELD_INPUT_CSS } from './ProjectConfigFields'
import {
  CollabConsentNotice,
  collabConsentAccepted,
  markCollabConsent,
} from './CollabConsentDialog'
import type {
  CollabJoinResponse,
  CollabProjectListItem,
  CollabProjectsListResponse,
} from '@/lib/types'
import { parseJoinDeepLink } from '@/lib/deepLink'

// The MEMBER join dialog. Lists the folder-less projects the signed-in user was
// invited to (owned:false), and lets them redeem an invite CODE or LINK to join a
// new one. Picking a project opens it in SharedProjectPanel.
//
// Reached TWO ways: (a) the Toolbar "Shared with me" entry (the member's path to
// the INITIAL join — they paste the invite code or link the owner sent them); and
// (b) an `openground://join?code=…` invite deep link → App passes the code as
// `initialCode`, which we PREFILL into the field. (Already-joined projects also
// surface as Ground cards, so the dialog is mainly for the first join.) The join
// field accepts EITHER a bare code OR a full invite link (we extract the embedded
// code). We never auto-join: joining always requires an explicit click — a deep
// link can come from anywhere, so it must be confirmed, and an inline
// privacy-consent checkbox gates the first join. On an APPROVAL-mode link the join
// returns status:'pending' → we show an "awaiting approval" state.
//
// This is the reachability surface for the member flow: a member has no local
// folder, so a shared project can't appear via the registry/Ground scan — it's
// discovered here instead. Fetch-only (no heavy collab import); only mounted
// behind the collab-enabled gate (the Toolbar entry + the dialog are both gated on
// collabEnabled), so the default build never shows it.

export const CollabSharedDialog = ({
  initialCode,
  onOpen,
  onClose,
}: {
  /** A code carried in by a deep link — prefilled into the field. NEVER auto-joined:
   *  the member must pass the consent step and click Join explicitly. */
  initialCode?: string
  /** Open a shared project (folder-less) in SharedProjectPanel. */
  onOpen: (collabProjectId: string, label: string) => void
  onClose: () => void
}) => {
  const { t, lang } = useT()
  // null = still loading; [] = none.
  const [shared, setShared] = useState<CollabProjectListItem[] | null>(null)
  const [code, setCode] = useState(initialCode ?? '')
  const [joining, setJoining] = useState(false)
  const [awaiting, setAwaiting] = useState(false) // approval-mode request filed
  const [error, setError] = useState<string | null>(null)
  // Privacy consent — the member must agree to the data disclosure BEFORE the
  // first join. Remembered per role so it's one-time.
  const [consented, setConsented] = useState(() => collabConsentAccepted('member'))

  // Shared-with-me = projects the caller can READ but does NOT own (owned:false);
  // owned ones already appear as local Ground cards. Returns the list so join()
  // can open the freshly-joined project without a second fetch / state race.
  const load = useCallback(async (): Promise<CollabProjectListItem[]> => {
    const res = await fetch('/api/collab/projects')
      .then((r) => (r.ok ? (r.json() as Promise<CollabProjectsListResponse>) : null))
      .catch(() => null)
    const list = (res?.projects ?? []).filter((p) => !p.owned)
    setShared(list)
    return list
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Joining is ALWAYS an explicit user action — the deep-link code is only
  // prefilled into the field (never auto-joined), so join() reads the field state.
  const join = useCallback(
    async () => {
      // Accept EITHER a bare code OR a full invite LINK pasted into the field — an
      // owner may share `openground://join?code=…` (the clickable link) or just the
      // raw code, and the member shouldn't have to know the difference. parseJoinDeepLink
      // returns the embedded code for a valid link, else null → fall back to the
      // trimmed raw input. (Card 6067c41e: コード/リンク入力フィールドから join.)
      const c = parseJoinDeepLink(code) ?? code.trim()
      // Joining is the member's first WRITE (POST /api/collab/join enrols them) —
      // it must not fire until the data-disclosure box is ticked. The button is
      // disabled pre-consent too; this guard closes the programmatic path. Any
      // future auto-join MUST keep this guard so it can't bypass consent.
      if (!c || joining || !consented) return
      setJoining(true)
      setError(null)
      setAwaiting(false)
      try {
        const res = await fetch('/api/collab/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: c }),
        })
          .then((r) => (r.ok ? (r.json() as Promise<CollabJoinResponse>) : null))
          .catch(() => null)
        if (!res?.ok || !res.collabProjectId) {
          // Surface WHY it failed instead of one opaque message (条件4: 無言失敗
          // しない). The server returns a structured `error` for the two user-facing
          // cases — an expired/invalid code and a signed-out caller — both 200s
          // (user-input outcomes, not network errors). Anything else (null = network /
          // disabled, or an unrecognised error) falls back to the combined hint.
          const e = res?.error
          setError(
            e === 'not signed in'
              ? t('projectPanel.collabSharedDialogErrorSignedOut')
              : e && /invalid|expired/i.test(e)
                ? t('projectPanel.collabSharedDialogErrorInvalid')
                : t('projectPanel.collabSharedDialogJoinFailed'),
          )
          return
        }
        setCode('')
        // Approval mode: a request was filed — don't open anything, show "awaiting".
        if (res.status === 'pending') {
          setAwaiting(true)
          return
        }
        const list = await load()
        const joined = list.find((p) => p.id === res.collabProjectId)
        onOpen(
          res.collabProjectId,
          joined?.label || t('projectPanel.collabSharedDialogUntitled'),
        )
      } finally {
        setJoining(false)
      }
    },
    [code, joining, consented, load, onOpen, t],
  )

  return (
    <div
      data-esc-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[440px] max-w-[92vw] flex-col overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 pt-4 pb-3">
          <h3 className="flex items-center gap-2 font-display text-[16px] text-ink">
            <Users size={15} className="text-ink-muted" />
            {t('projectPanel.collabSharedDialogTitle')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            title={t('common.cancel')}
            className="rounded-sm p-1 text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Privacy consent — an inline gate, NOT a separate screen. The join
              field + the shared-project list below stay visible (a deep-link code
              prefills the field), but joining and opening a shared project are
              disabled until the member ticks the "I agree" box. Shown only until
              consent is recorded — returning members never see it. */}
          {!consented && (
            <CollabConsentNotice
              role="member"
              checked={consented}
              onCheckedChange={(v) => {
                if (!v) return
                markCollabConsent('member')
                setConsented(true)
              }}
            />
          )}

          {/* Awaiting approval (approval-mode link) — shown after a pending join. */}
          {awaiting && (
            <div className="flex items-start gap-2.5 rounded-[3px] border border-line bg-bg px-3 py-2.5">
              <Clock size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-ink">
                  {t('projectPanel.collabSharedDialogAwaiting')}
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                  {t('projectPanel.collabSharedDialogAwaitingBody')}
                </p>
              </div>
            </div>
          )}

          {/* Followed an invite link — confirm before joining. The code is
              prefilled; we NEVER auto-join, so the explicit Join click below is
              the confirmation. */}
          {initialCode && !awaiting && (
            <div className="flex items-start gap-2.5 rounded-[3px] border border-accent/40 bg-accent-soft px-3 py-2.5">
              <LogIn size={14} className="mt-0.5 shrink-0 text-accent" />
              <p className="text-[12px] leading-relaxed text-ink">
                {lang === 'ja'
                  ? '招待リンクを開きました。コードを確認して「参加」を押すと参加します。'
                  : 'You opened an invite link. Review the code below and click Join to join.'}
              </p>
            </div>
          )}

          {/* Join by code */}
          <div>
            <label className="mb-1 block label-cap text-ink-muted">
              {t('projectPanel.collabSharedDialogJoinLabel')}
            </label>
            <div className="flex items-stretch gap-1.5">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  // Enter submits — but never steal the IME confirm Enter.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void join()
                  }
                }}
                placeholder={t('projectPanel.collabSharedDialogJoinPlaceholder')}
                className={`${FIELD_INPUT_CSS} min-w-0 flex-1`}
              />
              <Btn
                variant="primary"
                size="sm"
                className="shrink-0 whitespace-nowrap"
                onClick={() => void join()}
                disabled={!code.trim() || joining || !consented}
              >
                {joining
                  ? t('projectPanel.collabSharedDialogJoining')
                  : t('projectPanel.collabSharedDialogJoin')}
              </Btn>
            </div>
            {error && <p className="mt-1.5 text-[11px] leading-relaxed text-accent">{error}</p>}
          </div>

          {/* The list of projects shared with me */}
          <div>
            <label className="mb-1 block label-cap text-ink-muted">
              {t('projectPanel.collabSharedDialogListLabel')}
            </label>
            {shared === null ? (
              <p className="text-[12px] text-ink-faint">{t('projectPanel.loading')}</p>
            ) : shared.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.collabSharedDialogEmpty')}
              </p>
            ) : (
              <ul className="space-y-1">
                {shared.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onOpen(p.id, p.label || t('projectPanel.collabSharedDialogUntitled'))
                      }
                      // Opening a shared project connects the realtime transport
                      // (presence + content sync) — a data exchange, so it waits
                      // for the same consent tick the join button does.
                      disabled={!consented}
                      className="flex w-full items-center gap-2 rounded-[3px] border border-line bg-bg px-2.5 py-2 text-left text-[12px] text-ink transition-colors hover:border-accent hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:bg-bg"
                    >
                      <Users size={13} className="shrink-0 text-ink-faint" />
                      <span className="truncate">
                        {p.label || t('projectPanel.collabSharedDialogUntitled')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
