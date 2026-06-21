import { Cloud, Database, Laptop, ShieldCheck } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'

// Privacy disclosure + consent CHECKBOX shown INLINE in the first realtime-collab
// surface — an OWNER minting an invite (CollabInviteDialog) or a MEMBER joining a
// shared project (CollabSharedDialog). Turning collab on sends data off the user's
// machine: their email to the membership / login service, and the WHOLE
// Board/Canvas — task text, notes, every canvas element including the SOURCE CODE
// of mock/screen elements, plus images — to the real-time sync server + cloud
// storage, where it is kept. So we disclose exactly what goes where and require an
// explicit "I agree" tick before any of those network calls can fire.
//
// We describe each destination by its ROLE (login service / sync server / cloud
// storage), not by vendor brand: from the user's side OPEN GROUND is the single
// service they deal with, so the disclosure shows the STRUCTURE — what data goes
// where and why — rather than the names of the infrastructure behind it. The full
// privacy policy (linked from the checkbox) carries the complete detail.
//
// Consent is remembered per role in localStorage so it's a one-time step, not a
// nag — once you've agreed as an owner, future invites skip the notice entirely;
// likewise for members. The two roles are tracked separately because their
// disclosures differ (an owner shares a whole project; a member contributes their
// edits + email).
//
// Bilingual inline (NOT i18n keys) on purpose: the locale message catalog lives
// outside this directory, and these long disclosure strings are scoped to the
// collab surface only. We read the active language from useT().

/** Public privacy policy — opens in the OS browser (Electron routes http(s)
 *  target=_blank to shell.openExternal; a plain browser opens a new tab). Mirror
 *  of docs/PRIVACY.md, served from the marketing site at landing/privacy.html. */
export const PRIVACY_URL = 'https://open-ground.app/privacy.html'

export type CollabRole = 'owner' | 'member'

const consentKey = (role: CollabRole) => `og-collab-consent-${role}-v1`

/** Has the user already agreed to the collab data disclosure for this role? */
export const collabConsentAccepted = (role: CollabRole): boolean => {
  try {
    return localStorage.getItem(consentKey(role)) === 'accepted'
  } catch {
    return false
  }
}

/** Persist that the user agreed (best-effort; consent still holds for the
 *  session via component state even if storage is unavailable). */
export const markCollabConsent = (role: CollabRole): void => {
  try {
    localStorage.setItem(consentKey(role), 'accepted')
  } catch {
    /* storage unavailable (private mode) — consent still applies in-session */
  }
}

/** Inline privacy disclosure + an "I agree to the privacy policy" checkbox.
 *  Rendered by the invite / join form ONLY until the user agrees — the parent
 *  stops rendering it once consent is recorded, so returning users never see it.
 *  Ticking the box IS the consent action: the parent persists it via
 *  markCollabConsent and releases the gated network calls (the first of which is a
 *  WRITE that creates the shared-project row), so nothing leaves the machine until
 *  the box is ticked. */
export const CollabConsentNotice = ({
  role,
  checked,
  onCheckedChange,
}: {
  role: CollabRole
  /** Whether the "I agree" box is ticked (controlled by the parent's consent). */
  checked: boolean
  /** Fired when the box is toggled — the parent records consent on `true`. */
  onCheckedChange: (checked: boolean) => void
}) => {
  const { lang } = useT()
  const ja = lang === 'ja'
  const owner = role === 'owner'

  return (
    <div className="mt-4" data-testid="collab-consent">
      <div className="flex items-start gap-2.5 rounded-[3px] border border-line bg-bg px-3.5 py-3">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-[13px] font-medium text-ink">
              {ja
                ? owner
                  ? 'このプロジェクトを共有する前に'
                  : '参加する前に'
                : owner
                  ? 'Before you share this project'
                  : 'Before you join'}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              {ja
                ? owner
                  ? 'メンバーを招待するとリアルタイム同期が有効になり、一部のデータがあなたのマシンを離れてクラウドに保存されます:'
                  : '参加するとリアルタイム同期が有効になり、あなたの一部のデータがマシンを離れてクラウドに保存されます:'
                : owner
                  ? 'Inviting collaborators turns on real-time sync — some data leaves your machine and is stored in the cloud:'
                  : 'Joining turns on real-time sync — some of your data leaves your machine and is stored in the cloud:'}
            </p>
          </div>

          {/* Email → the membership / login service (identity + the roster). */}
          <div className="flex items-start gap-2">
            <Database size={13} className="mt-0.5 shrink-0 text-ink-faint" />
            <p className="text-[12px] leading-relaxed text-ink-muted">
              <span className="font-medium text-ink">
                {ja ? 'メンバー管理（ログイン基盤）：' : 'Membership (login service): '}
              </span>
              {ja
                ? owner
                  ? 'あなたと招待相手のメールアドレス、共有プロジェクト名、招待コード。'
                  : 'あなたのメールアドレス（オーナーと他のメンバーに表示されます）。'
                : owner
                  ? "your email and your collaborators' emails, the shared project name, and invite codes."
                  : 'your email address — visible to the owner and other members.'}
            </p>
          </div>

          {/* Board/Canvas body + images → the real-time sync server + cloud
              storage. The headline disclosure of this whole notice. */}
          <div className="flex items-start gap-2">
            <Cloud size={13} className="mt-0.5 shrink-0 text-ink-faint" />
            <p className="text-[12px] leading-relaxed text-ink-muted">
              <span className="font-medium text-ink">
                {ja
                  ? 'リアルタイム同期・保存（同期サーバ）：'
                  : 'Live sync & storage (sync server): '}
              </span>
              {ja
                ? owner
                  ? 'このプロジェクトの Board と Canvas のすべて ── タスクの文章やメモ、プロジェクト設定、付箋・テキスト・フレーム、mock/screen 要素のソースコード、貼り付けた画像を含む全要素。クラウドに保存され続けます。'
                  : '共有された Board と Canvas、そしてあなたの編集 ── あなたが追加する mock/screen 要素のソースコードや画像を含みます。クラウドに保存され続けます。'
                : owner
                  ? "this project's entire Board and Canvas — task text, notes, project settings, and every canvas element, including the source code of mock/screen elements and any images you add. Kept in the cloud."
                  : 'the shared Board and Canvas plus your edits — including the source code of any mock/screen elements and images you add. Kept in the cloud.'}
            </p>
          </div>

          {/* Stays put — the reassurance half: code/terminal/Claude never leave. */}
          <div className="flex items-start gap-2">
            <Laptop size={13} className="mt-0.5 shrink-0 text-ink-faint" />
            <p className="text-[12px] leading-relaxed text-ink-faint">
              {ja
                ? 'リポジトリのファイル、ターミナル、Claude との会話、ローカルのファイルパスはマシンの外に出ません。'
                : 'Your repository files, your terminal, your Claude conversations, and your local file path never leave your machine.'}
            </p>
          </div>

          {/* The consent gate: an explicit "I agree" with the policy linked inline.
              Ticking it is what releases the first (write) network call. */}
          <label className="flex cursor-pointer items-start gap-2 pt-0.5">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onCheckedChange(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer"
            />
            <span className="text-[12px] leading-relaxed text-ink-muted">
              {ja ? (
                <>
                  <a
                    href={PRIVACY_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-accent underline underline-offset-2 transition-colors hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    プライバシーポリシー
                  </a>
                  に同意します
                </>
              ) : (
                <>
                  I agree to the{' '}
                  <a
                    href={PRIVACY_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-accent underline underline-offset-2 transition-colors hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    privacy policy
                  </a>
                </>
              )}
            </span>
          </label>
        </div>
      </div>
    </div>
  )
}
