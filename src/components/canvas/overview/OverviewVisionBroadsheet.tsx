// OPEN GROUND — Overview tab content
//
// This is the editorial "Vision Broadsheet" that currently fills the Overview
// tab. Previously lived inline in ProjectPanel.tsx, extracted in Phase 5.1 so
// ProjectPanel can shrink to its actual UI-orchestration job (~3.2k → ~2.7k
// lines). The dashboard-style replacement Plan v2.3 §5.1 mentions is a future
// edit on this file rather than a ProjectPanel.tsx churn.
//
// Editing this file: the broadsheet is purely presentational — no props,
// no callbacks beyond the project + data being shown. Feel free to swap
// sections in/out; ProjectPanel just renders <OverviewVisionBroadsheet />.

import {
  Building2,
  Check,
  Compass,
  Info,
  Layers,
  Map as MapIcon,
  MessageCircle,
  Moon,
  Mountain,
  Sparkles,
  Target,
  Terminal,
  Trees,
  Users,
  Waves,
} from 'lucide-react'
import type { ProjectData, ProjectMeta } from '@/lib/types'

export const OverviewVisionBroadsheet = ({
  data,
  project,
}: {
  data: ProjectData
  project: ProjectMeta
}) => {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-bg">
      <article className="mx-auto max-w-[920px] px-10 py-12 space-y-14">
        <VisionMasthead />
        <VisionPillars />
        <ThemedGroundsAtlas />
        <InnerCanvasDiagram />
        <OffPeakStrip />
        <RoadmapSurvey />
        <ClosingCreed />
        <VisionDocFooter project={project} data={data} />
      </article>
    </div>
  )
}

// --- Vision broadsheet pieces -----------------------------------------------

const VisionStamp = ({ k, v }: { k: string; v: string }) => (
  <div>
    <dt className="label-cap text-ink-faint">{k}</dt>
    <dd className="mt-0.5 font-display text-[14px] tracking-tight text-ink">{v}</dd>
  </div>
)

const VisionMasthead = () => (
  <header className="space-y-6">
    <div className="flex items-center gap-3">
      <span className="font-mono text-[10px] text-accent tracking-normal">N 35°41′</span>
      <span className="h-px flex-1 bg-line" />
      <span className="label-cap text-ink-faint">Vision Broadsheet · Vol. 01</span>
      <span className="h-px w-16 bg-line" />
      <span className="font-mono text-[10px] text-accent tracking-normal">E 139°41′</span>
    </div>
    <h1
      className="font-display text-[64px] leading-[0.95] tracking-tightest text-ink"
      style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
    >
      <span className="text-accent">OPEN GROUND</span>
      <span className="text-ink-faint">.</span>
    </h1>
    <p className="max-w-[600px] text-[15px] leading-[1.75] text-ink-muted">
      作業の窓ではなく、<em className="not-italic text-ink">育てる地面</em>。
      ひとつのキャンバスに自分のプロジェクトを森や街のように積み上げ、
      AI が一緒に住み込み、夜のあいだも黙々と手を動かす——
      そういう道具を、これから Ground と呼ぶ。
    </p>
    <dl className="flex flex-wrap gap-x-10 gap-y-4 border-t border-line-soft pt-5">
      <VisionStamp k="Brand" v="OPEN GROUND" />
      <VisionStamp k="Posture" v="Local · single-user" />
      <VisionStamp k="Compass" v="Joyful AI cohabitation" />
      <VisionStamp k="Drafted" v="2026-05-24" />
    </dl>
  </header>
)

const SectionRail = ({
  no,
  eyebrow,
  title,
}: {
  no: string
  eyebrow: string
  title: string
}) => (
  <header className="flex items-end justify-between gap-6 border-b border-line pb-3">
    <div>
      <p className="label-cap text-accent">{eyebrow}</p>
      <h2 className="mt-1 font-display text-[26px] leading-tight tracking-tightest text-ink">
        {title}
      </h2>
    </div>
    <span className="font-mono text-[10px] text-ink-faint">§ {no}</span>
  </header>
)

