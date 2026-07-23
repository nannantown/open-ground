// ─────────────────────────────────────────────────────────────────────────
// OPEN GROUND — in-app manual content (bilingual EN/JA).
//
// This file is BOTH the user manual and the living product spec. Every claim
// here is grounded in the current implementation (audited 2026-06-13); where it
// disagrees with older docs (CONCEPT.md / DESIGN.md), THIS supersedes them.
//
// Content is data, not a wall of <t> keys: each text node carries its `en` and
// `ja` side by side so the two languages stay in lock-step and a future feature
// change is a one-line edit here. ManualPanel renders this tree; it reads the
// active language from useT().lang. When you change app behaviour, update the
// matching section so the manual keeps doubling as the spec.
// ─────────────────────────────────────────────────────────────────────────
import type { ReactNode } from 'react'
import {
  Compass,
  Rocket,
  FolderPlus,
  Columns3,
  Palette,
  Terminal,
  Puzzle,
  SlidersHorizontal,
  Keyboard,
  Workflow,
} from 'lucide-react'

/** One string in both languages. EN is the source of truth; JA mirrors it. */
export interface Bi {
  en: string
  ja: string
}

/** A renderable block. Inline `backtick` spans in `p`/`note`/`v` text render as
 *  code. Keep the vocabulary small so the renderer stays simple. */
export type Block =
  | { kind: 'p'; text: Bi }
  | { kind: 'subhead'; text: Bi }
  | { kind: 'steps'; items: Bi[] }
  | { kind: 'bullets'; items: Bi[] }
  | { kind: 'note'; tone?: 'info' | 'tip' | 'warn'; text: Bi }
  | { kind: 'rows'; mono?: boolean; rows: { k: string; v: Bi }[] }
  | { kind: 'diagram'; id: 'layers' | 'board' | 'data' }

export interface Section {
  id: string
  icon: ReactNode
  kicker: Bi
  title: Bi
  intro: Bi
  blocks: Block[]
}

const ICON = { size: 14, strokeWidth: 1.75 } as const

