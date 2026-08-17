// PersonaKnownList — everything the stand-in believes, read back in one place.
//
// THE COMPLAINT THIS ANSWERS (owner, 2026-08-16): 「わかっていることとかクリックした
// ら、今まで答えたものがカテゴリー分けされて一覧でみれたり」. Until now the only ways to
// reach one specific line were to hover the right pixel on the figure, or to tab
// through an sr-only list of hundreds of buttons. A belief you cannot find is a
// belief you cannot correct — and correction is the feature this entire surface
// is built around, so that was the hole in the middle of it.
//
// ⚠ A SCREEN, NOT A CARD (owner, 2026-08-16: 「情報が多いものはモーダルじゃなくて
// ちゃんとしたスクリーン作るのもあり」). It began as a 560px card floating in the
// reading column at 62vh — a card is the right shape for five composed lines and
// the wrong one for four hundred, where the scroll is the surface. It is now the
// LEFT PANE of a two-pane screen: the list here, the body still drawn at full
// height on the right. That pairing is the point, and it is why this is a pane
// and not a page of its own — see `onHighlight`.
//
// ⚠ IT REPLACES NOTHING. The portrait becomes this list's HEADER (five composed
// lines are the summary of exactly this list); pressing a row opens the same
// note card a lit point opens, whose 「直す」 already reaches the same composer.
// The only new things here are the grouping, the filter and the layout.
//
// ⚠ THE HEADER COUNT COMES FROM THE RENDERED ARRAY, NEVER FROM THE PORTRAIT.
// `portrait.nodeCount` is computed server-side from a different read; if the two
// ever drift, a number would be labelling a list it does not describe. Counting
// what is on screen makes that state unreachable rather than unlikely.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import { BackLink } from '@/components/ui/BackLink'
import {
  KNOWN_GROUP_LABEL,
  groupJudgments,
  matchesFilter,
  type KnownGroupId,
} from '@/lib/persona/knownGroups'
import type { ManualJudgment, PersonaPortrait, PersonaRegion } from '@/lib/types'
import type { PersonaNode } from '@/lib/persona/regions'

/** The 材料 block, composed by the module (every owner-facing string on this
 *  surface is), so this file positions it and counts nothing. */
export interface PersonaMaterials {
  /** The collapsed line: what this is, and when the file was last built. */
  heading: string
  sources: { label: string; value: string; present: boolean }[]
  rebuildLabel: string
  rebuildingLabel: string
  rebuiltLabel: string
  failedLabel: string
}

export interface PersonaKnownListProps {
  /** ⚠ THREE-VALUED. `undefined` = the corpus read has not landed or FAILED —
   *  which is not the same as an empty corpus, and must not render as one. */
  judgments: ManualJudgment[] | undefined
  /** The nodes the figure draws, keyed by the same ids. A row opens the node, so
   *  the card it raises is the identical component a lit point raises. */
  nodes: PersonaNode[]
  portrait: PersonaPortrait | null
  portraitLineDetail: (line: PersonaPortrait['lines'][number]) => string
  /** Shown INSTEAD of the portrait lines when nothing is evidenced yet — the
   *  portrait is composed from scored results, never generated, so with no
   *  evidence it asks rather than inventing a sentence. */
  portraitInvite: boolean
  /** ⚠ THE LINES HE TOOK BACK — never merged into `judgments`. Their own group,
   *  at the end, greyed, and NOT in the header count: they are shown so they can
   *  be got back, not so they can be read as things he holds. Three-valued like
   *  `judgments` for the same reason. */
  retired: { judgment: ManualJudgment; retiredAt: string }[] | undefined
  /** How this screen prints a withdrawal date. Owned by the module, like every
   *  other date on this surface, so there is one date vocabulary. */
  retiredLabel: (iso: string) => string
  /** ⚠ WHAT THE STAND-IN IS BUILT FROM — the provenance of the whole list, and
   *  the one thing on this screen that is not itself a belief. Kept BEHIND A
   *  DISCLOSURE (owner: 「いらない情報は出さないように気をつけて」): it answers a
   *  question that is asked rarely and answered permanently, so it earns a line,
   *  not a panel. `null` = the status read did not land; the row says nothing at
   *  all rather than reporting sources nobody read. */
  materials: PersonaMaterials | null
  /** 「作り直す」. The corpus is re-assembled on every write already, so this
   *  exists for the one state that needs a hand: an append whose rebuild was
   *  SKIPPED, which leaves the file the stand-in reads behind the record. */
  onRebuild: () => void
  rebuilding: boolean
  /** What the last rebuild did. `warning` is the SERVER'S OWN sentence, printed
   *  verbatim under the plain one — a machine reason the owner did not ask for,
   *  kept because it is the only thing that says WHY. */
  rebuildResult: { ok: boolean; warning?: string } | null
  provenance: (node: PersonaNode) => string
  onOpenNote: (node: PersonaNode) => void
  /** A withdrawn line has no node to open, so its row hands back the judgment
   *  itself — the card it raises offers 「戻す」 instead of 「直す」. */
  onOpenRetired: (judgment: ManualJudgment) => void
  /** ⚠ THE BINDING TO THE BODY, and the reason this list sits beside the figure
   *  rather than replacing it: pointing at a line lights the point that line
   *  lives on. Every competitor's memory list can show you a sentence; none of
   *  them can show you WHERE IN YOU it sits, because none of them has a body to
   *  point at. Null on leave — a highlight that outlives the pointer is a lie
   *  about what is being pointed at. */
  onHighlight: (id: string | null) => void
  /** The other direction: the region the owner is probing ON the figure. Rows
   *  seated there are marked and the first is scrolled to, so the two surfaces
   *  answer each other from either side. */
  probedRegion: PersonaRegion | null
  onRetry: () => void
  onClose: () => void
  reloading: boolean
  /** Rendered above everything in the scroll area. Today this is 「どれが自分では
   *  ないか」 — composed by the module, so this file stays a list and does not
   *  learn what a check is. */
  banner?: ReactNode
}

