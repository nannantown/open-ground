# OPEN GROUND — Privacy Policy / プライバシーポリシー

_Last updated: 2026-06-21_

This document is the canonical privacy policy for OPEN GROUND. It is mirrored on
the marketing site at <https://open-ground.app/privacy.html> and is linked from
the in-app collaboration dialogs (the consent step shown before you share or
join a project).

OPEN GROUND is a **local, single-user tool** — a cockpit for Claude Code that
runs on your own machine. **By default, nothing you do in OPEN GROUND leaves
your computer.** Data only goes to the cloud when you take two specific,
opt-in actions: (1) signing in, and (2) turning on real-time collaboration.
This policy explains exactly what is sent, where, and why.

---

## English

### 1. The default: everything stays local

When you simply use OPEN GROUND — adding projects, opening terminals, editing
Boards and Canvases on your own — **no project data is transmitted anywhere.**
All of it lives on your machine under `~/.openground/`. OPEN GROUND drives the
`claude` CLI you already have; it never sends your code or your prompts to any
Anthropic API on your behalf, and it uses no API key of its own.

The following **never leave your machine**, in any mode:

- Your repository's source files and git history.
- Your terminal sessions and command history.
- Your Claude Code conversations / transcripts.
- Your local file paths (when collaboration is on, a project is identified by a
  one-way hash, not its path).

### 2. Optional sign-in

OPEN GROUND has an **optional** account login (Google or GitHub). Login is not
required to use the app on your own. If you do sign in:

- Authentication is handled by a **third-party login & membership service** (our
  identity provider). Your email address and a user ID are associated with your
  account.
- The OAuth flow opens in your real browser; access tokens are held by the local
  OPEN GROUND server process and are **not** exposed to the web UI.

Signing in by itself does not publish your project data. It establishes the
identity that real-time collaboration (below) uses.

### 3. Real-time collaboration (opt-in)

Collaboration is **off unless you turn it on.** When you invite a collaborator
(as an owner) or join a shared project (as a member), OPEN GROUND enables
real-time sync, and the following data is sent to and **stored** by third-party
cloud infrastructure:

#### Login & membership service — membership & control plane

| Data | When |
| --- | --- |
| Your email address, and the emails of collaborators you invite | On invite / on join |
| A user ID (UUID) per member | On join |
| The shared project's **display name** (the name you choose for collaborators) | When the owner sets it |
| Invite codes, their mode (open / approval), limits, and expiry (7 days default) | When the owner mints a link |
| Join requests (email + status) for approval-mode links | When a member requests to join |

Member emails are visible to the project owner and to other members of the same
project (the roster). Your **local file path is not sent** — a project is keyed
by a one-way hash of (owner id + path).

#### Real-time sync server & cloud storage

The contents of the shared project's **Board and Canvas** travel through a
**real-time sync server** (the live sync hub) and are **persisted** in cloud
storage so collaborators can reconnect and work offline:

- **Board:** task titles, descriptions, notes, status, ordering, and project
  configuration — such as assignees, the Review column, completion flow, target
  branch, and any verify commands you set.
- **Canvas:** every element — sticky notes, text, frames, comments, images, and
  **mock / screen elements including their source code** (the live HTML/React
  you write into them).
- **Images** you place on a Canvas are uploaded to cloud object storage (images
  only, up to 10 MB each).

> **In plain terms:** turning on collaboration means your Board and Canvas
> content — including any source code in mock/screen elements and any images —
> is stored in the cloud, not just on your machine. Your repository's own files,
> terminal, and Claude chats are still never sent.

### 4. Retention & deletion

- **Membership data** (held by the login & membership service) is retained until
  the owner removes a member or deletes the project.
- **Board/Canvas content and images** (held by the sync server & cloud storage)
  are retained while the project is shared. Stopping sharing halts further sync;
  deleting the project removes its shared state.
- **Invite codes** expire automatically (7 days by default) and can be revoked
  by the owner at any time.

### 5. Infrastructure providers

Real-time collaboration runs on third-party cloud infrastructure, used purely to
operate collaboration:

- A **login & membership service** — authentication and membership storage.
- A **real-time sync server with cloud object storage** — live sync and
  persistence of your Board/Canvas content, and image storage.

OPEN GROUND does not sell your data, does not use it for advertising, and sends
it to no third parties other than the infrastructure described above for the
purpose of running collaboration. For questions about the specific providers we
use, contact us through the in-app feedback form or <https://open-ground.app/>.

### 6. Your choices

- Use OPEN GROUND fully **without signing in and without collaboration** — then
  nothing is sent off your machine.
- **Stop sharing** at any time; owners can revoke invite links and remove
  members.
- Questions or removal requests: reach us through the in-app feedback form or
  the contact on <https://open-ground.app/>.

---

## 日本語

### 1. 既定：すべてローカルに留まる

OPEN GROUND を普通に使う限り（プロジェクトの追加、ターミナルの利用、自分だけで
Board や Canvas を編集する等）、**プロジェクトのデータはどこにも送信されません。**
すべてはあなたのマシンの `~/.openground/` 配下に保存されます。OPEN GROUND は
あなたが既に使っている `claude` CLI を動かすだけで、あなたのコードやプロンプトを
代わりに Anthropic API へ送ることはなく、独自の API キーも使いません。

