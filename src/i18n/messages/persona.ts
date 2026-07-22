// Owned by the Persona tab (owner-only experiment — src/components/canvas/
// modules/PersonaModule.tsx). Add keys as 'persona.*'. English is the source of
// truth.
//
// COPY RULE for this namespace: the reader is the OWNER, not a programmer.
// Every string says what it means in plain words — no "corpus", no "assemble",
// no file paths in the body copy. The tab's whole point has to come across from
// the copy alone: what you write here is the judgment your stand-in runs on.
//
// `persona.tabLabel` is the ONE key that names the tab everywhere (row + "+"
// picker, via TabDef.labelKey) — renaming the tab is a two-line edit here.
export const persona = {
  en: {
    'persona.tabLabel': 'Persona',

    // --- Intro: why this tab exists ----------------------------------------
    'persona.intro.title': 'Grow your stand-in',
    'persona.intro.body':
      'This is what OPEN GROUND has learned about how you decide things. Your stand-in reads all of it before it judges anything for you, so what you add here it will actually act on.',
    'persona.intro.correctionNote':
      'Correcting something wrong here is the single most useful thing you can add — nothing is ever deleted, a correction is written on top.',

    // --- Meta strip: what the stand-in reads right now ----------------------
    'persona.meta.heading': 'What your stand-in reads right now',
    'persona.meta.updated': 'Last updated',
    'persona.meta.never': 'Not written yet',
    'persona.meta.memory': 'Things I remembered about you',
    'persona.meta.manual': 'Things you wrote yourself',
    // English inflects, Japanese does not — PersonaModule's countLabel() picks
    // the form. Both keys must exist in both languages (the JA pair is
    // identical on purpose).
    'persona.meta.count.one': '1 note',
    'persona.meta.count.other': '{count} notes',
    'persona.meta.concept': 'What the product is for',
    'persona.meta.vision': 'What the business is for',
    'persona.meta.present': 'included',
    'persona.meta.absent': 'not found',
    // Shown after a save that landed but could not be folded into the file the
    // stand-in reads — either because the sources were unreadable and the
    // previous version was kept, or because rebuilding it failed outright. Both
    // mean the same thing to the owner: it is saved, it is not in there yet.
    'persona.meta.stale':
      'Saved — but the file your stand-in reads could not be rebuilt this time, so it will catch up on the next save that succeeds.',

    // --- Today's question (the interview loop) ------------------------------
    // One a day, built from something the owner actually did — never a
    // personality quiz. The copy has to make that obvious, or the question
    // reads as a generic survey and gets ignored.
    'persona.interview.heading': "Today's question",
    'persona.interview.intro':
      'Drawn from your own week — one a day, never the same one twice. Answering teaches your stand-in something it could not have guessed.',
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

    // --- Add / correct form -------------------------------------------------
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

    // --- The notes themselves ----------------------------------------------
    'persona.notes.heading': 'What you wrote yourself',
    'persona.notes.count.one': '1 note',
    'persona.notes.count.other': '{count} notes',
    'persona.notes.basis': 'Where this came from',
    // Same slot as `basis`, used when the note is a correction: what it
    // replaces, not what it came from.
    'persona.notes.corrects': 'This replaces',
    'persona.notes.empty.title': 'Nothing here yet',
    'persona.notes.empty.body':
      'Your stand-in only knows what it has seen. Write the first thing you want it to decide like you would — a call you made, a line you will not cross, a preference it keeps getting wrong.',
    'persona.notes.viewList': 'List',
    'persona.notes.viewGraph': 'Map',

    // --- The synapse map (read-only graph over the same notes) -------------
    // Same purpose as the list, a different lens: how what you wrote connects.
    // No AI reads anything to draw this — the lines are plain rules (shared
    // words, close dates, a correction pointing at what it replaces), so
    // looking at it never costs anything.
    'persona.graph.heading': 'How your notes connect',
    'persona.graph.hint': 'Drag to move around. Scroll to pan, ⌘/Ctrl + scroll to zoom. Click a note to read it.',
    'persona.graph.resetView': 'Recenter',
    'persona.graph.close': 'Close',
    'persona.graph.legend.corrects': 'Correction',
    'persona.graph.legend.tag': 'Shared tag',
    'persona.graph.legend.date': 'Written close together',
    'persona.graph.empty.title': 'Nothing to map yet',
    'persona.graph.empty.body':
      'The map draws lines between notes that share a tag, were written close together, or correct one another. Write a couple more and it starts connecting them.',

    'persona.loading': 'Loading…',
    'persona.loadFailed': 'Could not load this. Retry.',
    'persona.retry': 'Retry',
  } as Record<string, string>,
  ja: {
    'persona.tabLabel': 'ペルソナ',

    'persona.intro.title': 'あなたの分身を育てる',
    'persona.intro.body':
      'OPEN GROUND がこれまでに掴んだ、あなたの決め方です。あなたの分身は、あなたの代わりに何かを判断する前に必ずこれを全部読みます。ここに足したことは、そのまま分身の動きになります。',
    'persona.intro.correctionNote':
      '違っているところを直すのが、いちばん効きます。消えるものは何もありません — 訂正は上に書き足す形で残ります。',

    'persona.meta.heading': '分身がいま読んでいるもの',
    'persona.meta.updated': '最終更新',
    'persona.meta.never': 'まだ作られていません',
    'persona.meta.memory': 'あなたについて覚えたこと',
    'persona.meta.manual': 'あなたが自分で書いたもの',
    'persona.meta.count.one': '1 件',
    'persona.meta.count.other': '{count} 件',
    'persona.meta.concept': 'プロダクトの目的',
    'persona.meta.vision': '事業の目的',
    'persona.meta.present': '入っています',
    'persona.meta.absent': '見つかりません',
    'persona.meta.stale':
      '保存しました。ただし分身が読むファイルは今回作り直せませんでした — 次に成功した保存で反映されます。',

    'persona.interview.heading': '今日の1問',
    'persona.interview.intro':
      'あなたのこの数日の動きから作った質問です。1日1問だけ、同じことは二度聞きません。答えると、分身が推測では届かないところを覚えます。',
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

    'persona.add.heading': '書き足す',
    'persona.add.placeholder': '決めたこと、気づいたこと、分身に知っておいてほしいこと。',
    'persona.add.tagsLabel': 'タグ（任意）',
    'persona.add.tagsPlaceholder': '価格, 採用',
    'persona.add.submit': '追加',
    'persona.add.submitting': '追加しています…',
    'persona.add.failed': '保存できませんでした。もう一度お試しください。',

    'persona.correct.start': 'これを訂正する',
    'persona.correct.heading': '前に書いたものを訂正する',
    'persona.correct.cancel': 'やめる',
    'persona.correct.placeholder': '本当はどうですか？',
    'persona.correct.submit': '訂正を保存',
    'persona.correct.contextPrefix': '前の記述の訂正:',

    'persona.notes.heading': 'あなたが自分で書いたもの',
    'persona.notes.count.one': '1 件',
    'persona.notes.count.other': '{count} 件',
    'persona.notes.basis': 'これが出てきたところ',
    'persona.notes.corrects': 'これを置き換えます',
    'persona.notes.empty.title': 'まだ何もありません',
    'persona.notes.empty.body':
      '分身は、見たことしか知りません。あなたと同じように判断してほしいことを、最初のひとつとして書いてください — 下した判断、絶対に越えない線、いつも取り違えられる好み。',
    'persona.notes.viewList': 'リスト',
    'persona.notes.viewGraph': 'マップ',

    'persona.graph.heading': '書いたものどうしのつながり',
    'persona.graph.hint':
      'ドラッグで動かせます。スクロールでパン、⌘/Ctrl+スクロールでズーム。ノートをクリックすると本文が読めます。',
    'persona.graph.resetView': '中央に戻す',
    'persona.graph.close': '閉じる',
    'persona.graph.legend.corrects': '訂正',
    'persona.graph.legend.tag': '共通タグ',
    'persona.graph.legend.date': '近い日に書いた',
    'persona.graph.empty.title': 'まだ描けるものがありません',
    'persona.graph.empty.body':
      'このマップは、同じタグ・近い日付・訂正関係にある書き足しどうしを線でつなぎます。もう少し書き足すと、つながりが見えてきます。',

    'persona.loading': '読み込んでいます…',
    'persona.loadFailed': '読み込めませんでした。',
    'persona.retry': '再試行',
  } as Record<string, string>,
}
