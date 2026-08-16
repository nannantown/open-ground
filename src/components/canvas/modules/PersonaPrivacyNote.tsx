// PersonaPrivacyNote — where what you say here actually goes, said exactly.
//
// IT SITS AT THE POINT OF ENTRY (under the conversation input, not in a
// settings page) because that is where the question occurs to a person: you are
// about to type something about yourself into a computer, and the sentence you
// want is "and then what happens to it".
//
// THREE CLAIMS, AND THE MIDDLE ONE IS THE REASON THIS COMPONENT EXISTS:
//   1. What is written stays in ~/.openground/ on this machine. Nothing is
//      uploaded; there is no server.
//   2. BUT talking to the persona sends that exchange through the owner's OWN
//      `claude` to Anthropic, exactly like any Claude conversation. Copy that
//      says "the conversation stays local" would be FALSE — every reply on this
//      screen is produced by a `claude` run (src/lib/server/personaChat.ts).
//   3. Whether it is used for training is decided in claude.ai's own privacy
//      settings and CANNOT be changed from this app. Implying otherwise is a
//      lie about someone else's product.
//
// The wording is the approved one (the mock's <details>, verbatim in Japanese)
// and is PINNED WORD-FOR-WORD by PersonaConversation.test.tsx — the same
// technique that pins PERSONA_RESULT_CAVEAT. A privacy lie has to be a red
// test, not a review finding: softening (2) is a one-word edit that no reviewer
// would necessarily catch and every reader would rely on.
//
// A <details>, closed by default: the owner asked repeatedly for less text on
// this stage (「文字は極力少なくしたい。説明もいらない」), and a three-paragraph
// disclosure permanently open is the opposite of that. The SUMMARY line is
// always visible, so the existence of the answer is never hidden — only its
// length.

import { useT } from '@/i18n/I18nContext'

export const PersonaPrivacyNote = () => {
  const { t } = useT()
  return (
    /* `inline` and marginless: it sits INSIDE the footer row now (one line, two
     *  facts, a middot between them) rather than as a third centred block of
     *  its own. The open panel is still full width — `absolute` would have to
     *  measure the stage, and a disclosure that clips is worse than one that
     *  pushes the row down by its own height. */
    <details className="text-center">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-plate text-ink-onDeep/35 transition-colors marker:content-none hover:text-ink-onDeep/60 [&::-webkit-details-marker]:hidden">
        {/* The little padlock body from the mock, drawn in CSS rather than as an
         *  icon: two divs are cheaper than a dependency, and it inherits the
         *  summary's colour so it fades with the text instead of staying loud. */}
        <span
          aria-hidden="true"
          className="-mt-px block h-[9px] w-[7px] rounded-[1px] border border-t-[3px] border-current"
        />
        {t('persona.privacy.summary')}
      </summary>
      <div className="mx-auto mt-2 max-w-[470px] rounded-[3px] border border-line bg-bg-card px-3.5 py-3 text-left">
        <p className="text-meta leading-relaxed text-ink-muted">{t('persona.privacy.local')}</p>
        <p className="mt-1.5 text-meta leading-relaxed text-ink-muted">
          {t('persona.privacy.conversation')}
        </p>
        <p className="mt-1.5 text-meta leading-relaxed text-ink-muted">
          {t('persona.privacy.import')}
        </p>
        <p className="mt-1.5 text-meta leading-relaxed text-ink-muted">
          {t('persona.privacy.training')}
        </p>
      </div>
    </details>
  )
}