以下は**どのモードでもマシンの外に出ません**：

- リポジトリのソースファイルと git 履歴
- ターミナルのセッションとコマンド履歴
- Claude Code との会話／トランスクリプト
- ローカルのファイルパス（共有時、プロジェクトはパスではなく一方向ハッシュで識別）

### 2. 任意のサインイン

OPEN GROUND には**任意**のアカウントログイン（Google / GitHub）があります。
自分だけで使うのにログインは不要です。サインインした場合：

- 認証は**第三者のログイン・メンバー管理サービス**（当アプリの ID プロバイダー）が
  扱います。あなたのメールアドレスとユーザー ID がアカウントに紐づきます。
- OAuth フローは実ブラウザで開き、アクセストークンはローカルの OPEN GROUND
  サーバープロセスが保持し、Web UI には**渡されません**。

サインイン単体ではプロジェクトデータは公開されません。これは下記のリアルタイム
共同編集が使う「あなたが誰か」を確立するだけです。

### 3. リアルタイム共同編集（オプトイン）

共同編集は**オンにしない限りオフ**です。メンバーを招待する（オーナーとして）か、
共有プロジェクトに参加する（メンバーとして）と、OPEN GROUND はリアルタイム同期を
有効化し、以下のデータが下記の外部クラウド基盤に送信・**保存**されます。

#### ログイン・メンバー管理サービスへ ── メンバー管理・コントロールプレーン

| データ | タイミング |
| --- | --- |
| あなたのメールアドレス、招待した相手のメールアドレス | 招待時 / 参加時 |
| メンバーごとのユーザー ID (UUID) | 参加時 |
| 共有プロジェクトの**表示名**（メンバーに見せる名前） | オーナーが設定したとき |
| 招待コード、モード（オープン / 承認）、上限、有効期限（既定 7 日） | オーナーがリンクを発行したとき |
| 参加リクエスト（メール + 状態）※承認モード | メンバーが参加申請したとき |

メンバーのメールアドレスは、オーナーと同じプロジェクトの他メンバー（名簿）に表示
されます。**ローカルのファイルパスは送信されません** ── プロジェクトは
（オーナー ID + パス）の一方向ハッシュをキーとします。

#### リアルタイム同期サーバ・クラウドストレージへ

共有プロジェクトの **Board と Canvas の中身**は**リアルタイム同期サーバ**
（ライブ同期のハブ）を通り、再接続やオフライン作業のためにクラウドストレージに
**保存され続けます**。

- **Board：** タスクのタイトル、説明、メモ、状態、並び順、プロジェクト設定
  （担当者、レビュー列、完了フロー、対象ブランチ、設定した検証コマンドなど）。
- **Canvas：** すべての要素 ── 付箋、テキスト、フレーム、コメント、画像、そして
  **mock / screen 要素（書き込んだ HTML/React のソースコードを含む）**。
- Canvas に置いた**画像**はクラウドオブジェクトストレージにアップロードされます
  （画像のみ・1 枚あたり最大 10 MB）。

> **平たく言うと：** 共同編集をオンにすると、Board と Canvas の中身 ── mock/screen
> 要素のソースコードや画像を含む ── が、あなたのマシンだけでなくクラウドにも
> 保存されます。リポジトリのファイル・ターミナル・Claude との会話は、依然として
> 一切送信されません。

### 4. 保持と削除

- **メンバー情報**（ログイン・メンバー管理サービスが保持）は、オーナーがメンバーを
  削除するかプロジェクトを削除するまで保持されます。
- **Board/Canvas の中身と画像**（同期サーバ・クラウドストレージが保持）は、
  プロジェクトが共有されている間保持されます。共有を停止すると以後の同期は止まり、
  プロジェクトを削除すると共有状態は削除されます。
- **招待コード**は自動的に失効し（既定 7 日）、オーナーはいつでも無効化できます。

### 5. インフラ提供者

リアルタイム共同編集は、共同編集を動かす目的だけに使う第三者のクラウド基盤の上で
動作します：

- **ログイン・メンバー管理サービス** ── 認証とメンバー情報の保存。
- **リアルタイム同期サーバ＋クラウドオブジェクトストレージ** ── Board/Canvas の
  中身のライブ同期・保存と、画像の保存。

OPEN GROUND はあなたのデータを販売せず、広告に使わず、共同編集を動かす目的で上記の
インフラ以外の第三者に送信しません。利用している具体的な提供者についてのお問い合わせ
は、アプリ内のフィードバックフォームまたは <https://open-ground.app/> までご連絡
ください。

### 6. あなたの選択肢

- **サインインも共同編集もせず**に OPEN GROUND をフルに使えます ── その場合、
  何もマシンの外に出ません。
- いつでも**共有を停止**できます。オーナーは招待リンクの無効化やメンバーの削除が
  可能です。
- お問い合わせ・削除のご依頼：アプリ内のフィードバックフォーム、または
  <https://open-ground.app/> の連絡先までご連絡ください。
