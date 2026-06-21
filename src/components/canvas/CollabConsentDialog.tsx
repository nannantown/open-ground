import { Cloud, Database, Laptop, ShieldCheck } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'

// Privacy disclosure + consent gate shown BEFORE the first realtime-collab action
// — an OWNER minting an invite / inviting by email, or a MEMBER joining a shared
// project. Turning collab on sends data off the user's machine: their email to
// Supabase (membership), and the WHOLE Board/Canvas — task text, notes, every
// canvas element including the SOURCE CODE of mock/screen elements, plus images —
// to Cloudflare (the realtime sync engine + storage), where it is kept. So we
// disclose exactly what goes where, link the full privacy policy, and require an
// explicit "Agree" before any of those network calls can fire.
//
// Consent is remembered per role in localStorage so it's a one-time step, not a
// nag — once you've agreed as an owner, future invites skip straight to the UI;
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

export const CollabConsentGate = ({
  role,
  busy,
  onAgree,
  onCancel,
}: {
  role: CollabRole
  /** Disable both actions while a parent operation is in flight. */
  busy?: boolean
  onAgree: () => void
  onCancel: () => void
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

          {/* Sent to Supabase — membership identity (email). */}
          <div className="flex items-start gap-2">
            <Database size={13} className="mt-0.5 shrink-0 text-ink-faint" />
            <p className="text-[12px] leading-relaxed text-ink-muted">
              <span className="font-medium text-ink">
                {ja ? 'Supabase（メンバー管理）：' : 'Supabase (membership): '}
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

          {/* Sent to Cloudflare — the Board/Canvas body, incl. mock/screen source
              code + images. The headline disclosure of this whole gate. */}
          <div className="flex items-start gap-2">
            <Cloud size={13} className="mt-0.5 shrink-0 text-ink-faint" />
            <p className="text-[12px] leading-relaxed text-ink-muted">
              <span className="font-medium text-ink">
                {ja ? 'Cloudflare（ライブ同期・保存）：' : 'Cloudflare (live sync & storage): '}
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

          <a
            href={PRIVACY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-[12px] text-accent underline underline-offset-2 transition-colors hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {ja ? 'プライバシーポリシーを読む ↗' : 'Read the full privacy policy ↗'}
          </a>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Btn variant="subtle" size="md" onClick={onCancel} disabled={busy}>
          {ja ? 'キャンセル' : 'Cancel'}
        </Btn>
        <Btn variant="primary" size="md" onClick={onAgree} disabled={busy}>
          {ja ? '同意して続ける' : 'Agree & continue'}
        </Btn>
      </div>
    </div>
  )
}