type Pillar = {
  n: string
  icon: React.ReactNode
  title: string
  body: string
}

const PILLARS: Pillar[] = [
  {
    n: '01',
    icon: <Sparkles size={13} strokeWidth={1.75} />,
    title: 'Rename / 名乗り',
    body: '「Hove」を畳む。これからは OPEN GROUND——「拓かれた地面」というニュアンスで、自分のプロジェクト全部を上から見渡せる一枚の地面として育てる。',
  },
  {
    n: '02',
    icon: <MapIcon size={13} strokeWidth={1.75} />,
    title: 'Cultivable Canvas / 育てる地面',
    body: 'プロジェクト一覧は無味乾燥なリストではなく、森・海・街を建てていくゲーム世界として描く。タスクを通すたびに地形と道具が増える。',
  },
  {
    n: '03',
    icon: <Users size={13} strokeWidth={1.75} />,
    title: 'Companions / 住人たち',
    body: 'Claude をモチーフにした蟹のような小さなキャラクターが住み着く。RPG のように歩き、しゃがみ、作業しているのが見えるアニメーション。',
  },
  {
    n: '04',
    icon: <MessageCircle size={13} strokeWidth={1.75} />,
    title: 'Reception / 村長',
    body: '公式の受付小屋を Ground に置く。寄って話しかければ、このアプリの仕組み・使い方を Claude Code 経由で答えてくれる案内 NPC。',
  },
  {
    n: '05',
    icon: <Compass size={13} strokeWidth={1.75} />,
    title: 'Themed Grounds / 自分のテーマ',
    body: '近未来・恐竜世界・自然たっぷり・都会的——テーマを選び、組み合わせ、自分だけの Ground を仕立てる。',
  },
  {
    n: '06',
    icon: <Target size={13} strokeWidth={1.75} />,
    title: 'Milestones / 旅程',
    body: 'タスク単位の指示の上に、プロジェクト全体を見渡すマイルストーン階層を載せる。Ground は目的地を知っている。',
  },
  {
    n: '07',
    icon: <Moon size={13} strokeWidth={1.75} />,
    title: 'Off-Peak Engine / 夜間運転',
    body: 'トークンが余る時間帯——寝ているあいだ——を Ground が自走する。マイルストーンに沿ってレビューや微修正を黙って積み重ねる。',
  },
  {
    n: '08',
    icon: <Layers size={13} strokeWidth={1.75} />,
    title: 'Inner Canvas / 内側のキャンバス',
    body: 'プロジェクトを開くと、Figma のように拡大縮小できる無限キャンバス。デザインも表計算も成果物も、コードと同じ地面の上で扱う。',
  },
]

const VisionPillars = () => (
  <section className="space-y-6">
    <SectionRail no="I" eyebrow="Eight Pillars" title="What Ground is made of." />
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[4px] bg-line-soft sm:grid-cols-2">
      {PILLARS.map(p => (
        <article
          key={p.n}
          className="bg-bg-card p-6 transition-colors hover:bg-bg-elevated"
        >
          <header className="mb-2.5 flex items-baseline gap-3">
            <span className="font-mono text-[11px] tracking-cartographic text-accent">
              {p.n}
            </span>
            <span className="text-ink-subtle">{p.icon}</span>
            <h3 className="font-display text-[17px] leading-snug tracking-tightest text-ink">
              {p.title}
            </h3>
          </header>
          <p className="text-[12.5px] leading-[1.75] text-ink-muted">{p.body}</p>
        </article>
      ))}
    </div>
  </section>
)

type GroundTheme = {
  key: string
  ja: string
  en: string
  note: string
  icon: React.ReactNode
  swatchClass: string
  accentClass: string
}