export const PersonaKnownList = ({
  judgments,
  nodes,
  portrait,
  portraitLineDetail,
  portraitInvite,
  retired,
  retiredLabel,
  materials,
  onRebuild,
  rebuilding,
  rebuildResult,
  provenance,
  onOpenNote,
  onOpenRetired,
  onHighlight,
  probedRegion,
  onRetry,
  onClose,
  reloading,
  banner,
}: PersonaKnownListProps): JSX.Element => {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<KnownGroupId | null>(null)
  const [showMaterials, setShowMaterials] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  // Grouped BEFORE filtering, so a chip can carry the count of what it holds in
  // total; filtering then narrows the rows without lying about how much was
  // hidden. (A chip whose number changed with the filter would make the filter
  // invisible, which is how people lose track of what they are looking at.)
  const groups = useMemo(
    () => groupJudgments(judgments ?? [], (retired ?? []).map((r) => r.judgment)),
    [judgments, retired],
  )
  /** When each withdrawn line was withdrawn, for the row's own provenance line.
   *  Keyed by id so the row does not have to carry a second array around. */
  const retiredAt = useMemo(
    () => new Map((retired ?? []).map((r) => [r.judgment.id, r.retiredAt])),
    [retired],
  )
  const shown = useMemo(
    () =>
      groups
        .filter((g) => (only ? g.id === only : true))
        .map((g) => ({ ...g, items: g.items.filter((j) => matchesFilter(j, query)) }))
        .filter((g) => g.items.length > 0),
    [groups, only, query],
  )
  // ⚠ THE WITHDRAWN LINES ARE NOT COUNTED. The number beside 「分身が知っている
  // こと」 answers exactly one question — how much does it hold — and a line he
  // took back is precisely one it does not.
  const shownCount = shown.reduce((n, g) => n + (g.id === 'retired' ? 0 : g.items.length), 0)

  // Probing a region on the figure brings the first row seated there into view.
  // `block: 'nearest'` on purpose: it scrolls the minimum distance, so a row
  // already visible does not jump under a pointer that is nowhere near it.
  useEffect(() => {
    if (!probedRegion) return
    const el = scrollRef.current?.querySelector('[data-region-hit="true"]')
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [probedRegion, shown])

  // (Closing the screen with a row still under the pointer fires no
  //  `mouseleave` — the node is simply gone. Dropping the highlight is the
  //  MODULE's job, in one effect keyed on the screen being up, so that a second
  //  mechanism here cannot mask its absence.)

  const header = (
    <div className="flex flex-col gap-3 border-b border-line px-6 pb-3 pt-4">
      <BackLink label={t('persona.known.back')} onClick={onClose} />
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-read font-medium text-ink">{t('persona.counts.known')}</h2>
        {/* ⚠ NO NUMBER WHILE THE WITHDRAWN GROUP IS THE FILTER. This count answers
         *  「分身がいくつ持っているか」, and the withdrawn lines are exactly the ones
         *  it does not — so filtering to them would print a large 0 beside a
         *  screen with rows on it. A 0 that is true and reads as a fault is
         *  still a fault. */}
        {judgments !== undefined && only !== 'retired' && (
          <b className="text-meta font-medium tabular-nums text-ochre-deep">{shownCount}</b>
        )}
      </div>
    </div>
  )

  // ── (a) THE READ FAILED ─────────────────────────────────────────────────────
  // ⚠ NO COUNT ANYWHERE. Not a 0, not the portrait's number. The portrait is a
  // different read; one landing does not license the other's figures, and a
  // number here would be describing a list nobody could open.
  if (judgments === undefined) {
    return (
      <section aria-label={t('persona.counts.known')} className="flex h-full flex-col bg-bg">
        {header}
        <div className="flex flex-col items-start gap-2.5 px-6 py-5">
          <p className="text-meta leading-relaxed text-ink-muted">
            {t('persona.known.loadFailed')}
          </p>
          <Btn variant="subtle" size="xs" onClick={onRetry} disabled={reloading}>
            {reloading ? t('persona.loading') : t('persona.retry')}
          </Btn>
        </div>
      </section>
    )
  }

  const showPortrait = !!portrait && (portraitInvite || portrait.lines.length > 0)

  return (
    <section aria-label={t('persona.counts.known')} className="flex h-full flex-col bg-bg">
      {header}

      {/* ── the filter, PINNED. On a screen whose body is four hundred rows the
       *  control that narrows them cannot scroll away with them. */}
      {groups.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-line px-6 py-3">
          <label className="flex items-center gap-2 rounded-[2px] border border-line bg-bg-inset px-2.5 py-1.5">
            <Search size={12} className="flex-none text-ink-faint" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Esc clears the filter; Esc again (with nothing to clear)
                // falls through to the overlay and closes the screen.
                if (e.key === 'Escape' && query) {
                  e.stopPropagation()
                  setQuery('')
                }
              }}
              aria-label={t('persona.known.filterLabel')}
              placeholder={t('persona.known.filterLabel')}
              className="min-w-0 flex-1 bg-transparent text-meta text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setOnly(only === g.id ? null : g.id)}
                aria-pressed={only === g.id}
                className={`rounded-[2px] border px-2 py-0.5 text-meta transition-colors ${
                  only === g.id
                    ? 'border-accent bg-accent/10 text-ink'
                    : 'border-line text-ink-muted hover:text-ink'
                }`}
              >
                {t(KNOWN_GROUP_LABEL[g.id])}{' '}
                {/* The chip's count is the group's TOTAL, not the filtered
                 *  subset — so narrowing never hides how much was narrowed
                 *  away. */}
                <b className="font-medium tabular-nums text-ochre-deep">{g.items.length}</b>
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6">
        {banner}
        {/* ── the portrait, as this list's summary ──────────────────────────── */}
        {showPortrait && (
          <div
            data-testid="portrait-summary"
            className="flex flex-col gap-1.5 border-b border-line py-3.5"
          >
            <span className="label-cap text-ink-faint">{t('persona.known.portraitHeading')}</span>
            {portraitInvite && (
              <p className="text-meta leading-relaxed text-ink-muted">
                {t('persona.portrait.empty')}
              </p>
            )}
            {!portraitInvite &&
              portrait.lines.map((line) => (
                <p key={`${line.courseId}|${line.text}`} className="flex flex-col gap-0.5">
                  <span className="text-ui leading-relaxed text-ink">{line.text}</span>
                  <span className="text-meta leading-relaxed text-ink-faint">
                    {portraitLineDetail(line)}
                  </span>
                </p>
              ))}
          </div>
        )}

        {/* ── (b) READ FINE, NOTHING IN IT ──────────────────────────────────── */}
        {groups.length === 0 ? (
          <p className="py-5 text-meta leading-relaxed text-ink-muted">
            {t('persona.known.empty')}
          </p>
        ) : /* ── (d) THE FILTER MATCHED NOTHING ────────────────────────────────
           *  A different sentence from (b) on purpose: this is a fact about the
           *  filter, not a fact about the owner. */
        shown.length === 0 ? (
          <p className="py-5 text-meta leading-relaxed text-ink-muted">
            {t('persona.known.noMatch')}
          </p>
        ) : (
          shown.map((g) => (
            <div key={g.id} className="pt-3">
              <div className="flex items-baseline justify-between gap-3 pb-1">
                <span className="label-cap text-ink-faint">{t(KNOWN_GROUP_LABEL[g.id])}</span>
                <span className="text-meta tabular-nums text-ink-faint">{g.items.length}</span>
              </div>
              <ul className="-mx-2 flex flex-col">
                {g.items.map((j) => {
                  const node = nodeById.get(j.id)
                  const gone = g.id === 'retired'
                  const hit =
                    !gone && !!probedRegion && node?.region === probedRegion && node.placed
                  return (
                    <li key={j.id} className="border-t border-line/60 first:border-t-0">
                      <button
                        type="button"
                        // A row with no node behind it cannot open a card —
                        // it is still LISTED (it is the owner's line and
                        // hiding it would be the lie), just not pressable.
                        // ⚠ A WITHDRAWN LINE HAS NO NODE EITHER (it is not on
                        // the body any more, which is the point), so its row is
                        // opened through the judgment rather than the node.
                        disabled={!node && !gone}
                        onClick={() => (gone ? onOpenRetired(j) : node && onOpenNote(node))}
                        // Pointer AND keyboard both light the body: a keyboard
                        // owner tabbing the list gets the same binding, which is
                        // the only way it exists for them at all.
                        onMouseEnter={() => onHighlight(gone ? null : j.id)}
                        onMouseLeave={() => onHighlight(null)}
                        onFocus={() => onHighlight(gone ? null : j.id)}
                        onBlur={() => onHighlight(null)}
                        data-region-hit={hit ? 'true' : undefined}
                        className={`group flex w-full flex-col gap-0.5 rounded-[2px] px-2 py-2 text-left transition-colors hover:bg-bg-inset/70 disabled:hover:bg-transparent ${
                          // The mark for "this one is in the part of the body
                          // you are pointing at". A tint, not a word: the row
                          // already carries its region on the line below.
                          hit ? 'bg-ochre/10' : ''
                        }`}
                      >
                        <span
                          className={`line-clamp-2 text-read leading-relaxed transition-colors group-disabled:group-hover:text-ink ${
                            // Greyed, not struck through: it is still his
                            // sentence, and a line through a person's own words
                            // reads as a correction someone else made.
                            gone ? 'text-ink-faint' : 'text-ink group-hover:text-accent'
                          }`}
                        >
                          {j.text}
                        </span>
                        {/* The SAME provenance line the note card and the
                         *  figure's probe already print — one vocabulary for
                         *  "where this sits and when it arrived". A withdrawn
                         *  line says WHEN INSTEAD: where it used to sit is no
                         *  longer true of it. */}
                        {gone ? (
                          <span className="text-meta leading-relaxed text-ink-faint">
                            {retiredLabel(retiredAt.get(j.id) ?? j.addedAt)}
                          </span>
                        ) : (
                          node && (
                            <span className="text-meta leading-relaxed text-ink-faint">
                              {provenance(node)}
                            </span>
                          )
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {materials && (
        <div className="flex flex-col border-t border-line px-6 py-2">
          <button
            type="button"
            onClick={() => setShowMaterials((v) => !v)}
            aria-expanded={showMaterials}
            className="flex items-baseline justify-between gap-3 py-0.5 text-left text-meta text-ink-faint transition-colors hover:text-ink"
          >
            <span>{materials.heading}</span>
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={`flex-none self-center transition-transform ${showMaterials ? 'rotate-180' : ''}`}
            />
          </button>
          {showMaterials && (
            <div className="flex flex-col gap-1.5 pb-1 pt-2">
              <ul className="flex flex-col gap-0.5">
                {materials.sources.map((src) => (
                  <li
                    key={src.label}
                    className="flex items-baseline justify-between gap-3 text-meta leading-relaxed"
                  >
                    {/* ⚠ A MISSING SOURCE IS NAMED, NOT HIDDEN. A list of only
                     *  what resolved reads as "this is everything", and the
                     *  absent one is exactly what explains a thin stand-in. */}
                    <span className={src.present ? 'text-ink-muted' : 'text-ink-faint'}>
                      {src.label}
                    </span>
                    <span
                      className={`tabular-nums ${src.present ? 'text-ink-muted' : 'text-ink-faint'}`}
                    >
                      {src.value}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2 pt-1">
                <Btn variant="subtle" size="xs" onClick={onRebuild} disabled={rebuilding}>
                  {rebuilding ? materials.rebuildingLabel : materials.rebuildLabel}
                </Btn>
                {rebuildResult && (
                  <span
                    role="status"
                    className={`text-meta ${rebuildResult.ok ? 'text-ink-faint' : 'text-ochre-deep'}`}
                  >
                    {rebuildResult.ok ? materials.rebuiltLabel : materials.failedLabel}
                  </span>
                )}
              </div>
              {rebuildResult?.warning && (
                <p className="whitespace-pre-line break-words text-micro leading-relaxed text-ink-faint">
                  {rebuildResult.warning}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