export const MANUAL_SECTIONS: Section[] = [
  // ───────────────────────────── 1 · What is it ─────────────────────────────
  {
    id: 'what',
    icon: <Compass {...ICON} />,
    kicker: { en: 'Overview', ja: '概要' },
    title: { en: 'What is OPEN GROUND?', ja: 'OPEN GROUND とは' },
    intro: {
      en: 'A local cockpit for Claude Code. It folds the "cd into a project, launch claude, repeat across a dozen windows" workflow onto one canvas.',
      ja: 'Claude Code のためのローカル・コックピット。「プロジェクトに cd して claude を起動、を何枚ものウィンドウで繰り返す」作業を、1枚のキャンバスに畳み込みます。',
    },
    blocks: [
      {
        kind: 'p',
        text: {
          en: 'Every project you register becomes a card on one infinite canvas — the Ground. A beacon lights up on any card where claude is at work, so you oversee many projects at a glance and launch into any of them without juggling terminal windows.',
          ja: '登録したプロジェクトは、1枚の無限キャンバス「グラウンド」のカードになります。claude が働いているカードにはビーコンが灯るので、たくさんのプロジェクトをひと目で見渡し、ターミナルの窓を切り替えることなくどれにでも飛び込めます。',
        },
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'Subscription-only. OPEN GROUND only ever drives the `claude` CLI you already have installed (Pro, Max, Team, or Enterprise). It never uses an Anthropic API key.',
          ja: 'サブスクリプション専用。OPEN GROUND は、すでにインストール済みの `claude` CLI（Pro・Max・Team・Enterprise）を動かすだけです。Anthropic の API キーは一切使いません。',
        },
      },
      { kind: 'diagram', id: 'layers' },
      {
        kind: 'p',
        text: {
          en: 'There are two layers. Layer 1 is the Ground — the portfolio of project cards, where the core experience is overview. Layer 2 opens when you click a card: a workspace for that one project with three tabs — Board, Canvas, and Terminal.',
          ja: '構造は2層です。レイヤー1はグラウンド —— プロジェクトカードのポートフォリオで、主役は「俯瞰」。レイヤー2はカードをクリックすると開く、そのプロジェクト専用のワークスペースで、Board・Canvas・Terminal の3タブで構成されます。',
        },
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'It is a local, single-user desktop app. The server reads and writes your filesystem and spawns `claude` as a child process, so it runs on your machine — it is not a hosted web app.',
          ja: 'ローカルの単一ユーザー向けデスクトップアプリです。サーバーがあなたのファイルシステムを読み書きし、`claude` を子プロセスとして起動するため、すべてあなたのマシン上で動きます —— ホスティングされた Web アプリではありません。',
        },
      },
    ],
  },

  // ───────────────────────────── 2 · Quickstart ─────────────────────────────
  {
    id: 'start',
    icon: <Rocket {...ICON} />,
    kicker: { en: 'Get started', ja: 'はじめに' },
    title: { en: 'Your first 3 minutes', ja: '最初の3分' },
    intro: {
      en: 'From zero to a task that runs itself.',
      ja: 'ゼロから、ひとりでに走るタスクまで。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Prerequisite — install Claude Code', ja: '前提 —— Claude Code を入れる' } },
      {
        kind: 'p',
        text: {
          en: 'OPEN GROUND runs your local `claude` CLI, so install it and sign in with a paid Claude plan first. On first launch the welcome screen checks for the CLI and walks you through installing it — with a live terminal — if it is missing.',
          ja: 'OPEN GROUND はローカルの `claude` CLI を動かします。まず CLI をインストールし、有料の Claude プランでサインインしてください。初回起動時のウェルカム画面が CLI の有無を確認し、無ければライブのターミナルつきでインストール手順を案内します。',
        },
      },
      { kind: 'subhead', text: { en: '1 · Add a project', ja: '1 · プロジェクトを追加する' } },
      {
        kind: 'steps',
        items: [
          {
            en: 'Top-right, click + → New project (creates a folder in your workspace) or Import folder (registers any folder you already have).',
            ja: '右上の ＋ → 「新規プロジェクト」（ワークスペースにフォルダを作成）か「フォルダをインポート」（既存のフォルダを登録）を選びます。',
          },
          {
            en: 'The card lands on the Ground and its panel opens automatically.',
            ja: 'カードがグラウンドに現れ、そのパネルが自動で開きます。',
          },
        ],
      },
      { kind: 'subhead', text: { en: '2 · Meet the three tabs', ja: '2 · 3つのタブを知る' } },
      {
        kind: 'p',
        text: {
          en: 'A project opens into Board (plan and run tasks), Canvas (design and brainstorm), and Terminal (raw claude or a shell).',
          ja: 'プロジェクトは Board（計画と実行）・Canvas（デザインとブレスト）・Terminal（生の claude やシェル）に展開します。',
        },
      },
      { kind: 'subhead', text: { en: '3 · Run your first task', ja: '3 · 最初のタスクを実行する' } },
      {
        kind: 'steps',
        items: [
          { en: 'On the Board, click "+ Add a card" and write what you want done.', ja: 'Board で「＋ カードを追加」を押し、やってほしいことを書きます。' },
          { en: 'Check its run settings — completion flow (Merge / Open a PR), model, effort.', ja: '実行設定を確認します —— 完了時の挙動（マージ / PR を作成）・モデル・effort。' },
          { en: 'Click Run (実行). A terminal opens and the task starts by itself, isolated in its own git worktree.', ja: '「実行」を押します。ターミナルが開き、専用の git worktree に隔離された状態でタスクがひとりでに始まります。' },
          { en: 'On finish, the work merges into your target branch — or opens a PR.', ja: '完了すると、作業は対象ブランチにマージされます —— あるいは PR を作成します。' },
        ],
      },
      {
        kind: 'note',
        tone: 'tip',
        text: {
          en: 'Prefer to drive claude yourself? Open the Terminal tab and just type. It is the same engine — no task card required.',
          ja: '自分で claude を操りたいなら、Terminal タブを開いてそのまま打つだけ。同じエンジンです —— タスクカードは不要です。',
        },
      },
    ],
  },

  // ─────────────────────────────── 3 · Ground ───────────────────────────────
  {
    id: 'ground',
    icon: <Compass {...ICON} />,
    kicker: { en: 'Layer 1', ja: 'レイヤー1' },
    title: { en: 'The Ground', ja: 'グラウンド（母艦）' },
    intro: {
      en: 'The home canvas — every project as a card, the surface you oversee and launch from.',
      ja: 'ホームのキャンバス。全プロジェクトをカードで俯瞰し、ここから起動する場所。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Cards & the beacon', ja: 'カードとビーコン' } },
      {
        kind: 'p',
        text: {
          en: 'Each card shows the project name, description, open-task count and a map coordinate. When a claude session is live in that project, a beacon appears: azure "Running" (a pulsing dot — claude is working) or amber "Waiting" (claude is waiting on you).',
          ja: '各カードにはプロジェクト名・説明・未着手タスク数・地図座標が出ます。そのプロジェクトで claude セッションが動いていると、ビーコンが灯ります —— 青の「Running」（点滅するドット = claude が作業中）か、琥珀の「Waiting」（claude があなたの番を待っている）。',
        },
      },
      {
        kind: 'p',
        text: {
          en: 'Click a card to open its panel. Shift-click several cards to multi-select; a bar appears to Remove or Delete them together.',
          ja: 'カードをクリックするとパネルが開きます。Shift＋クリックで複数選択でき、まとめて「削除」「ゴミ箱へ」するためのバーが現れます。',
        },
      },
      { kind: 'subhead', text: { en: 'Move around', ja: '移動する' } },
      {
        kind: 'bullets',
        items: [
          { en: 'Pan: scroll, or hold Space and drag (or middle-drag).', ja: 'パン：スクロール、または Space を押しながらドラッグ（中ボタンドラッグも可）。' },
          { en: 'Zoom: ⌘scroll or ⌘± ; ⇧1 fits everything, ⌘0 resets to 100%.', ja: 'ズーム：⌘スクロール か ⌘± 。⇧1 で全体にフィット、⌘0 で 100% に戻ります。' },
          { en: '⌘K opens the jump palette — fuzzy-find any project and fly straight to it.', ja: '⌘K でジャンプパレットが開きます —— あいまい検索で任意のプロジェクトへ一気に飛べます。' },
        ],
      },
      { kind: 'subhead', text: { en: 'Organize', ja: '整理する' } },
      {
        kind: 'p',
        text: {
          en: 'The left tool strip has Select (V), Text (T), Sticky (S) and Frame (F). Draw a frame around cards to group them — the frame label becomes that project’s category. Text and stickies are free annotations on the canvas.',
          ja: '左のツール列には 選択(V)・テキスト(T)・付箋(S)・フレーム(F) があります。カードをフレームで囲むとグループ化でき、フレームのラベルがそのプロジェクトのカテゴリになります。テキストと付箋はキャンバス上の自由な注釈です。',
        },
      },
      { kind: 'subhead', text: { en: 'The top bar', ja: 'トップバー' } },
      {
        kind: 'bullets',
        items: [
          { en: '+ — New project / Import folder.', ja: '＋ —— 新規プロジェクト / フォルダをインポート。' },
          { en: 'Usage — the gauge tracks your claude plan consumption (click to expand).', ja: 'Usage —— claude プランの使用量を表示するゲージ（クリックで展開）。' },
          { en: 'Settings (gear), plus Feedback and Account when they are configured.', ja: '設定（歯車）。加えて、設定済みなら フィードバック と アカウント。' },
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'Card position is a free workspace — it carries no system meaning. Arrange cards however helps you think; the beacon and summary carry the status, not the location.',
          ja: 'カードの位置は自由な作業場で、システム的な意味は持ちません。思考を助けるように好きに並べてください。状態を語るのは位置ではなく、ビーコンとサマリです。',
        },
      },
    ],
  },

  // ────────────────────────────── 4 · Projects ──────────────────────────────
  {
    id: 'projects',
    icon: <FolderPlus {...ICON} />,
    kicker: { en: 'Projects', ja: 'プロジェクト' },
    title: { en: 'Add & manage projects', ja: 'プロジェクトの追加と管理' },
    intro: {
      en: 'Your projects are a list you curate one at a time — nothing is auto-scanned.',
      ja: 'プロジェクトは自分で1つずつ登録するリスト。フォルダの自動スキャンはしません。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Add', ja: '追加する' } },
      {
        kind: 'bullets',
        items: [
          { en: 'New project — pick a parent workspace (remembered for next time), name the folder; OPEN GROUND creates and registers it.', ja: '新規プロジェクト —— 親となるワークスペースを選び（次回以降は記憶されます）、フォルダ名を付けると、OPEN GROUND が作成して登録します。' },
          { en: 'Import folder — register any existing folder, anywhere on disk.', ja: 'フォルダをインポート —— ディスク上のどこにある既存フォルダでも登録できます。' },
        ],
      },
      { kind: 'subhead', text: { en: 'If a folder goes missing', ja: 'フォルダが見つからなくなったら' } },
      {
        kind: 'p',
        text: {
          en: 'Move or delete a project’s folder outside the app and its card dims and shows "missing". Click Locate folder to point it at the new location — it keeps the same identity, so its tasks and canvases reconnect.',
          ja: 'アプリの外でプロジェクトのフォルダを移動・削除すると、カードは薄くなり「missing」と表示されます。「フォルダを特定」を押して新しい場所を指し示せば、同じ識別子を保ったまま、タスクとキャンバスが再びつながります。',
        },
      },
      { kind: 'subhead', text: { en: 'Remove vs Delete', ja: '「削除」と「ゴミ箱へ」' } },
      {
        kind: 'rows',
        mono: false,
        rows: [
          { k: 'Remove from Ground', v: { en: 'Unregisters the card. Your folder on disk is left completely untouched.', ja: 'カードの登録を解除します。ディスク上のフォルダには一切触れません。' } },
          { k: 'Delete', v: { en: 'Moves the folder to the Trash and erases the project’s OPEN GROUND data.', ja: 'フォルダをゴミ箱へ移し、そのプロジェクトの OPEN GROUND データを消去します。' } },
        ],
      },
      {
        kind: 'note',
        tone: 'warn',
        text: {
          en: 'Delete is destructive — it trashes the actual folder and removes the project’s central data. Remove only takes the card off the Ground.',
          ja: '「ゴミ箱へ」は破壊的です —— 実フォルダをゴミ箱に移し、中央データも削除します。「削除」はカードをグラウンドから外すだけです。',
        },
      },
      { kind: 'subhead', text: { en: 'Where the data goes', ja: 'データの行き先' } },
      {
        kind: 'p',
        text: {
          en: 'OPEN GROUND never writes into your repo. A project’s Board and Canvas data live centrally under `~/.openground/projects/<id>/` (see Reference → Where your data lives).',
          ja: 'OPEN GROUND はあなたのリポジトリに書き込みません。プロジェクトの Board・Canvas データは `~/.openground/projects/<id>/` の下に中央集約されます（リファレンス → データの保存場所 を参照）。',
        },
      },
    ],
  },

  // ─────────────────────────────── 5 · Board ────────────────────────────────
  {
    id: 'board',
    icon: <Columns3 {...ICON} />,
    kicker: { en: 'Layer 2 · Tab', ja: 'レイヤー2 · タブ' },
    title: { en: 'Board — plan & run', ja: 'ボード — 計画と実行' },
    intro: {
      en: 'A kanban where each card can launch its own isolated claude session.',
      ja: 'カンバン。各カードが自分専用の隔離された claude セッションを起動できる。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Columns', ja: '列' } },
      { kind: 'diagram', id: 'board' },
      {
        kind: 'p',
        text: {
          en: 'To do · In progress · In review · Done · Needs decision. All five columns are always shown. Drag cards between columns; dropping into Done marks a card done. Needs decision is a holding lane for cards waiting on your call — nothing moves out of it automatically.',
          ja: '未着手 · 実行中 · レビュー待ち · 完了 · 判断待ち。5つの列は常に表示されます。カードは列をまたいでドラッグでき、完了に落とすとそのカードは完了扱いになります。判断待ちはあなたの決裁を待つ保留レーンで、自動では動きません。',
        },
      },
      { kind: 'subhead', text: { en: 'Run a task', ja: 'タスクを実行する' } },
      {
        kind: 'p',
        text: {
          en: 'Click a card to open its drawer, write a title and notes, then click Run (実行). OPEN GROUND composes a task prompt and starts claude in a fresh git worktree — so each task is isolated and two tasks never share a checkout.',
          ja: 'カードをクリックしてドロワーを開き、タイトルとメモを書いて「実行」を押します。OPEN GROUND がタスクのプロンプトを組み立て、新しい git worktree で claude を起動します —— だから各タスクは隔離され、2つのタスクが同じ作業ツリーを共有することはありません。',
        },
      },
      {
        kind: 'steps',
        items: [
          { en: 'Write a task in "+ Add a card".', ja: '「＋ カードを追加」にやることを書く。' },
          { en: 'Check its run settings — completion flow (Merge / Open a PR), model, effort.', ja: '実行設定を確認する —— 完了時（マージ / PR を作成）・モデル・effort。' },
          { en: 'Run — the terminal opens and the task starts by itself.', ja: '実行する —— ターミナルが開き、タスクがひとりでに走る。' },
          { en: 'On finish, the work merges into your target branch (or opens a PR).', ja: '完了すると、作業は対象ブランチにマージされる（または PR を作成）。' },
        ],
      },
      { kind: 'subhead', text: { en: 'Run settings', ja: '実行設定' } },
      {
        kind: 'p',
        text: {
          en: 'The strip above the board sets the board-wide defaults: completion flow (when git is enabled), model, effort and permission mode. Any card can override them in its own drawer.',
          ja: 'ボード上部のストリップが、ボード全体の既定値を決めます —— 完了時の挙動（git 有効時）・モデル・effort・権限モード。各カードはドロワーで個別に上書きできます。',
        },
      },
      { kind: 'subhead', text: { en: 'Hand the task over yourself', ja: '自分でタスクを渡す' } },
      {
        kind: 'p',
        text: {
          en: 'Inside a live session, "Insert task into input" pastes the task title and notes into the terminal UNSENT — you review and press Enter. Nothing is ever auto-sent on your behalf.',
          ja: 'ライブセッション中、「タスクを入力欄に挿入」はタスクのタイトルとメモをターミナルに未送信で貼り付けます —— あなたが確認して Enter を押します。あなたの代わりに勝手に送信されることはありません。',
        },
      },
      { kind: 'subhead', text: { en: 'Review & finish', ja: 'レビューと完了' } },
      {
        kind: 'bullets',
        items: [
          { en: 'PR-flow tasks land in In review with a PR link.', ja: 'PR フローのタスクは、PR リンクつきで「レビュー待ち」に届きます。' },
          { en: '"Review with claude" opens a diff-review session in the task’s worktree; "Try this branch locally" opens that worktree in Finder.', ja: '「claude でレビュー」はタスクの worktree で差分レビューのセッションを開き、「このブランチをローカルで試す」はその worktree を Finder で開きます。' },
          { en: 'When the PR is merged (you merge it), a Merged chip appears — click → Done. The move is never automatic.', ja: 'PR がマージされると（マージするのはあなた）「Merged」チップが出ます —— 「→ 完了」を押して動かします。自動では動きません。' },
        ],
      },
      { kind: 'subhead', text: { en: 'Find things', ja: '見つける' } },
      {
        kind: 'bullets',
        items: [
          { en: 'Mine only (needs a display name) filters to your cards; the search box filters by title and notes.', ja: '「自分のみ」（表示名が必要）で自分のカードに絞り込み、検索ボックスでタイトルとメモを絞り込みます。' },
          { en: '⌘Z / ⇧⌘Z undo and redo board edits.', ja: '⌘Z / ⇧⌘Z でボード編集を取り消し・やり直しします。' },
        ],
      },
      {
        kind: 'note',
        tone: 'tip',
        text: {
          en: 'Opening a card never starts a session — only Run does. So a teammate can open a card to review it without spawning work on their machine.',
          ja: 'カードを開いてもセッションは始まりません —— 起動するのは「実行」だけです。だから同僚は、自分のマシンで作業を走らせることなくカードを開いてレビューできます。',
        },
      },
    ],
  },

  // ─────────────────────────────── 6 · Canvas ───────────────────────────────
  {
    id: 'canvas',
    icon: <Palette {...ICON} />,
    kicker: { en: 'Layer 2 · Tab', ja: 'レイヤー2 · タブ' },
    title: { en: 'Canvas — design & brainstorm', ja: 'キャンバス — デザインとブレスト' },
    intro: {
      en: 'A Figma-style surface, plus live React/HTML previews and design-with-claude.',
      ja: 'Figma ライクな面。ライブの React/HTML プレビューと、claude と組むデザインつき。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Pages', ja: 'ページ' } },
      {
        kind: 'p',
        text: {
          en: 'Each project holds multiple Canvases — Chrome-style tabs in the left Pages list (add, rename, reorder, delete). Use them for different purposes: design, roadmap, scratch.',
          ja: '各プロジェクトは複数のキャンバスを持てます —— 左の「ページ」一覧に並ぶ Chrome 風タブ（追加・改名・並べ替え・削除）。用途別に使い分けてください：デザイン、ロードマップ、走り書き。',
        },
      },
      { kind: 'subhead', text: { en: 'Elements', ja: '要素' } },
      {
        kind: 'p',
        text: {
          en: 'Place sticky notes, text, frames, shapes (rectangle / ellipse), images, comment pins, and mocks. Tools: Select (V), Text (T), Sticky (S), Frame (F), Rect (R), Ellipse (O), Comment (C), Image (I).',
          ja: '付箋・テキスト・フレーム・図形（長方形 / 楕円）・画像・コメントピン・モックを配置できます。ツール：選択(V)・テキスト(T)・付箋(S)・フレーム(F)・長方形(R)・楕円(O)・コメント(C)・画像(I)。',
        },
      },
      { kind: 'subhead', text: { en: 'Figma parity', ja: 'Figma 同等' } },
      {
        kind: 'bullets',
        items: [
          { en: 'Layers panel (left) — a tree with search, lock and hide, and drag-to-reorder.', ja: 'レイヤーパネル（左）—— 検索・ロック・非表示・ドラッグ並べ替えができるツリー。' },
          { en: 'Inspector (right) — position/size, fill/stroke/text, alignment, and auto-layout on frames.', ja: 'インスペクタ（右）—— 位置/サイズ・塗り/線/テキスト・整列、フレームのオートレイアウト。' },
          { en: '⌘\\ hides both sidebars for a focused view.', ja: '⌘\\ で両サイドバーを隠し、集中ビューにします。' },
        ],
      },
      { kind: 'subhead', text: { en: 'Live previews (mocks)', ja: 'ライブプレビュー（モック）' } },
      {
        kind: 'p',
        text: {
          en: 'A mock renders real React or HTML inside a sandboxed iframe — the same idea as Claude Artifacts. Click it to interact with the live page.',
          ja: 'モックは本物の React や HTML を、サンドボックス化された iframe の中で描画します —— Claude Artifacts と同じ考え方です。クリックすればライブのページを操作できます。',
        },
      },
      { kind: 'subhead', text: { en: 'Design with claude', ja: 'claude とデザインする' } },
      {
        kind: 'bullets',
        items: [
          { en: 'The ✦ button opens a prompt bar — describe a layout and claude generates native canvas elements at your viewport.', ja: '✦ ボタンでプロンプトバーが開きます —— レイアウトを言葉で伝えると、claude が表示中の位置にネイティブのキャンバス要素を生成します。' },
          { en: 'Select a mock, turn on inspect, click an element inside it and type an instruction ("make the button red") — claude rewrites the source and the preview updates.', ja: 'モックを選んでインスペクトを有効にし、中の要素をクリックして指示を打つと（「ボタンを赤く」）—— claude がソースを書き換え、プレビューが更新されます。' },
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'Canvas AI is subscription-only too — generation needs the `claude` CLI installed and signed in.',
          ja: 'キャンバスの AI もサブスクリプション専用です —— 生成には `claude` CLI のインストールとサインインが必要です。',
        },
      },
    ],
  },

  // ────────────────────────────── 7 · Terminal ──────────────────────────────
  {
    id: 'terminal',
    icon: <Terminal {...ICON} />,
    kicker: { en: 'Layer 2 · Tab', ja: 'レイヤー2 · タブ' },
    title: { en: 'Terminal — the only execution path', ja: 'ターミナル — 唯一の実行経路' },
    intro: {
      en: 'Real PTY panes running your login shell or claude. Everything that runs, runs here.',
      ja: '本物の PTY ペイン。ログインシェルか claude が動く。実行はすべてここを通る。',
    },
    blocks: [
      {
        kind: 'p',
        text: {
          en: 'The Terminal tab tiles up to 6 panes side by side, each a real terminal opened in the project folder. Type `claude` yourself, or run a Board task to get a pre-configured claude session.',
          ja: 'Terminal タブは最大6ペインを横に並べます。それぞれがプロジェクトのフォルダで開かれた本物のターミナルです。自分で `claude` と打っても、Board のタスクを実行して設定済みの claude セッションを得てもかまいません。',
        },
      },
      { kind: 'subhead', text: { en: 'Panes', ja: 'ペイン' } },
      {
        kind: 'bullets',
        items: [
          { en: '"+ New" adds a pane (1 pane = full width; more split evenly).', ja: '「＋ 新規」でペインを追加（1ペインなら全幅、増えると均等に分割）。' },
          { en: 'Double-click a pane’s label to rename it; the close button appears once more than one pane is open.', ja: 'ペインのラベルをダブルクリックで改名。閉じるボタンは、ペインが2つ以上のときに現れます。' },
          { en: 'Reorder by dragging the pane header, or Alt+←/→.', ja: 'ペインのヘッダをドラッグ、または Alt+←/→ で並べ替え。' },
        ],
      },
      { kind: 'subhead', text: { en: 'Sessions', ja: 'セッション' } },
      {
        kind: 'p',
        text: {
          en: 'A pane keeps its session across reloads. A session ends when you close its pane, when claude quits (/quit), or when the app restarts — there is no separate restart button.',
          ja: 'ペインはリロードをまたいでセッションを保ちます。セッションが終わるのは、ペインを閉じたとき・claude が終了したとき（/quit）・アプリが再起動したとき —— 専用の再起動ボタンはありません。',
        },
      },
      { kind: 'subhead', text: { en: 'Handy', ja: '便利な操作' } },
      {
        kind: 'bullets',
        items: [
          { en: 'Paste an image (⌘V) — it is saved and its path is pasted, so claude can read it.', ja: '画像を貼り付け（⌘V）—— 保存され、そのパスが貼られるので、claude が読み込めます。' },
          { en: 'Shift+Enter inserts a newline in claude’s prompt without sending.', ja: 'Shift+Enter で claude のプロンプトに、送信せず改行を入れます。' },
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'Subscription-only — OPEN GROUND drives your `claude` CLI through the terminal, never an API key. The Ground beacon is derived from these live sessions.',
          ja: 'サブスクリプション専用 —— OPEN GROUND はターミナル越しにあなたの `claude` CLI を動かします。API キーは使いません。グラウンドのビーコンは、これらのライブセッションから導かれます。',
        },
      },
    ],
  },

  // ──────────────────────────── 8 · Custom tabs ─────────────────────────────
  {
    id: 'custom',
    icon: <Puzzle {...ICON} />,
    kicker: { en: 'Advanced', ja: '上級' },
    title: { en: 'Custom tabs', ja: 'カスタムタブ' },
    intro: {
      en: 'Build your own per-project tab, edit it with claude, and share it through a marketplace.',
      ja: 'プロジェクトタブを自作し、claude で編集し、マーケットで共有する。',
    },
    blocks: [
      {
        kind: 'p',
        text: {
          en: 'Click + in the tab row to open your module library, then "Create new" to make a custom tab. It renders your `source.tsx` (React) or `source.html` in a sandboxed iframe.',
          ja: 'タブ列の ＋ を押してモジュールのライブラリを開き、「新規作成」でカスタムタブを作ります。あなたの `source.tsx`（React）か `source.html` を、サンドボックス化された iframe で描画します。',
        },
      },
      { kind: 'subhead', text: { en: 'Edit with claude', ja: 'claude で編集する' } },
      {
        kind: 'p',
        text: {
          en: 'A claude terminal opens beside the tab, working in the module’s folder (`~/.openground/custom-modules/<id>/`). Edit the source and the preview hot-reloads.',
          ja: 'タブの横に claude のターミナルが開き、モジュールのフォルダ（`~/.openground/custom-modules/<id>/`）で作業します。ソースを編集すると、プレビューがホットリロードされます。',
        },
      },
      { kind: 'subhead', text: { en: 'Library & marketplace', ja: 'ライブラリとマーケット' } },
      {
        kind: 'bullets',
        items: [
          { en: 'Attach / Detach a module per project (Detach is non-destructive).', ja: 'モジュールはプロジェクトごとに アタッチ / デタッチ（デタッチは非破壊）。' },
          { en: 'Publish a module to the marketplace; install published ones into your library.', ja: 'モジュールをマーケットに公開し、公開済みのものを自分のライブラリにインストール。' },
          { en: 'Roles: an owner authors and publishes; a tester can install; everyone else sees existing tabs read-only.', ja: 'ロール：owner は作成・公開でき、tester はインストール可、それ以外は既存タブを読み取り専用で閲覧。' },
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'Roles are enforced on the server (Supabase, RLS); client gating is cosmetic. The marketplace appears only when it is configured.',
          ja: 'ロールはサーバー側（Supabase・RLS）で強制されます。クライアント側のガードは見た目だけです。マーケットは設定済みのときだけ表示されます。',
        },
      },
    ],
  },

  // ────────────────────── 10 · Settings / login / usage ─────────────────────
  {
    id: 'settings',
    icon: <SlidersHorizontal {...ICON} />,
    kicker: { en: 'Advanced', ja: '上級' },
    title: { en: 'Settings, login & usage', ja: '設定・ログイン・使用量' },
    intro: {
      en: 'Preferences, an optional account, and your Claude usage at a glance.',
      ja: '設定、任意のアカウント、Claude 使用量のひと目把握。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Settings', ja: '設定' } },
      {
        kind: 'bullets',
        items: [
          { en: 'Language — EN / JA (it also steers the language claude replies in).', ja: '言語 —— EN / JA（claude が返信する言語にも反映されます）。' },
          { en: 'Display name — your name on shared boards.', ja: '表示名 —— 共有ボードでのあなたの名前。' },
          { en: 'Advanced — default workspace, and a Claude CLI re-check.', ja: '詳細 —— 既定ワークスペースと、Claude CLI の再チェック。' },
        ],
      },
      { kind: 'subhead', text: { en: 'Work mode (lockdown)', ja: '業務モード（ロックダウン）' } },
      {
        kind: 'p',
        text: {
          en: 'For confidential machines: Settings → Advanced → Work mode is a one-toggle kill switch for every connection that isn’t your own Claude. While it is on, OPEN GROUND stops talking to anything else — update checks, release notes, feedback, the marketplace, sign-in (including token refreshes for an existing login), and shared projects are all disabled, and the server refuses any other outbound request as a backstop. Your claude CLI keeps working as usual — the whole point is “Claude only”.',
          ja: '機密情報を扱うマシン向け：設定 → 詳細設定 → 業務モード は、自分の Claude 以外のすべての通信を 1 トグルで止めるキルスイッチです。オンの間、OPEN GROUND は Claude 以外のどことも通信しません —— アップデート確認・リリースノート・フィードバック・マーケットプレイス・サインイン（ログイン済みセッションのトークン更新も含む）・共有プロジェクトはすべて無効になり、その他の外向き通信もサーバーが最後の砦として拒否します。claude CLI はそのまま使えます —— 「Claude だけ」がこのモードの目的です。',
        },
      },
      {
        kind: 'bullets',
        items: [
          {
            en: 'While it is on, a quiet badge at the top of Settings reminds you. Nothing else about the UI changes — the disabled entries simply disappear.',
            ja: 'オンの間は、設定パネル上部に控えめなバッジが表示されます。それ以外の UI は変わりません —— 無効になった項目が単に消えるだけです。',
          },
          {
            en: 'Turning it off restores everything, including a signed-in account you had before (the session is kept locally, never revoked).',
            ja: 'オフに戻せば全機能が復帰します。以前サインインしていたアカウントもそのまま戻ります（セッションはローカルに保持され、失効させません）。',
          },
          {
            en: 'It is a per-machine app setting (default off) — it never changes your projects or your Claude subscription.',
            ja: 'このマシンのアプリ設定です（既定オフ）—— プロジェクトや Claude サブスクリプションには一切影響しません。',
          },
          {
            en: 'The UI’s fonts are bundled with the app (never fetched from Google Fonts), and while work mode is on, Canvas Mocks / Screens / custom tabs that need a public CDN for their renderer show a “Blocked by work mode” placeholder instead of loading it — plain-HTML mocks keep rendering, sealed so their code cannot call out. Everything renders normally again when you turn work mode off.',
            ja: 'UI のフォントはアプリに同梱されており、Google Fonts へは接続しません。業務モード中、描画エンジンに公開 CDN が必要な Canvas の Mock・Screen・カスタムタブは、読み込む代わりに「業務モードによりブロック中」のプレースホルダを表示します（HTML の Mock はそのまま描画され、中のコードが外部へ通信できないよう封じられます）。オフに戻せば通常どおり描画されます。',
          },
        ],
      },
      { kind: 'subhead', text: { en: 'Optional login', ja: '任意のログイン' } },
      {
        kind: 'p',
        text: {
          en: 'You can sign in with Google or GitHub from the account menu, but OPEN GROUND works fully signed-out as a guest. The login gates nothing today — it is groundwork for upcoming features, and it is separate from your Claude subscription.',
          ja: 'アカウントメニューから Google か GitHub でサインインできますが、OPEN GROUND はサインアウトのゲストのままでも完全に動きます。このログインは今は何も制限しません —— 今後の機能のための土台で、Claude のサブスクリプションとは別物です。',
        },
      },
      { kind: 'subhead', text: { en: 'Usage', ja: '使用量' } },
      {
        kind: 'p',
        text: {
          en: 'The top-right gauge reads your claude plan usage (session and weekly), with reset countdowns. It scrapes `claude /usage` and falls back to a local estimate.',
          ja: '右上のゲージは claude プランの使用量（セッションと週次）と、リセットまでのカウントダウンを表示します。`claude /usage` を読み取り、失敗時はローカル推定にフォールバックします。',
        },
      },
      { kind: 'subhead', text: { en: 'Feedback', ja: 'フィードバック' } },
      {
        kind: 'p',
        text: {
          en: 'OPEN GROUND is in beta — the Feedback button (when enabled) sends a note straight to the maintainers, and directly shapes what gets fixed next.',
          ja: 'OPEN GROUND はベータ版です —— 「フィードバック」ボタン（有効時）はメンテナに直接届き、次に直すものを左右します。',
        },
      },
    ],
  },

  // ───────────────────────────── 11 · Swarm ─────────────────────────────
  {
    id: 'swarm',
    icon: <Workflow {...ICON} />,
    kicker: { en: 'Advanced · Experimental', ja: '上級 · 実験的機能' },
    title: { en: 'Swarm — parallel Claude workers', ja: 'Swarm — 並列 Claude ワーカー' },
    intro: {
      en: 'An opt-in engine that runs several `claude` sessions on Board cards in parallel. This section is the disclosure: exactly what it will do on its own, and what it never does without you.',
      ja: '複数の `claude` セッションを Board のカード上で並列に走らせる、オプトインのエンジンです。この章はその開示 —— ひとりでに何をするか、あなた抜きでは絶対に何をしないかを正確に説明します。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Turning it on', ja: '有効化する' } },
      {
        kind: 'p',
        text: {
          en: 'Swarm is hidden by default. Enable it from Settings → Experiments → Swarm orchestration. This only reveals the Swarm tab and its controls for you — nothing runs automatically. Every autonomous action inside stays off until you explicitly arm it. Once armed, worker dispatch now survives an app restart — see the next section for exactly what that means and does not mean.',
          ja: 'Swarm は既定では非表示です。設定 → 実験的機能 → Swarm オーケストレーション で有効化してください。これは Swarm タブと操作を可視化するだけで、それ自体では何も自動実行されません。中の自律的な操作はすべて、あなたが個別に明示オンにするまで動きません。一度オンにすると、worker 起動はアプリの再起動をまたいで生き残るようになりました —— 具体的に何がどうなるかは次の節で説明します。',
        },
      },
      { kind: 'subhead', text: { en: 'What starts on its own — and what never does', ja: 'ひとりでに始まるもの、絶対に始まらないもの' } },
      {
        kind: 'bullets',
        items: [
          {
            en: 'Worker dispatch (drain): starts only when you press the engine’s start switch in the Manager tab. It stops immediately on stop, and stays stopped across a restart — it never auto-resumes. (That "never auto-resumes" is about a project you explicitly stopped — it still applies. A project you had left switched ON is different: it now resumes automatically after a restart, with no action from you, unless you had stopped it or the app itself has been restarting repeatedly, in which case it stays off and you get a notification.)',
            ja: 'worker 起動（drain）：マネージャータブのエンジン起動スイッチを押したときだけ始まります。停止を押せば即座に止まり、再起動後も停止したままです —— 自動では再開しません。（この「自動では再開しません」は、あなたが明示的に停止していたプロジェクトについての話で、これは今も変わりません。一方、オンにしたままだったプロジェクトは話が別です —— アプリの再起動後、あなたが何もしなくても自動的に再開するようになりました。停止していた場合や、アプリ自体が短時間に繰り返し再起動している場合は例外で、その場合はオフのままになり通知が届きます。）',
          },
          {
            en: 'Integration (landing finished work on your trunk): the engine itself never pushes — it has no code path that moves your trunk, and regression tests pin that. The one thing it does on its own while running: when a worker finishes and its card reaches review, it wakes the manager — a `claude` session you can watch in the Swarm tab — if none is alive. Waking moves nothing by itself. Your trunk changes only when that manager session reviews the branch and lands it with a plain push (never `--force`); a conflicting push is aborted and nothing lands, and cards titled `[hold]` or touching high-risk paths are always held for your explicit approval.',
            ja: '統合（完了した作業を本流へ取り込む）：エンジン自身は push しません —— エンジンには本流を動かすコード経路そのものが無く、回帰テストがそれを固定しています。稼働中にひとりでに行うのは1つだけ：worker が作業を終えカードが review 列に届いたとき、マネージャー（Swarm タブで見られる `claude` セッション）の卓が不在なら起こします。起こすこと自体では何も動きません。本流が変わるのは、そのマネージャーセッションがブランチをレビューし、plain push（`--force` は一切なし）で取り込んだときだけです。衝突した push は中断され、何も取り込まれません。タイトルが `[hold]` のカードや高リスクなパスに触れた変更は、常にあなたの明示承認待ちとして保留されます。',
          },
          {
            en: 'Destructive git (force-push, `branch -D`, history rewrite) and other irreversible actions (deleting a project, publishing a release) are never automated by Swarm, regardless of any toggle — those always require your direct action.',
            ja: '破壊的な git 操作（force-push・`branch -D`・履歴の書き換え）や、その他の不可逆な操作（プロジェクトの削除・リリースの公開）は、どのスイッチをオンにしていても Swarm が自動で行うことは一切ありません —— 常にあなた自身の直接操作が必要です。',
          },
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'The engine’s start switch lives in the Manager tab. It is the single master switch, and stopping it is symmetric: worker dispatch and manager wake-ups stop together, and pressing stop always sticks — even across a restart, nothing you stopped comes back on by itself. What changed: the switch itself is no longer reset to off by an app restart. If you left it ON, it comes back ON by itself after a restart, with no action from you — you do not need to re-arm it every session anymore. (An app that keeps restarting in a short window is treated as suspect and held off instead, with a notification, so a broken update can’t spin up workers unattended forever.) (The separate auto-integrate switch is gone — the engine no longer has an integration path to arm.)',
          ja: 'エンジンの起動スイッチはマネージャータブにあります。これが唯一のマスタースイッチで、停止は対称です：worker 起動もマネージャーの自動起こしも一緒に止まり、一度停止を押せば——再起動をまたいでも——あなたが止めたものが勝手に戻ることはありません。変わったのはここです：このスイッチ自体は、もうアプリの再起動でオフに戻されなくなりました。オンにしたままにしていた場合、再起動後にあなたが何もしなくても自動的にオンへ戻ります —— 毎セッション再びオンにする必要はもう無くなりました。（短時間にアプリが繰り返し再起動している場合は「怪しい」とみなされ、通知とともに自動再開が見送られます —— 壊れた更新が無人のまま worker を延々と立ち上げ続けることがないように。）（かつての「自動統合」の別スイッチは廃止されました —— エンジンには arm すべき統合経路そのものがもう在りません。）',
        },
      },
    ],
  },

  // ───────────────────────────── 12 · Reference ─────────────────────────────
  {
    id: 'reference',
    icon: <Keyboard {...ICON} />,
    kicker: { en: 'Reference', ja: 'リファレンス' },
    title: { en: 'Reference', ja: 'リファレンス' },
    intro: {
      en: 'Keyboard shortcuts, where your data lives, and the architecture — for power users and implementers.',
      ja: 'ショートカット、データの保存場所、アーキテクチャ。上級者と実装者向け。',
    },
    blocks: [
      { kind: 'subhead', text: { en: 'Shortcuts · Ground', ja: 'ショートカット · グラウンド' } },
      {
        kind: 'rows',
        rows: [
          { k: '⌘K', v: { en: 'Jump-to-project palette (works even while typing).', ja: 'プロジェクトへジャンプ（入力中でも効きます）。' } },
          { k: 'N', v: { en: 'New project.', ja: '新規プロジェクト。' } },
          { k: '⌘R', v: { en: 'Reload the project list.', ja: 'プロジェクト一覧を再読み込み。' } },
          { k: 'V · T · S · F', v: { en: 'Select · Text · Sticky · Frame tool.', ja: '選択 · テキスト · 付箋 · フレーム ツール。' } },
          { k: '⌘Z · ⇧⌘Z', v: { en: 'Undo · redo.', ja: '取り消し · やり直し。' } },
          { k: '⌘D', v: { en: 'Duplicate selected elements.', ja: '選択要素を複製。' } },
          { k: '⇧1 · ⌘0', v: { en: 'Fit everything · reset zoom to 100%.', ja: '全体にフィット · ズームを 100% に。' } },
          { k: 'Arrows · ⇧Arrows', v: { en: 'Nudge 1px · 10px.', ja: '1px ナッジ · 10px。' } },
          { k: 'Esc', v: { en: 'Clear selection / close the open panel.', ja: '選択解除 / 開いているパネルを閉じる。' } },
        ],
      },
      { kind: 'subhead', text: { en: 'Shortcuts · Canvas', ja: 'ショートカット · キャンバス' } },
      {
        kind: 'rows',
        rows: [
          { k: 'V T S F R O C I', v: { en: 'Select · Text · Sticky · Frame · Rect · Ellipse · Comment · Image.', ja: '選択 · テキスト · 付箋 · フレーム · 長方形 · 楕円 · コメント · 画像。' } },
          { k: '✦', v: { en: 'Generate elements with claude.', ja: 'claude で要素を生成。' } },
          { k: '⌘\\', v: { en: 'Toggle focus mode (hide both sidebars).', ja: '集中モード（両サイドバーを隠す）。' } },
          { k: '⌘C · ⌘V · ⌘D', v: { en: 'Copy · paste · duplicate.', ja: 'コピー · 貼り付け · 複製。' } },
          { k: '⌥⌘C · ⌥⌘V', v: { en: 'Copy · paste style.', ja: 'スタイルをコピー · 貼り付け。' } },
          { k: '⌘G · ⇧⌘G', v: { en: 'Group · ungroup.', ja: 'グループ化 · 解除。' } },
          { k: '⌘⇧L · ⌘⇧H', v: { en: 'Lock · hide selection.', ja: '選択をロック · 非表示。' } },
          { k: '[ · ]', v: { en: 'Send to back · bring to front.', ja: '最背面へ · 最前面へ。' } },
          { k: '1–9 · 0', v: { en: 'Set opacity 10–90% · 100%.', ja: '不透明度 10–90% · 100%。' } },
        ],
      },
      { kind: 'subhead', text: { en: 'Shortcuts · Board · Terminal · Panel', ja: 'ショートカット · ボード · ターミナル · パネル' } },
      {
        kind: 'rows',
        rows: [
          { k: 'Click card', v: { en: 'Board: open the card drawer (never starts a session).', ja: 'ボード：カードのドロワーを開く（セッションは始まりません）。' } },
          { k: '⌘Z · ⇧⌘Z', v: { en: 'Board: undo · redo board edits.', ja: 'ボード：ボード編集の取り消し · やり直し。' } },
          { k: '⌘C · ⌘V', v: { en: 'Terminal: copy · paste (image paste saves a file).', ja: 'ターミナル：コピー · 貼り付け（画像はファイルとして保存）。' } },
          { k: '⇧Enter', v: { en: 'Terminal: newline without sending.', ja: 'ターミナル：送信せず改行。' } },
          { k: 'Alt+← / →', v: { en: 'Terminal: reorder panes.', ja: 'ターミナル：ペインを並べ替え。' } },
          { k: 'Ctrl+Tab', v: { en: 'Panel: cycle Board / Canvas / Terminal tabs.', ja: 'パネル：Board / Canvas / Terminal を循環。' } },
        ],
      },
      { kind: 'subhead', text: { en: 'Where your data lives', ja: 'データの保存場所' } },
      {
        kind: 'p',
        text: {
          en: 'OPEN GROUND keeps per-project data centrally, mirroring how Claude Code keeps state under `~/.claude/` — never inside your repo.',
          ja: 'OPEN GROUND はプロジェクトごとのデータを中央に保ちます —— Claude Code が `~/.claude/` に状態を置くのと同じ流儀で、リポジトリの中には置きません。',
        },
      },
      {
        kind: 'rows',
        rows: [
          { k: '~/.openground/settings.json', v: { en: 'Your project registry, default workspace, language.', ja: 'プロジェクト登録・既定ワークスペース・言語。' } },
          { k: '~/.openground/canvas.json', v: { en: 'Ground card positions and viewport.', ja: 'グラウンドのカード位置とビューポート。' } },
          { k: '~/.openground/projects/<id>/tasks.json', v: { en: 'A project’s board cards and notes.', ja: 'プロジェクトのボードカードとメモ。' } },
          { k: '~/.openground/projects/<id>/canvases/', v: { en: 'A project’s design canvases and their images.', ja: 'プロジェクトのデザインキャンバスと画像。' } },
          { k: '~/.openground/custom-modules/', v: { en: 'Your custom tab modules.', ja: '自作のカスタムタブモジュール。' } },
        ],
      },
      { kind: 'subhead', text: { en: 'Architecture', ja: 'アーキテクチャ' } },
      {
        kind: 'p',
        text: {
          en: 'A Vite + React SPA talks to a Hono server over a fixed loopback port. In dev, Vite serves the UI on :5174 and proxies /api to Hono on :47776; in production a single Hono process serves both on :47776. The whole thing ships as an Electron desktop app that forks the server and owns the window.',
          ja: 'Vite + React の SPA が、固定のループバックポート越しに Hono サーバーと対話します。開発時は Vite が :5174 で UI を配信し、/api を :47776 の Hono にプロキシ。本番は単一の Hono プロセスが :47776 で両方を配信します。全体は、サーバーを fork してウィンドウを持つ Electron デスクトップアプリとして配布されます。',
        },
      },
      {
        kind: 'note',
        tone: 'info',
        text: {
          en: 'This manual reflects the app as built and supersedes older docs (CONCEPT.md, DESIGN.md) wherever they disagree.',
          ja: 'このマニュアルは実装どおりのアプリを反映しており、食い違う箇所では旧ドキュメント（CONCEPT.md・DESIGN.md）より優先されます。',
        },
      },
    ],
  },
]
