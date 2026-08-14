// Owned by the Persona tab (owner-only experiment — src/components/canvas/
// modules/PersonaModule.tsx + PersonaFigure.tsx + PersonaResultSheet.tsx). Add
// keys as 'persona.*'. English is the source of truth.
//
// COPY RULE for this namespace: the reader is the OWNER, not a programmer.
// Every string says what it means in plain words — no "corpus", no "assemble",
// no file paths in the body copy. The tab's whole point has to come across from
// the copy alone: what you write here is the judgment your stand-in runs on.
//
// The two locales are written SEPARATELY, not translated line by line: the
// Japanese is the wording the owner designed the screen around, the English is
// the same thing said the way it would be said in English.
//
// `persona.tabLabel` names the SCREEN — the mark in its top-left corner. It is
// no longer a tab name (2026-08-14: the surface moved to the Ground toolbar,
// see src/components/canvas/PersonaPanel.tsx), and the key kept its historical
// spelling rather than churning the component and its tests. The toolbar entry
// that opens it is named separately under `toolbar.persona` /
// `toolbar.personaTooltip`.
export const persona = {
  en: {
    'persona.tabLabel': 'Persona',

    // --- First run: the figure is all dust, so say what this place is --------
    'persona.intro.title': 'Grow your stand-in',
    'persona.intro.body':
      'This is what OPEN GROUND has learned about how you decide things. Your stand-in reads all of it before it judges anything for you, so what you add here it will actually act on.',
    'persona.intro.correctionNote':
      'Correcting something wrong here is the single most useful thing you can add — nothing is ever deleted, a correction is written on top.',

    // --- The figure ---------------------------------------------------------
    // Every lit point is one note. The dark parts are not styling: they are the
    // parts your stand-in would have to guess at.
    'persona.figure.empty':
      'Nothing is lit yet. Answer the question in the corner, or take one of the courses, and the first point appears.',
    'persona.figure.reset': 'Back to the whole figure',
    // Names the off-screen list that makes every lit point reachable without a
    // mouse (a canvas has no keyboard).
    'persona.figure.nodeList': 'Everything lit in the figure',
    'persona.figure.hint':
      'Scroll to move around · ⌘/Ctrl + scroll to zoom · hold Space and drag to pan',

    // --- Hover labels on the figure -----------------------------------------
    'persona.tip.raw': 'From an answer',
    'persona.tip.rawSub': 'It settles into place when the course finishes.',
    'persona.tip.gap': 'Something it does not know yet',
    'persona.tip.gapSub': 'Answer the question in the corner and this lights up.',
    'persona.tip.dust': 'Not formed yet',

    // --- The five regions of the figure -------------------------------------
    // Same five a course grows (PersonaCourse.zone), so a finished course
    // visibly fills a part of you rather than a score.
    'persona.zone.mind': 'How you think',
    'persona.zone.values': 'What you hold to',
    'persona.zone.craft': 'How you make things',
    'persona.zone.core': 'Money and going public',
    'persona.zone.ground': 'The ground you stand on',

    // --- One note, opened from the figure ------------------------------------
    'persona.node.close': 'Close',

    // --- Meta strip: what the stand-in reads right now ----------------------
    'persona.meta.updated': 'Last updated',
    'persona.meta.never': 'Not written yet',
    'persona.meta.memory': 'Remembered about you',
    'persona.meta.manual': 'Written by you',
    // English inflects, Japanese does not — PersonaModule's countLabel() picks
    // the form. Both keys must exist in both languages (the JA pair is
    // identical on purpose).
    'persona.meta.count.one': '1 note',
    'persona.meta.count.other': '{count} notes',
    // Shown after a save that landed but could not be folded into the file the
    // stand-in reads — either because the sources were unreadable and the
    // previous version was kept, or because rebuilding it failed outright. Both
    // mean the same thing to the owner: it is saved, it is not in there yet.
    'persona.meta.stale':
      'Saved — but the file your stand-in reads could not be rebuilt this time, so it will catch up on the next save that succeeds.',

    // --- The always-on question (the interview loop) ------------------------
    // One a day, built from something the owner actually did — never a
    // personality quiz. The copy has to make that obvious, or the question
    // reads as a generic survey and gets ignored.
    'persona.interview.heading': "Today's question",
    'persona.interview.placeholder': 'In your own words. A sentence is plenty.',
    'persona.interview.answer': 'Answer',
    'persona.interview.answering': 'Saving…',
    'persona.interview.skip': 'Not this one',
    'persona.interview.failed': 'Could not save that. Your answer is still here — try again.',
    // Separate from the above on purpose: there is no answer to reassure the
    // owner about on the skip path.
    'persona.interview.skipFailed': 'Could not skip that just now. Try again.',
    'persona.interview.answered': 'Saved. Your stand-in has this now.',
    // Same event, one honest difference: the answer is safe, but the file the
    // stand-in reads was not rebuilt, so it does not have it yet.
    'persona.interview.answeredStale':
      'Your answer is saved — but it has not reached your stand-in yet. The next save that succeeds will carry it over.',
    'persona.interview.skipped': 'Skipped — this one will not come back.',
    'persona.interview.none.title': 'No question today',
    'persona.interview.none.body':
      'Questions come from what you actually did — cards you sent back, calls you sat on. There is nothing new to ask about yet, so nothing is being invented.',

    // --- The question card's own furniture ----------------------------------
    'persona.ask.hint': 'Answering lights one point.',
    'persona.ask.quit': 'Stop',
    'persona.ask.idle': 'Pick a course on the left and the questions keep coming.',

    // --- The courses (self-report instruments) ------------------------------
    'persona.course.railHeading': 'Courses',
    'persona.course.state.new': '{count} questions · grows {zone}',
    'persona.course.state.running': 'In progress — {index} / {total}',
    'persona.course.state.done': 'Done {date} · take it again',
    'persona.course.submitting': 'Scoring…',
    'persona.course.failed': 'Could not save the result. Your answers are still here.',
    'persona.course.retry': 'Send again',

    // --- The result sheet ---------------------------------------------------
    'persona.result.kicker': 'Result',
    'persona.result.answered': 'all {count} questions answered',
    // Printed verbatim from the instrument, never paraphrased — it is what says
    // which published instrument the items follow and which trademarked one
    // they are NOT.
    'persona.result.source': 'Source: {source}',
    'persona.result.minted': 'What went into your persona',
    'persona.result.mintedPartial':
      'Some of these have not reached your stand-in yet — the next save that succeeds will carry them over.',
    'persona.result.caveat':
      'This is a self-report, not a verdict on who you are. Where it disagrees with the record of what you actually decided, the disagreement is the useful part — your persona keeps both and builds its next question out of the gap.',
    'persona.result.back': 'Back to the persona',
    'persona.result.again': 'Take it again',

    // --- Writing into it: a new note, or a correction of one -----------------
    'persona.add.open': 'Add a note',
    'persona.add.heading': 'Add to it',
    'persona.add.placeholder':
      'Something you decided, noticed, or want your stand-in to know.',
    'persona.add.tagsLabel': 'Tags (optional)',
    'persona.add.tagsPlaceholder': 'pricing, hiring',
    'persona.add.submit': 'Add',
    'persona.add.submitting': 'Adding…',
    'persona.add.failed': 'Could not save that. Try again.',

    'persona.correct.start': 'Correct this',
    'persona.correct.heading': 'Correcting an earlier note',
    'persona.correct.cancel': 'Cancel',
    'persona.correct.placeholder': 'What is actually true?',
    'persona.correct.submit': 'Save correction',
    // Written into the new note so the stand-in can see what it replaces. The
    // original is never removed.
    'persona.correct.contextPrefix': 'Corrects an earlier note:',

    'persona.notes.basis': 'Where this came from',
    // Same slot as `basis`, used when the note is a correction: what it
    // replaces, not what it came from.
    'persona.notes.corrects': 'This replaces',

    'persona.loading': 'Loading…',
    'persona.loadFailed': 'Could not load this.',
    'persona.retry': 'Retry',
  } as Record<string, string>,
  ja: {
    'persona.tabLabel': 'ペルソナ',

    'persona.intro.title': 'あなたの分身を育てる',
    'persona.intro.body':
      'OPEN GROUND がこれまでに掴んだ、あなたの決め方です。あなたの分身は、あなたの代わりに何かを判断する前に必ずこれを全部読みます。ここに足したことは、そのまま分身の動きになります。',
    'persona.intro.correctionNote':
      '違っているところを直すのが、いちばん効きます。消えるものは何もありません — 訂正は上に書き足す形で残ります。',

    'persona.figure.empty':
      'まだ何も灯っていません。右下の問いに答えるか、左のコースを受けると、最初のひとつが灯ります。',
    'persona.figure.reset': '全体に戻る',
    'persona.figure.nodeList': '図に灯っているもの',
    'persona.figure.hint':
      'スクロールで移動、⌘/Ctrl+スクロールで拡大、スペースを押しながらドラッグで動かせます。',

    'persona.tip.raw': '回答から',
    'persona.tip.rawSub': 'コースが終わるとまとまります。',
    'persona.tip.gap': 'まだ知らないこと',
    'persona.tip.gapSub': '右下の問いに答えると灯ります。',
    'persona.tip.dust': 'まだ形になっていない部分',

    'persona.zone.mind': '考え方',
    'persona.zone.values': '大事にすること',
    'persona.zone.craft': '作り方',
    'persona.zone.core': 'お金と公開',
    'persona.zone.ground': '暮らしの土台',

    'persona.node.close': '閉じる',

    'persona.meta.updated': '最終更新',
    'persona.meta.never': 'まだ作られていません',
    'persona.meta.memory': '覚えたこと',
    'persona.meta.manual': '自分で書いたもの',
    'persona.meta.count.one': '1 件',
    'persona.meta.count.other': '{count} 件',
    'persona.meta.stale':
      '保存しました。ただし分身が読むファイルは今回作り直せませんでした — 次に成功した保存で反映されます。',

    'persona.interview.heading': '今日の1問',
    'persona.interview.placeholder': 'あなたの言葉で。一文で十分です。',
    'persona.interview.answer': '答える',
    'persona.interview.answering': '保存しています…',
    'persona.interview.skip': 'これは飛ばす',
    'persona.interview.failed': '保存できませんでした。書いた内容は残っています — もう一度お試しください。',
    'persona.interview.skipFailed': 'いま飛ばせませんでした。もう一度お試しください。',
    'persona.interview.answered': '保存しました。分身がこれを覚えました。',
    'persona.interview.answeredStale':
      '答えは保存しました。ただし分身にはまだ渡っていません — 次に成功した保存で反映されます。',
    'persona.interview.skipped': '飛ばしました。この質問はもう出てきません。',
    'persona.interview.none.title': '今日は質問がありません',
    'persona.interview.none.body':
      '質問は、あなたが実際にやったこと（やり直しを頼んだカード、しばらく決めずに置いた相談）から作ります。今は新しく聞くことがないので、無理に作っていません。',

    'persona.ask.hint': '答えると1つ灯ります',
    'persona.ask.quit': 'やめる',
    'persona.ask.idle': '左のコースを選ぶと、ここに問いが続きます。',

    'persona.course.railHeading': '診断コース',
    'persona.course.state.new': '{count}問 ・ {zone}が育つ',
    'persona.course.state.running': '{index} / {total} 進行中',
    'persona.course.state.done': '済 {date} ・ もう一度',
    'persona.course.submitting': '採点しています…',
    'persona.course.failed': '結果を保存できませんでした。答えは残っています。',
    'persona.course.retry': 'もう一度送る',

    'persona.result.kicker': '結果',
    'persona.result.answered': '{count}問すべてに回答',
    'persona.result.source': '出典: {source}',
    'persona.result.minted': 'ペルソナに入ったもの',
    'persona.result.mintedPartial':
      'このうち、まだ分身に渡っていないものがあります — 次に成功した保存で反映されます。',
    // 一字一句 src/lib/persona/instruments.ts の PERSONA_RESULT_CAVEAT と同じ。
    // 結果シートに必ず出る断り書きで、PersonaModule.test.tsx が両者の一致を固定
    // している(片方だけ書き換えると赤になる)。
    'persona.result.caveat':
      'これは自己申告の観測で、性格を決めつけるものではありません。実際の判断の記録とズレたときは、ズレのほうが情報です — ペルソナは両方を持ったまま、次の問いをつくります。',
    'persona.result.back': 'ペルソナに戻る',
    'persona.result.again': 'もう一度やる',

    'persona.add.open': '書き足す',
    'persona.add.heading': '書き足す',
    'persona.add.placeholder': '決めたこと、気づいたこと、分身に知っておいてほしいこと。',
    'persona.add.tagsLabel': 'タグ（任意）',
    'persona.add.tagsPlaceholder': '価格, 採用',
    'persona.add.submit': '追加',
    'persona.add.submitting': '追加しています…',
    'persona.add.failed': '保存できませんでした。もう一度お試しください。',

    'persona.correct.start': '直す',
    'persona.correct.heading': '前に書いたものを訂正する',
    'persona.correct.cancel': 'やめる',
    'persona.correct.placeholder': '本当はどうですか？',
    'persona.correct.submit': '訂正を保存',
    'persona.correct.contextPrefix': '前の記述の訂正:',

    'persona.notes.basis': 'これが出てきたところ',
    'persona.notes.corrects': 'これを置き換えます',

    'persona.loading': '読み込んでいます…',
    'persona.loadFailed': '読み込めませんでした。',
    'persona.retry': '再試行',
  } as Record<string, string>,
}