const THEMES: GroundTheme[] = [
  {
    key: 'future',
    ja: '近未来',
    en: 'Future',
    note: 'ネオン・ガラス・浮遊する地形。',
    icon: <Sparkles size={13} strokeWidth={1.75} />,
    swatchClass: 'bg-azure-soft',
    accentClass: 'text-azure',
  },
  {
    key: 'mesozoic',
    ja: '恐竜世界',
    en: 'Mesozoic',
    note: '原生林、湖、骨格の痕。',
    icon: <Mountain size={13} strokeWidth={1.75} />,
    swatchClass: 'bg-ochre-soft',
    accentClass: 'text-ochre',
  },
  {
    key: 'wild',
    ja: '自然',
    en: 'Wild',
    note: '森と湿原、霧、苔の道。',
    icon: <Trees size={13} strokeWidth={1.75} />,
    swatchClass: 'bg-moss-soft',
    accentClass: 'text-moss',
  },
  {
    key: 'urban',
    ja: '都会',
    en: 'Urban',
    note: '高架、看板、路地裏。',
    icon: <Building2 size={13} strokeWidth={1.75} />,
    swatchClass: 'bg-accent-soft',
    accentClass: 'text-accent',
  },
  {
    key: 'tidal',
    ja: '海辺',
    en: 'Tidal',
    note: '砂洲、桟橋、潮の匂い。',
    icon: <Waves size={13} strokeWidth={1.75} />,
    swatchClass: 'bg-bg-inset',
    accentClass: 'text-ink-muted',
  },
]

const ThemedGroundsAtlas = () => (
  <section className="space-y-6">
    <SectionRail
      no="II"
      eyebrow="Themed Grounds"
      title="A small atlas of climates to choose from."
    />
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {THEMES.map(t => (
        <article
          key={t.key}
          className="overflow-hidden rounded-[2px] border border-line-soft bg-bg-card shadow-card"
        >
          <div className={['relative h-14', t.swatchClass].join(' ')}>
            <span
              className={[
                'absolute left-2.5 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-bg-card/80 shadow-card',
                t.accentClass,
              ].join(' ')}
            >
              {t.icon}
            </span>
          </div>
          <div className="px-3 py-2.5">
            <p className={['label-cap', t.accentClass].join(' ')}>{t.en}</p>
            <p className="font-display text-[14px] tracking-tightest text-ink">
              {t.ja}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-ink-muted">{t.note}</p>
          </div>
        </article>
      ))}
    </div>
    <p className="text-[12px] leading-relaxed text-ink-faint">
      テーマは Ground の地形・色・住人 NPC の振る舞いを規定する。混ぜることもできる。
    </p>
  </section>
)

const InnerCanvasDiagram = () => {
  const tabs = [
    { name: 'Chats', icon: <Check size={10} strokeWidth={2.25} />, state: 'past' as const },
    { name: 'Terminal', icon: <Terminal size={10} strokeWidth={2.25} />, state: 'past' as const },
    { name: 'Canvas', icon: <MapIcon size={10} strokeWidth={2.25} />, state: 'new' as const },
    { name: 'Overview', icon: <Info size={10} strokeWidth={2.25} />, state: 'past' as const },
  ]
  const surfaces = [
    { label: 'Design board', body: 'モックアップ・図解・ムードを置く。' },
    { label: 'Spreadsheet', body: '計算と表。Excel 的なグリッド。' },
    { label: 'Free notes', body: '断片・写真・URL、何でも貼る。' },
  ]
  return (
    <section className="space-y-6">
      <SectionRail
        no="III"
        eyebrow="Layer 2 Preview"
        title="The Inner Canvas — a fourth tab."
      />
      <div className="rounded-[4px] border border-line bg-bg-card p-6 shadow-card">
        <div className="flex items-end gap-5 border-b border-line">
          {tabs.map(t => (
            <div
              key={t.name}
              className={[
                '-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 label-cap',
                t.state === 'new'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-faint',
              ].join(' ')}
            >
              {t.icon}
              <span>{t.name}</span>
              {t.state === 'new' && (
                <span className="ml-1 rounded-[2px] border border-accent px-1 font-mono text-[8.5px] leading-[1.4] tracking-normal text-accent">
                  NEW
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {surfaces.map(s => (
            <div
              key={s.label}
              className="rounded-[2px] border border-dashed border-line bg-bg px-3 py-3"
            >
              <p className="label-cap text-ink-muted">{s.label}</p>
              <p className="mt-1 text-[11.5px] leading-snug text-ink-faint">{s.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-5 text-[12.5px] leading-[1.75] text-ink-muted">
          Figma のように自由に拡大縮小・パンできる無限キャンバスを、各プロジェクトの中に持つ。
          コーディングだけでなく、プロジェクトに関わるあらゆる成果物——デザイン、表、ノート——を
          同じ「地面」の上で並べて扱う。
        </p>
      </div>
    </section>
  )
}

const OFF_PEAK_HOURS = new Set<number>([0, 1, 2, 3, 4, 5, 23])

const OffPeakStrip = () => (
  <section className="space-y-6">
    <SectionRail
      no="IV"
      eyebrow="Nocturnal"
      title="Ground keeps working while you sleep."
    />
    <div className="rounded-[4px] border border-line-soft bg-bg-card p-6 shadow-card">
      <div className="mb-2 flex items-center justify-between font-mono text-[10px] text-ink-faint">
        <span>00</span>
        <span className="label-cap font-sans text-ink-faint">Local 24h</span>
        <span>24</span>
      </div>
      <div className="flex h-9 overflow-hidden rounded-[2px] border border-line">
        {Array.from({ length: 24 }).map((_, h) => {
          const active = OFF_PEAK_HOURS.has(h)
          const heavy = h > 0 && h % 6 === 0
          return (
            <div
              key={h}
              className={[
                'flex-1',
                heavy ? 'border-l border-line' : 'border-l border-line-soft first:border-l-0',
                active ? 'bg-azure-soft' : 'bg-bg-elevated',
              ].join(' ')}
            />
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-5 label-cap text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-[1px] bg-azure-soft border border-azure/40" />
          自走する時間
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-[1px] bg-bg-elevated border border-line" />
          休む時間
        </span>
      </div>
      <p className="mt-4 text-[12.5px] leading-[1.75] text-ink-muted">
        Claude のトークン枠が静かに開く時間帯——多くはユーザーが寝ているあいだ——を Ground が見計らって、
        登録済みのマイルストーンへ向かう小さなタスクを順に流す。
        コードレビュー、リファクタの提案、テストの増補。朝、画面を開くと一段先に進んでいる。
      </p>
    </div>
  </section>
)

type RoadmapStop = {
  stage: string
  label: string
  title: string
  body: string
  status: 'now' | 'next' | 'later' | 'horizon'
}

const ROADMAP: RoadmapStop[] = [
  {
    stage: '01',
    label: 'Foundation',
    title: '今の機能を OPEN GROUND の土台に据える',
    body: 'カンバス・ランナー・ターミナル・チャット——既存の機能はそのまま使える状態を保ったまま、名乗りと語彙を OPEN GROUND に揃える。',
    status: 'now',
  },
  {
    stage: '02',
    label: 'Game Layer',
    title: 'カード周りに地面と住人を描き始める',
    body: 'プロジェクトカードに地形タイルとキャラクターアニメを重ね、テーマ別 Ground を選べるようにする。まずはビジュアル装飾から。',
    status: 'next',
  },
  {
    stage: '03',
    label: 'Reception & Milestones',
    title: '村長 NPC とマイルストーン階層',
    body: '案内 NPC の応答パイプライン（ユーザーの Claude Code 経由）と、プロジェクト全体のマイルストーン定義 UI を導入する。',
    status: 'later',
  },
  {
    stage: '04',
    label: 'Off-Peak Engine',
    title: '夜間に黙々と進む自走モード',
    body: 'スケジューラ、トークン枠監視、マイルストーン分解器を組み合わせ、寝ているあいだに Ground が自分で前進できるようにする。',
    status: 'later',
  },
  {
    stage: '05',
    label: 'Inner Canvas',
    title: 'プロジェクト内 Figma 風キャンバス',
    body: 'Overview / Chats / Terminal に並ぶ 4 番目のタブ。デザイン・表・ノート・成果物を 1 つの拡縮可能なキャンバスに置く。',
    status: 'horizon',
  },
]

const STATUS_PILL: Record<RoadmapStop['status'], { label: string; cls: string }> = {
  now: { label: 'NOW', cls: 'bg-accent text-bg-card border-accent' },
  next: { label: 'NEXT', cls: 'border-accent text-accent' },
  later: { label: 'LATER', cls: 'border-line-strong text-ink-muted' },
  horizon: { label: 'HORIZON', cls: 'border-line text-ink-faint' },
}

const RoadmapSurvey = () => (
  <section className="space-y-6">
    <SectionRail
      no="V"
      eyebrow="Survey Route"
      title="Five stops between here and the Ground."
    />
    <ol className="relative ml-1 border-l border-line-strong">
      {ROADMAP.map(m => {
        const pill = STATUS_PILL[m.status]
        return (
          <li key={m.stage} className="relative pl-7 py-4 first:pt-1 last:pb-1">
            <span className="absolute -left-[5px] top-6 h-2.5 w-2.5 rounded-full bg-bg ring-2 ring-line-strong" />
            <header className="flex flex-wrap items-baseline gap-2.5">
              <span className="font-mono text-[10px] tracking-cartographic text-ink-faint">
                {m.stage}
              </span>
              <span className="label-cap text-ink-muted">{m.label}</span>
              <span
                className={[
                  'rounded-[2px] border px-1.5 py-[1px] label-cap',
                  pill.cls,
                ].join(' ')}
              >
                {pill.label}
              </span>
            </header>
            <h3 className="mt-1.5 font-display text-[17px] leading-snug tracking-tightest text-ink">
              {m.title}
            </h3>
            <p className="mt-1.5 max-w-[600px] text-[12.5px] leading-[1.75] text-ink-muted">
              {m.body}
            </p>
          </li>
        )
      })}
    </ol>
  </section>
)

const ClosingCreed = () => (
  <section className="border-y border-line-strong py-12">
    <p className="label-cap text-accent mb-5">Creed</p>
    <blockquote
      className="font-display text-[34px] leading-[1.2] tracking-tightest text-ink max-w-[720px]"
      style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
    >
      “より多くの人が <span className="text-accent">楽しんで</span> AI を使って、
      自分たちのプロジェクトを作り上げていく。”
    </blockquote>
    <p className="mt-5 font-mono text-[11px] tracking-normal text-ink-muted">
      — Ground の唯一の目標。
    </p>
  </section>
)

const VisionDocFooter = ({
  project,
  data,
}: {
  project: ProjectMeta
  data: ProjectData
}) => (
  <footer className="grid grid-cols-1 gap-x-8 gap-y-2 border-t border-line-soft pt-5 sm:grid-cols-2">
    <div className="flex gap-3">
      <span className="label-cap text-ink-faint w-20 shrink-0">Path</span>
      <span className="font-mono text-[11px] break-all text-ink-subtle">{project.path}</span>
    </div>
    {data.updatedAt && (
      <div className="flex gap-3">
        <span className="label-cap text-ink-faint w-20 shrink-0">Updated</span>
        <span className="font-mono text-[11px] text-ink-subtle">
          {new Date(data.updatedAt).toLocaleString()}
        </span>
      </div>
    )}
  </footer>
)
