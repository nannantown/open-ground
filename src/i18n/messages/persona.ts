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
    // The two lines at the TOP of the screen, always visible: what this place
    // is for, and what talking actually does. Written natively per locale —
    // the JA is not a translation of the EN.
    //
    // ⚠ 2026-08-15: SELF-UNDERSTANDING is the subject, not "training a worker"
    // (owner: 「自分をデータベース化することで仕事探しやもの探し、自分探しや
    // 恋愛相談…全てのデータをうまく整理して自分を理解する場」). The old wording
    // pointed at 「右下の質問」 and 「左のコース」, which are no longer where
    // anything is — copy that describes a layout the screen does not have is a
    // lie the reader has to discover on their own.
    'persona.intro.lead': 'A place to build yourself up, one thing at a time.',
    'persona.intro.leadSub':
      'Work, what to buy, what comes next, the people around you — when you are unsure, you can ask yourself here. Every time you talk, one more point lights up and the outline gets sharper.',

    // The first-run invitation in the middle of the stage: a title, what lights
    // the first point (`persona.figure.empty`), and the one thing worth knowing
    // before you start. (`persona.intro.body` retired 2026-08-15 — four lines
    // over an empty figure was a manual, and the rotating placeholder below now
    // says what this place is for.)
    'persona.intro.title': 'Grow your stand-in',
    'persona.intro.correctionNote':
      'Correcting something wrong here is the single most useful thing you can add — nothing is ever deleted, a correction is written on top.',

    // --- The figure ---------------------------------------------------------
    // Every lit point is one note. The dark parts are not styling: they are the
    // parts your stand-in would have to guess at.
    'persona.figure.empty':
      'Nothing is lit yet. Say one thing below — anything you are turning over — and the first point appears.',
    'persona.figure.reset': 'Back to the whole figure',
    // Names the off-screen list that makes every lit point reachable without a
    // mouse (a canvas has no keyboard).
    'persona.figure.nodeList': 'Everything lit in the figure',
    'persona.figure.hint':
      'Scroll to move around · ⌘/Ctrl + scroll to zoom · hold Space and drag to pan',

    // ── the region probe (R2) ───────────────────────────────────────────────
    // Names the second off-screen list. The probe itself is a hover panel, and
    // a hover panel is not reachable from a keyboard — this list is the way in.
    'persona.figure.regionList': 'The parts of the figure',
    // The probe's count line. It counts ONLY notes whose region was read, never
    // the ones merely spread across the body — see `regionUnplaced`, which is
    // printed separately and never added to this.
    'persona.figure.regionKnown': 'Known here {count}',
    'persona.figure.regionUnplaced': 'Not placed yet {count}',
    // Replaces the gesture hint while a region is being probed, because at that
    // moment the useful sentence is what pressing does, not how to pan.
    'persona.figure.probeHint': 'Press a lit point to read that one thing.',

    // --- Hover labels on the figure -----------------------------------------
    'persona.tip.raw': 'From an answer',
    'persona.tip.rawSub': 'It settles into place when the course finishes.',
    'persona.tip.gap': 'Something it does not know yet',
    'persona.tip.gapSub': 'Answer the question below and this lights up.',
    'persona.tip.dust': 'Not formed yet',

    // --- The five regions of the figure -------------------------------------
    // Four ON the body, one halo AROUND it. A course grows one of them
    // (regions.ts COURSE_REGION), so a finished course visibly fills a part of
    // you rather than a score.
    'persona.region.head': 'How you think',
    'persona.region.chest': 'What you hold to',
    'persona.region.arms': 'How you work',
    'persona.region.legs': 'How you keep going',
    'persona.region.people': 'People around you',
    // Printed INSTEAD of a region name under a note that was spread rather than
    // read (regions.ts tier 4). Naming a region there would put a label the
    // owner never chose under the owner's own words.
    'persona.region.unplaced': 'Not placed yet',
    // The region probe's two honest empties. They are NOT the same state and
    // must never share a string: "could not read" is a failure, "nothing here"
    // is a measurement.
    'persona.region.unreadable': 'Could not read this',
    'persona.region.none': 'Nothing here yet',

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

    // --- The portrait: "so what am I like?", answered at a glance -----------
    // Composed from scored results, never generated — so with nothing evidenced
    // the block ASKS instead of saying something that would fit anyone. Names
    // the region for a screen reader (the block itself carries no heading: the
    // lines are the point, and a caption over them would be furniture).
    'persona.portrait.label': 'You, so far',
    'persona.portrait.empty':
      'Not enough yet to say what you are like. Say something below, or take one of the courses.',

    // --- The counts in the top-right corner ---------------------------------
    // Four short mono lines and nothing else: how much is in here, how much is
    // new, how many courses, and how often the stand-in acted for you. The
    // WHOLE block is absent when the portrait could not be read — a 0 there
    // would be a measurement nobody took.
    'persona.counts.label': 'What is in here',
    // ⚠ EVERY ROW NAMES ITS SUBJECT AND ITS WINDOW (owner, 2026-08-16: the three
    // labels were unreadable). The old set had no agent — "Known about you" by
    // WHOM? — and "This week" was a bare adverbial with no noun at all, which
    // only parses if the eye borrows the noun from the row above. It does not,
    // across three rows of unlike things. `stand-in` / 分身 is this screen's
    // established word, so naming the agent costs no new vocabulary.
    'persona.counts.known': 'What your stand-in knows',
    // Folded into row 1 as a faint suffix rather than standing as its own row:
    // a flow belongs under the stock it came from, and the rail drops from four
    // rows to three. ⚠ ABSENT recentCount ⇒ no suffix at all, never '+0'.
    'persona.counts.weekDelta': '+{count} this week',
    'persona.counts.courses': 'Courses taken',
    // Printed WHERE THE NUMBER WOULD GO when the corpus could not be read. The
    // same distinction the region probe makes between `unreadable` and `none`,
    // and for the same reason: "could not look" is a failure and "there is
    // nothing" is a measurement. A 0 here would tell the owner their record is
    // empty at the one moment nobody can see it.
    'persona.counts.unread': 'could not read',
    // The decision ledger, demoted from its own card to one line. Pressing it
    // opens the same detail list the card used to.
    'persona.counts.decided': 'Answered for you (this week)',

    // --- 「分身が知っていること」: the corpus, read back -----------------------
    // ⚠ THE GROUPS ARE SOURCES, and the words say so. Source is a fact already
    // recorded in the tags; topic would have to be invented, and the body region
    // is wrong as a primary axis (most legacy notes are unplaced, so the biggest
    // group would say nothing about its contents). See knownGroups.ts.
    'persona.known.portraitHeading': 'You, so far',
    'persona.known.group.interview': 'Answers to a question',
    'persona.known.group.chat': 'From talking',
    'persona.known.group.import': 'From the imported history',
    'persona.known.group.course': 'From a course',
    'persona.known.group.corrected': 'Corrections you made',
    // ⚠ NOT "Other". "Other" quietly claims we looked and found nothing; what is
    // true is that the record of where this came from is missing.
    'persona.known.group.unrecorded': 'No source recorded',
    'persona.known.filterLabel': 'Filter by word',
    // 「取り消す」. A second act beside 「直す」: correcting says "actually, this",
    // and needs a replacement sentence; taking back says "I don't need this",
    // and needs none.
    'persona.retire.start': 'Take this back',
    'persona.retire.undo': 'Put it back',
    'persona.retire.working': 'Saving…',
    'persona.retire.failed': 'Could not save that just now. Please try again.',
    'persona.retire.at': 'Taken back',
    // 材料 — what the stand-in is BUILT from, behind a disclosure because it is
    // asked rarely and answered permanently. Every source is named, including
    // the ones that did not resolve: a list of only what landed reads as "this
    // is everything", and the missing one is what explains a thin stand-in.
    'persona.material.heading': 'What it is built from',
    'persona.material.concept': 'CONCEPT.md',
    'persona.material.vision': 'The business notes',
    'persona.material.included': 'in',
    'persona.material.missing': 'not found',
    'persona.material.rebuild': 'Rebuild it',
    'persona.material.rebuilding': 'Rebuilding…',
    'persona.material.rebuilt': 'Rebuilt.',
    // ⚠ NOT "failed". The usual case is the assembler REFUSING to overwrite a
    // real corpus from sources that did not resolve — a fail-safe doing its job,
    // and the file on disk is the one that was already there.
    'persona.material.rebuildFailed': 'Left as it was.',
    // 元の言葉 — the owner's own words a line was distilled from. ⚠ ABSENT IS
    // NOT EMPTY: a line written before this was recorded says so, rather than
    // showing a blank quote that reads as "he said nothing".
    'persona.source.heading': 'In his own words',
    'persona.source.missing': 'The original wording was not kept for this one.',
    // 前回から動いたところ — the only claim a self-report is entitled to make,
    // because it is a difference between two of his OWN answers. ⚠ The copy says
    // what moved and NOTHING about what it means: a five-item self-report wobbles
    // by a whole step on a bad morning.
    'persona.delta.heading': 'What moved since last time',
    'persona.delta.since': 'Against the take on {date}',
    'persona.delta.only': 'You have taken this once. There is nothing to compare it with yet.',
    'persona.delta.same': 'no change',
    'persona.delta.noNumber': 'not measured both times',
    'persona.delta.rankPair': '#{before} → #{after}',
    'persona.delta.onlyNow': 'New this time: {names}',
    'persona.delta.onlyBefore': 'Not in this version: {names}',
    'persona.delta.caveat':
      'Answers wobble from day to day. A small movement is not a change in you.',
    // 「どれが自分ではないか」 — the Barnum check. ⚠ NO SCORE ANYWHERE in this copy:
    // a wrong answer is a fact about the SENTENCE (it reads like something anyone
    // would say), not a mark against him.
    'persona.tellApart.heading': 'Which one is not yours',
    'persona.tellApart.lead': 'One of these three was not written from anything you said.',
    'persona.tellApart.later': 'Later',
    'persona.tellApart.right': 'Right — that one would fit almost anybody.',
    'persona.tellApart.wrong': 'That one is yours.',
    'persona.tellApart.stranger': 'The one that fits anybody was this:',
    'persona.tellApart.wrongHint':
      'So that line does not read as particularly yours. You can rewrite it or take it back from its own card below.',
    'persona.tellApart.failed': 'Could not send that just now. Please try again.',
    // 「言ったこと / やったこと」 — the two halves of every answered question, side
    // by side. ⚠ NO VERDICT IN THIS COPY, and none is composed anywhere else
    // either: a machine's ruling on whether a person lives up to their own
    // account of themselves is the sentence this product must never write.
    'persona.saidDid.heading': 'Your answers, and the situation behind them',
    // ⚠ SAYS WHAT IT IS AND WHAT IT IS NOT YET. What sits under each line is the
    // record AS IT WAS WHEN THE QUESTION WAS ASKED — not what happened after.
    // Letting the screen's name imply the second one would be the exact kind of
    // overstatement this surface exists to avoid.
    'persona.saidDid.lead':
      'Each line you wrote answering the question of the day, over the situation that question was drawn from. Nothing here is compared or scored.',
    // ⚠ BOTH HALVES CARRY A LABEL, and both use the screen's own two words.
    // Labelling only the record left the owner unable to tell the halves apart:
    // they are both prose in the same voice, and size alone is a hierarchy, not
    // a legend. The qualifier on the second one is load-bearing — 「やったこと」
    // alone would imply the screen tracks what he did AFTER the declaration,
    // which needs a field nobody is storing yet.
    // ⚠ EVERY LABEL NAMES ITS SUBJECT. Without it the two halves are 「言ったこと」
    // and 「やったこと」 with nobody attached — and the record half's sentences are
    // question framing, so their own grammatical subject is usually the tool
    // ("the swarm asked you…") or missing ("nothing has moved for 9 days").
    // Naming the log answers what the sentence itself cannot.
    'persona.saidDid.said': 'What you answered',
    // ⚠ "What you DID" is wrong for what sits under it: these sentences describe
    // states and absences as often as acts, and their grammatical subject is
    // usually the tool. "About you" makes him the topic, which is what he is.
    'persona.saidDid.did': 'The situation at the time',
    'persona.saidDid.empty':
      'Nothing here yet. Answering the question of the day puts the first pair here.',
    // The way back OFF the list screen. Same word and same shape as every other
    // full-screen panel's return link (BackLink) — the list is a screen now, so
    // it leaves the way screens leave.
    'persona.known.back': 'Back',
    // ⚠ NOT "Delete". Nothing is deleted — the line stays in the file, shows up
    // in its own group below, and comes back in one press. The word has to
    // promise exactly that much and no more.
    'persona.known.group.retired': 'Ones you took back',
    // FOUR DIFFERENT SENTENCES for four different states — see the component.
    'persona.known.loadFailed': 'Could not read this.',
    'persona.known.empty':
      'Nothing in here yet. Say one thing in the box below and the first line appears here.',
    'persona.known.noMatch': 'Nothing here contains that word.',

    // --- The decision ledger: what the stand-in actually DID ----------------
    // The portrait above is SELF-REPORT; this is the record of the proxy acting
    // against real work. It answers one question at a glance — "how often did it
    // answer for me this week?" — so the block is counts and nothing else: no
    // explanation, no encouragement, no sentence that the ledger cannot back.
    // `label` names the region for a screen reader; `week` is the visible cap.
    'persona.ledger.label': 'What your stand-in did',
    'persona.ledger.week': 'This week',
    // Read as "3 answered for you". The number is drawn separately (tabular),
    // so these are the bare labels — lowercase, mid-sentence.
    'persona.ledger.answered': 'answered for you',
    'persona.ledger.asked': 'asked you',
    // 'abstained' is a WIDE lane server-side (a thin corpus, a brain that never
    // produced a usable verdict) — so the word says only what is certain: no
    // answer came back. It never implies the stand-in chose to stay quiet.
    'persona.ledger.abstained': 'could not answer',
    // Shown ONLY when nothing has ever been recorded. An invitation, not an
    // error, and never counts of zero dressed up as activity.
    // Printed under a week of zeros, so an idle week is not mistaken for a dead
    // ledger. Absent whenever the week itself has something to show.
    'persona.ledger.last': 'Last {date}',

    // The list behind the block: one row per decision, newest first.
    'persona.ledger.detail.heading': 'Recent decisions',
    'persona.ledger.verdict.answered': 'Answered for you',
    'persona.ledger.verdict.asked': 'Asked you',
    'persona.ledger.verdict.abstained': 'Could not answer',
    // The reason CLASS behind an 'asked' / 'could not answer' — the free-text
    // reason is never stored, and the class is never shown as its raw slug.
    'persona.ledger.why.irreversible': 'could not be undone',
    'persona.ledger.why.insufficient-info': 'not enough to go on',
    'persona.ledger.why.policy': 'yours to decide',
    // How well what you have written grounded the answer it gave.
    'persona.ledger.confidence.high': 'well grounded',
    'persona.ledger.confidence.medium': 'some grounding',
    'persona.ledger.confidence.low': 'thin grounding',
    // THE ROW THAT MATTERS: it asked, and you decided. That pair is the only
    // thing on this screen that can measure the stand-in against you.
    'persona.ledger.ownerAnswered': 'You answered this · {date}',

    // --- The always-on question (the interview loop) ------------------------
    // One a day, built from something the owner actually did — never a
    // personality quiz. The copy has to make that obvious, or the question
    // reads as a generic survey and gets ignored.
    // ⚠ NOT "Today's question" any more. The owner can now ask for another one
    // whenever they like (2026-08-16: 「1日1答にする必要はない」), so a heading that
    // promises a daily ration contradicts the button underneath it.
    'persona.interview.heading': 'A question for you',
    'persona.interview.skip': 'Not this one',
    // Separate from the above on purpose: there is no answer to reassure the
    // owner about on the skip path.
    'persona.interview.skipFailed': 'Could not skip that just now. Try again.',
    'persona.interview.answered': 'Saved. Your stand-in has this now.',
    // Same event, one honest difference: the answer is safe, but the file the
    // stand-in reads was not rebuilt, so it does not have it yet.
    'persona.interview.answeredStale':
      'Your answer is saved — but it has not reached your stand-in yet. The next save that succeeds will carry it over.',
    'persona.interview.skipped': 'Skipped — this one will not come back.',
    // The ask-for-another control, and the three things it can come back with.
    'persona.interview.more': 'Ask me something',
    'persona.interview.moreLoading': 'Looking…',
    // SWEPT AND FOUND NOTHING — never said off a sweep that failed (the route
    // 500s instead, and that lands on `moreFailed`).
    'persona.interview.moreNone':
      'Nothing new to ask about right now. Get some work done and press again.',
    'persona.interview.moreFailed': 'Could not fetch one just now. Try again.',

    // --- The running course's own furniture ---------------------------------
    // (`persona.ask.hint` / `.idle` and `persona.interview.none.*` went with the
    // question card on 2026-08-15: the day's question is now the conversation's
    // opening turn, and a day with no question simply says nothing rather than
    // spending four lines announcing its own absence.)
    'persona.ask.quit': 'Stop',

    // --- The courses (self-report instruments) ------------------------------
    'persona.course.railHeading': 'Courses',
    // ⚠ TWO FACTS PER ROW, NOT FOUR. "Not taken yet" is the ABSENCE of the ✓ in
    // the row's leading slot, and "grows {region}" is the patch of the figure
    // that lights when the course finishes — both are SHOWN, so neither is
    // written. What is left is the one thing a row cannot show: how long it
    // takes. The verbs (`action.*`) are still rendered, as the button's
    // accessible name: a chevron is silent to a screen reader.
    'persona.course.state.new': '{count} questions',
    'persona.course.state.running': 'In progress — {index} / {total}',
    // A finished course reads its own result back — the row opens the last one,
    // and re-taking is a button INSIDE that sheet (`persona.result.again`). One
    // button per row: the corner is a quiet list, not a rail of controls.
    // ⚠ THE STATE ONLY. The verb moved out to its own right-aligned column
    // (`action.*`): buried at the end of a grey meta line it told nobody the row
    // was pressable, which is exactly what the owner could not see.
    'persona.course.state.done': '{date}',
    'persona.course.action.take': 'Take it',
    'persona.course.action.result': 'See the result',
    'persona.course.action.quit': 'Stop',
    'persona.course.opening': 'Opening your result…',
    'persona.course.historyFailed': 'Could not open that result just now. Try it again.',
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
    // Heads the date strip a re-opened result carries when the same course has
    // been taken more than once. Never drawn for a single take.
    'persona.result.takes': 'Earlier takes',
    'persona.result.minted': 'What went into your persona',
    'persona.result.mintedPartial':
      'Some of these have not reached your stand-in yet — the next save that succeeds will carry them over.',
    'persona.result.caveat':
      'This is a self-report, not a verdict on who you are. Where it disagrees with the record of what you actually decided, the disagreement is the useful part — your persona keeps both and builds its next question out of the gap.',
    'persona.result.back': 'Back to the persona',
    'persona.result.again': 'Take it again',

    // --- Writing into it: correcting something already in there --------------
    // There is no "add a note" button any more (2026-08-15). Talking IS how
    // things go in — the composer below only ever opens over an existing line,
    // to correct it. `persona.add.*` survives for the parts the correction
    // composer shares with what used to be the add form.
    'persona.add.tagsLabel': 'Tags (optional)',
    'persona.add.tagsPlaceholder': 'pricing, hiring',
    'persona.add.submitting': 'Adding…',
    'persona.add.failed': 'Could not save that. Try again.',

    'persona.correct.start': 'Correct this',
    // The same offer, worn by a kept line under a reply. Same mechanism
    // underneath — it opens the very composer `persona.correct.start` opens.
    'persona.correct.pressToFix': 'press to fix it',
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

    // ── the conversation (R4) ───────────────────────────────────────────────
    // Talking IS how the persona grows (owner: 「対話していけば勝手にペルソナに
    // 入る」). 「勝手に入る」 means there is no approval step — it does NOT mean
    // invisible: every kept line is printed under the message it came from and
    // can be corrected, which is what `keptLead` / `correct.pressToFix` are for.
    'persona.chat.placeholder': 'Say something — “{prompt}”',
    // ⚠ WHILE TODAY'S QUESTION IS OPEN, THE BOX IS THAT QUESTION'S ANSWER BOX.
    // The rotating placeholder above suggests a DIFFERENT thing to talk about,
    // and shown under an unanswered question it reads as a second, competing
    // prompt — the owner could not tell where the answer was supposed to go
    // (field report, 2026-08-15). One box, one job at a time: the rotation stops
    // and the box says which question it belongs to.
    'persona.chat.placeholderAnswer': 'Answer it here',
    // The input's STABLE accessible name: the placeholder rotates, and an input
    // named only by its placeholder is renamed every four seconds.
    'persona.chat.inputLabel': 'Say something',
    'persona.chat.send': 'Send',
    // Under the input, always. Swapped for `hintCorrect` the moment a line has
    // been kept, because at that point the useful sentence is what to do about
    // a line that is wrong.
    'persona.chat.hint': 'What you say here is read for things about you, and those are kept.',
    'persona.chat.hintCorrect': 'Press one if it is wrong. Nothing is deleted — the fix is written on top.',
    // NO fake typing animation. A turn is a whole cold `claude` start (tens of
    // seconds), and a three-dot bubble that pretends otherwise is the lie.
    // Before the first poll comes back there is nothing to count yet, and an
    // answer to the day's question is a plain save rather than a `claude` run —
    // so the first line is about SENDING and the counter only starts once there
    // really is a wait to report.
    'persona.chat.sending': 'Sending…',
    'persona.chat.thinking': 'Thinking… {seconds}s',
    'persona.chat.turnFailed': 'That did not go through. What you wrote is still here.',
    // A turn a person STOPPED is not a turn that failed. The stop exists because
    // a run holds the single-flight slot for up to ten minutes on their own
    // subscription; pressing it must not then accuse them of a failure.
    'persona.chat.stop': 'Stop',
    'persona.chat.stopped': 'You stopped this. What you wrote is still here.',
    'persona.chat.retry': 'Send it again',
    // The thread could not be READ. Never rendered as an empty conversation —
    // "you have said nothing" is the one claim a failed read cannot make.
    'persona.chat.stateUnreadable': 'Could not read the conversation so far.',
    'persona.chat.keptLead': 'Learned',
    // An ABSENT chip row must never mean "something was written you cannot
    // see", so a turn that kept nothing says so.
    'persona.chat.keptNone': 'Nothing was kept this time.',
    'persona.chat.keptStale':
      'Saved — but it has not reached the file your stand-in reads yet.',
    // A line the distiller produced that could not be placed. Dropped rather
    // than guessed at, and counted rather than swallowed.
    'persona.chat.keptUnreadable': '{count} more could not be read, so they were left out.',
    'persona.chat.busy': 'Still working on the last one. Try again when it lands.',
    'persona.chat.failed': 'Could not send that. What you wrote is still here.',
    // SUBSCRIPTION-ONLY: this drives your own `claude`, never an API key.
    'persona.chat.claudeMissing': 'The `claude` command was not found on this machine.',
    'persona.chat.claudeLoggedOut': 'Your `claude` is signed out. Sign in and try again.',

    // ── dropping a claude.ai export into the same slot ──────────────────────
    // Same act as talking — you are handing over things you already said.
    'persona.import.dropHint': 'Drop it here — the export zip, or conversations.json',
    'persona.import.reading': 'Reading…',
    'persona.import.parsed': 'Read your own messages out of {conversations} conversations.',
    'persona.import.ownerOnly': 'The replies you were given are not included.',
    'persona.import.unreadableRows': '{count} rows could not be read and were skipped.',
    'persona.import.dropped': '{count} messages were not yours, so they were dropped.',
    'persona.import.considered': '{count} of them were actually read.',
    // MANDATORY, even at 0. A number that hides its own losses is the failure
    // this screen keeps re-hitting.
    'persona.import.notConsidered': '{count} were not looked at this time.',
    'persona.import.keptCount': 'Learned {count}',
    'persona.import.duplicates': '{count} were already in here word for word, so they were not written again.',
    'persona.import.keptUnreadable': '{count} could not be read and were left out.',
    // ⚠ RETIRED 2026-08-15, kept only so an older running server's error key
    // still renders something true. The app READS the zip now — it is what
    // claude.ai actually hands over, and refusing it meant telling the owner to
    // open the archive themselves at the one moment we were asking for their
    // history. Do not wire this to anything new.
    'persona.import.zipUnsupported':
      'That zip could not be opened. If it holds a conversations.json, dropping that file works too.',
    'persona.import.unreadableFile': 'That could not be read as a claude.ai export.',
    // Refused BEFORE the upload — see MAX_EXPORT_UPLOAD_BYTES. Names the real
    // size and the cap, because the only remedy is on the owner's side.
    'persona.import.tooLarge':
      'That file is {size} MB. The most this can take in at once is {max} MB. Split it, or take out the conversations you want read.',
    'persona.import.already': 'This exact file was already taken in on {date}.',
    'persona.import.busy': 'Another import is already running.',
    'persona.import.failed': 'Could not take that in.',

    // ── where this goes (the privacy note) ──────────────────────────────────
    // EXACT, never reassuring. The files are local, the CONVERSATION is not,
    // and the training switch is not ours to flip. Pinned word-for-word by
    // PersonaConversation.test.tsx — a privacy lie has to be a red test, not a
    // review finding.
    // ⚠ EVERY SENTENCE HERE IS LOAD-BEARING AND WAS WRONG ONCE (2026-08-15).
    // Adversarial review found three overclaims in the first version: it said
    // the app writes only to ~/.openground/ (a conversation also records a
    // trusted folder in ~/.claude.json), it promised the corpus is sent "only
    // as much as needed" (nothing enforces that — the run is handed a path and
    // decides), and it said nothing at all about the import, which ships up to
    // 400 of the owner's own past messages. A privacy note that is reassuring
    // and false is worse than none.
    'persona.privacy.summary': 'Where all this goes',
    'persona.privacy.local':
      'What you build up is stored on this machine: ~/.openground/, readable only by you. It is never uploaded anywhere — this app has no server of its own. (A conversation also leaves a working folder there, and records that folder as trusted in ~/.claude.json, which is how the claude command works.)',
    'persona.privacy.conversation':
      'Talking to it sends that exchange through your OWN Claude account to Anthropic, the same as any Claude conversation. It is handed a path to what you have built up and decides how much to read — so how much gets sent is up to the model, not a limit this app enforces.',
    'persona.privacy.import':
      'Dropping an export sends your own past messages from it to Anthropic as well — up to 400 at a time — so they can be turned into what it knows about you. That is what the import is; worth knowing before you drop a year of conversations in.',
    'persona.privacy.training':
      'Whether it is used for training is decided in claude.ai’s own settings. It cannot be changed from this app (saying otherwise would be a lie). Switch it at claude.ai → Settings → Privacy.',

    // ── the rotating placeholder ────────────────────────────────────────────
    // Not decoration: it is the only place that says what this screen is FOR.
    // One example reads as "this is a work tool"; the rotation is how a reader
    // learns they can bring a flat, a breakup or a hobby here too (owner,
    // 2026-08-15). Written across the five regions of the figure on purpose, so
    // the prompts and the body map teach the same thing.
    'persona.prompt.01': 'I keep thinking about leaving my job',
    'persona.prompt.02': 'Would I sign off on this?',
    'persona.prompt.03': 'Work has been draining me lately',
    'persona.prompt.04': 'There is a job I want to turn down',
    'persona.prompt.05': 'Do this myself, or hand it over?',
    'persona.prompt.06': 'I am stuck between two very similar chairs',
    'persona.prompt.07': 'Would I actually keep using this?',
    'persona.prompt.08': 'It is expensive — talk me into it or out of it',
    'persona.prompt.09': 'Something a friend said is still stuck in me',
    'persona.prompt.10': 'Should I put some distance there?',
    'persona.prompt.11': 'Do you think this one lasts?',
    'persona.prompt.12': 'I do not know how to explain this to my parents',
    'persona.prompt.13': 'Lately I cannot tell what I want',
    'persona.prompt.14': 'I think I have gotten softer than I was',
    'persona.prompt.15': 'I am not resting properly on my days off',
    'persona.prompt.16': 'I cannot put next year into words yet',
    'persona.prompt.17': 'When am I slow to decide?',
    'persona.prompt.18': 'What changed between last year and now?',

    'persona.loading': 'Loading…',
    'persona.loadFailed': 'Could not load this.',
    'persona.retry': 'Retry',
  } as Record<string, string>,
  ja: {
    'persona.tabLabel': 'ペルソナ',

    // 承認モック(persona-v2.html)の逐語。
    'persona.intro.lead': '自分のことを、ここに溜めていく場所です。',
    'persona.intro.leadSub':
      '仕事、買うもの、これからのこと、人との関係 — 迷ったら、ここで自分に聞けます。話すたびに点が1つ灯り、輪郭がはっきりしていきます。',

    'persona.intro.title': 'あなたの分身を育てる',
    'persona.intro.correctionNote':
      '違っているところを直すのが、いちばん効きます。消えるものは何もありません — 訂正は上に書き足す形で残ります。',

    'persona.figure.empty':
      'まだ何も灯っていません。下で何かひとつ話しかけると、最初のひとつが灯ります。',
    'persona.figure.reset': '全体に戻る',
    'persona.figure.nodeList': '図に灯っているもの',
    'persona.figure.hint':
      'スクロールで移動、⌘/Ctrl+スクロールで拡大、スペースを押しながらドラッグで動かせます。',

    'persona.figure.regionList': '図の部位',
    'persona.figure.regionKnown': '分かっていること {count}',
    'persona.figure.regionUnplaced': '場所が決まっていないもの {count}',
    'persona.figure.probeHint': 'そのまま押すと、この中の1件ずつが読めます。',

    'persona.tip.raw': '回答から',
    'persona.tip.rawSub': 'コースが終わるとまとまります。',
    'persona.tip.gap': 'まだ知らないこと',
    'persona.tip.gapSub': '下の問いに答えると灯ります。',
    'persona.tip.dust': 'まだ形になっていない部分',

    'persona.region.head': '考え方',
    'persona.region.chest': '大事にしていること',
    'persona.region.arms': 'やり方',
    'persona.region.legs': '続けかた',
    'persona.region.people': '人との関わり',
    'persona.region.unplaced': '場所はまだ決めていません',
    'persona.region.unreadable': 'ここは読めていません',
    'persona.region.none': 'ここはまだ何もありません',

    'persona.node.close': '閉じる',

    'persona.meta.updated': '最終更新',
    'persona.meta.never': 'まだ作られていません',
    'persona.meta.memory': '覚えたこと',
    'persona.meta.manual': '自分で書いたもの',
    'persona.meta.count.one': '1 件',
    'persona.meta.count.other': '{count} 件',
    'persona.meta.stale':
      '保存しました。ただし分身が読むファイルは今回作り直せませんでした — 次に成功した保存で反映されます。',

    'persona.portrait.label': 'いまのところのあなた',
    'persona.portrait.empty':
      'まだ「どういう人か」を言えるだけの材料がありません。下で話しかけるか、コースを1つ受けてください。',

    'persona.counts.label': 'いま溜まっているもの',
    'persona.counts.known': '分身が知っていること',
    'persona.counts.weekDelta': '今週 +{count}',
    'persona.counts.courses': '受けたコース',
    'persona.counts.unread': '読めませんでした',
    'persona.counts.decided': '分身が代わりに答えた（今週）',

    'persona.known.portraitHeading': 'いまのところのあなた',
    'persona.known.group.interview': '1問に答えたこと',
    'persona.known.group.chat': '話したこと',
    'persona.known.group.import': '取り込んだ会話',
    'persona.known.group.course': 'コースの結果',
    'persona.known.group.corrected': '自分で直したもの',
    'persona.known.group.unrecorded': '出どころの記録がないもの',
    'persona.known.filterLabel': '言葉でしぼる',
    'persona.retire.start': '取り消す',
    'persona.retire.undo': '戻す',
    'persona.retire.working': '保存中…',
    'persona.retire.failed': 'いま保存できませんでした。もう一度お試しください。',
    'persona.retire.at': '取り消した',
    'persona.material.heading': '何からできているか',
    'persona.material.concept': 'CONCEPT.md',
    'persona.material.vision': '事業のメモ',
    'persona.material.included': '入っている',
    'persona.material.missing': '見つかりません',
    'persona.material.rebuild': '作り直す',
    'persona.material.rebuilding': '作り直しています…',
    'persona.material.rebuilt': '作り直しました。',
    'persona.material.rebuildFailed': 'そのままにしました。',
    'persona.source.heading': '元の言葉',
    'persona.source.missing': 'この行は元の言葉が残っていません。',
    'persona.delta.heading': '前回から動いたところ',
    'persona.delta.since': '{date} に受けたときとの比較',
    'persona.delta.only': 'まだ1回しか受けていません。比べる相手がまだありません。',
    'persona.delta.same': '動きなし',
    'persona.delta.noNumber': '両方では測れていません',
    'persona.delta.rankPair': '{before}位 → {after}位',
    'persona.delta.onlyNow': '今回から増えた項目: {names}',
    'persona.delta.onlyBefore': '今回は無い項目: {names}',
    'persona.delta.caveat': '答えは日によって揺れます。小さな動きは、あなたが変わったということではありません。',
    'persona.tellApart.heading': 'どれが自分ではないか',
    'persona.tellApart.lead': '3つのうち1つは、あなたが言ったことから作られた文ではありません。',
    'persona.tellApart.later': 'あとで',
    'persona.tellApart.right': '見分けがつきました。これは誰にでも当てはまる文です。',
    'persona.tellApart.wrong': 'それは、あなた自身の言葉でした。',
    'persona.tellApart.stranger': '誰にでも当てはまる文は、こちらでした。',
    'persona.tellApart.wrongHint':
      'つまりこの一文は、あなたのものだと見分けがつきにくいということです。下の一覧から、直すことも取り消すこともできます。',
    'persona.tellApart.failed': 'いま送れませんでした。もう一度お試しください。',
    // ⚠ THE NAME WAS THE LAST THING STILL OVERSTATING (owner, 2026-08-17:
    // 「実際には僕の指示とその時の状況ですよね？」). It is. Nothing on this screen is
    // 「やったこと」: the lower half is the SITUATION the question was drawn from —
    // a state, not an act. And the upper half is his ANSWER to that question;
    // most read as instructions, but not all («レビューで止まるのは、自分が読む
    // 時間を取っていないだけ» is an observation), so 「指示」 would overshoot in the
    // other direction.
    //
    // Named by PROVENANCE instead, which is the rule this feature already uses
    // to group the corpus (knownGroups.ts): what it IS, not what it means. The
    // name earns 「やったこと」 back when a declaration can be tracked against the
    // record that came AFTER it — which needs a field nobody is storing yet.
    'persona.saidDid.heading': '答えたことと、そのときの状況',
    'persona.saidDid.lead':
      '「今日の1問」にあなたが答えた一文と、その問いが引いてきた、そのときの状況。突き合わせも採点もしません。',
    'persona.saidDid.said': 'あなたが答えたこと',
    // ⚠ 「あなたが」 IS THE WRONG PARTICLE HERE, and 「やったこと」 the wrong noun.
    // The sentences under this plate are question framing: their subject is
    // usually the tool (「スウォームがあなたに聞いてきて…」), they often describe an
    // ABSENCE rather than an act (「9日動いていません」), and they end 「〜ときの話
    // です」. A heading that names an action BY HIM sits ungrammatically over all
    // three (owner, 2026-08-17: 「やったことと、文章の組み合わせおかしくない？」).
    // 「あなたについて」 marks him as the TOPIC rather than the agent, which is
    // what he actually is in these records — and it reads over an act, a state
    // and an absence alike. The top plate keeps 「あなたが」 because there he IS
    // the agent; the two particles carry the difference.
    //
    // The log sits at the END, in brackets: mid-phrase the plate's uppercase
    // turns it into 「BOARD」, and a shouted proper noun inside a 和文 phrase
    // reads as a fault. At the end it reads as a citation.
    // ⚠ NO SOURCE BRACKET (owner, 2026-08-17: 「スウォームの記録とかボードの記録
    // とかの表記はいらない」). It was added to answer 「誰がやったのか」 while the
    // plate still read 「あなたがやったこと」; once the plate said 「状況」 the actor
    // question stopped being asked, and the bracket was machine bookkeeping on
    // a screen that is meant to be read slowly. The kind→log map went with it —
    // code with no reader does not stay.
    'persona.saidDid.did': 'そのときの状況',
    'persona.saidDid.empty': 'まだありません。今日の1問に答えると、ここに1組目が出ます。',
    'persona.known.back': '戻る',
    'persona.known.group.retired': '取り消したもの',
    'persona.known.loadFailed': '読み込めませんでした。',
    'persona.known.empty': 'まだ何も入っていません。下で何かひとつ話しかけると、ここに1行目が出ます。',
    'persona.known.noMatch': 'その言葉を含むものはありません。',

    'persona.ledger.label': '分身がしたこと',
    'persona.ledger.week': '今週',
    'persona.ledger.answered': '代わりに答えた',
    'persona.ledger.asked': 'あなたに聞いた',
    'persona.ledger.abstained': '答えられなかった',
    'persona.ledger.last': '最後は{date}',

    'persona.ledger.detail.heading': '最近の判断',
    'persona.ledger.verdict.answered': '代わりに答えた',
    'persona.ledger.verdict.asked': 'あなたに聞いた',
    'persona.ledger.verdict.abstained': '答えられなかった',
    'persona.ledger.why.irreversible': '取り返しがつかないこと',
    'persona.ledger.why.insufficient-info': '材料が足りなかった',
    'persona.ledger.why.policy': 'あなたが決めること',
    'persona.ledger.confidence.high': '根拠は厚い',
    'persona.ledger.confidence.medium': '根拠はそこそこ',
    'persona.ledger.confidence.low': '根拠は薄い',
    'persona.ledger.ownerAnswered': 'これはあなたが答えました ・ {date}',

    'persona.interview.heading': 'あなたへの1問',
    'persona.interview.skip': 'これは飛ばす',
    'persona.interview.skipFailed': 'いま飛ばせませんでした。もう一度お試しください。',
    'persona.interview.answered': '保存しました。分身がこれを覚えました。',
    'persona.interview.answeredStale':
      '答えは保存しました。ただし分身にはまだ渡っていません — 次に成功した保存で反映されます。',
    'persona.interview.skipped': '飛ばしました。この質問はもう出てきません。',
    'persona.interview.more': 'もう1問もらう',
    'persona.interview.moreLoading': '探しています…',
    'persona.interview.moreNone':
      'いまは新しく聞くことがありません。しばらく仕事を進めてから、もう一度どうぞ。',
    'persona.interview.moreFailed': 'いま出せませんでした。もう一度お試しください。',

    'persona.ask.quit': 'やめる',

    'persona.course.railHeading': '診断コース',
    'persona.course.state.new': '{count}問',
    'persona.course.state.running': '{index} / {total} 進行中',
    'persona.course.state.done': '{date}',
    'persona.course.action.take': '受ける',
    'persona.course.action.result': '結果を見る',
    'persona.course.action.quit': 'やめる',
    'persona.course.opening': '結果を開いています…',
    'persona.course.historyFailed': 'いま前の結果を開けませんでした。もう一度押してみてください。',
    'persona.course.submitting': '採点しています…',
    'persona.course.failed': '結果を保存できませんでした。答えは残っています。',
    'persona.course.retry': 'もう一度送る',

    'persona.result.kicker': '結果',
    'persona.result.answered': '{count}問すべてに回答',
    'persona.result.source': '出典: {source}',
    'persona.result.takes': 'これまでの回',
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

    'persona.add.tagsLabel': 'タグ（任意）',
    'persona.add.tagsPlaceholder': '価格, 採用',
    'persona.add.submitting': '追加しています…',
    'persona.add.failed': '保存できませんでした。もう一度お試しください。',

    'persona.correct.start': '直す',
    'persona.correct.pressToFix': '押すと直せます',
    'persona.correct.heading': '前に書いたものを訂正する',
    'persona.correct.cancel': 'やめる',
    'persona.correct.placeholder': '本当はどうですか？',
    'persona.correct.submit': '訂正を保存',
    'persona.correct.contextPrefix': '前の記述の訂正:',

    'persona.notes.basis': 'これが出てきたところ',
    'persona.notes.corrects': 'これを置き換えます',

    // ── 対話(R4)─────────────────────────────────────────────────────────
    // 承認モック(persona-v2.html)の逐語。「勝手に入る」は確認ダイアログが無い
    // という意味であって、見えないところで書くという意味ではない。
    'persona.chat.placeholder': '話しかける — 「{prompt}」',
    'persona.chat.placeholderAnswer': 'ここに答える',
    'persona.chat.inputLabel': '話しかける',
    'persona.chat.send': '送る',
    'persona.chat.hint': '話した内容から、あなたについて分かったことを拾います。',
    'persona.chat.hintCorrect': '違っていたら押してください。消さずに、上から書き直します。',
    'persona.chat.sending': '送っています…',
    'persona.chat.thinking': '考えています… {seconds}秒',
    'persona.chat.turnFailed': 'うまくいきませんでした。書いた言葉は残っています。',
    'persona.chat.stop': 'やめる',
    'persona.chat.stopped': 'やめました。書いた言葉は残っています。',
    'persona.chat.retry': 'もう一度送る',
    'persona.chat.stateUnreadable': 'これまでの会話が読めませんでした。',
    'persona.chat.keptLead': '分かったこと',
    'persona.chat.keptNone': '今回は何も拾いませんでした。',
    'persona.chat.keptStale': '保存はされましたが、まとめ直しには入っていません。',
    'persona.chat.keptUnreadable': '読めなかった行が{count}件あり、入れていません。',
    'persona.chat.busy': 'まだ前の返事を作っています。終わってからもう一度どうぞ。',
    'persona.chat.failed': '送れませんでした。書いた言葉は残っています。',
    'persona.chat.claudeMissing': 'このパソコンで `claude` が見つかりませんでした。',
    'persona.chat.claudeLoggedOut': '`claude` がサインアウトしています。サインインしてからお試しください。',

    // ── claude.ai の書き出しを同じ場所に落とす ──────────────────────────
    'persona.import.dropHint': 'ここに落とす — 書き出しの zip でも conversations.json でも',
    'persona.import.reading': '読んでいます…',
    'persona.import.parsed': '{conversations}件の会話から、あなたの発言だけを読みました。',
    'persona.import.ownerOnly': '返ってきた側の発言は入れていません。',
    'persona.import.unreadableRows': '読めなかった行が{count}件あり、飛ばしました。',
    'persona.import.dropped': 'あなた以外の発言{count}件は入れていません。',
    'persona.import.considered': 'このうち{count}件を実際に読みました。',
    'persona.import.notConsidered': '残り{count}件は今回見ていません。',
    'persona.import.keptCount': '分かったこと {count}件',
    'persona.import.duplicates': '同じ内容が既にあったもの{count}件は、書き足していません。',
    'persona.import.keptUnreadable': '読めなかった行{count}件は入れていません。',
    'persona.import.zipUnsupported':
      'この zip は開けませんでした。中に conversations.json があるなら、それを落としても大丈夫です。',
    'persona.import.unreadableFile': 'これは claude.ai の書き出しとしては読めませんでした。',
    'persona.import.tooLarge':
      'このファイルは {size}MB あります。一度に取り込めるのは {max}MB までです。分割するか、読ませたい会話だけ抜き出してください。',
    'persona.import.already': 'このファイルは{date}に取り込み済みです。',
    'persona.import.busy': 'いま別の取り込みが動いています。',
    'persona.import.failed': '取り込めませんでした。',

    // ── これはどこに行くのか(承認モックの逐語・やわらげ禁止)──────────
    'persona.privacy.summary': 'これがどこへ行くか',
    'persona.privacy.local':
      '溜めたものは、このパソコンの ~/.openground/ に、あなただけが読める形で置かれます。どこにもアップロードしません(このアプリ自身のサーバはありません)。なお、会話をすると作業用のフォルダも同じ場所にでき、そのフォルダを「信頼済み」として ~/.claude.json に記録します — claude コマンドの仕組み上そうなります。',
    'persona.privacy.conversation':
      '分身と話すと、そのやりとりは「あなた自身の」 Claude アカウントを通って Anthropic に送られます。普通に Claude と話すのと同じです。溜めたものは「置いてある場所」を渡していて、どこまで読むかは向こうが決めます — つまり送られる量は、このアプリが縛っているわけではありません。',
    'persona.privacy.import':
      '書き出しファイルを落とすと、その中のあなた自身の過去の発言も Anthropic に送られます(一度に最大400件)。それを材料にして「分かったこと」を作るので、取り込みとはそういうものです。1年ぶんを落とす前に知っておいてください。',
    'persona.privacy.training':
      '学習に使わせないかどうかは、claude.ai 側の設定で決まります。このアプリからは変えられません（できると書くのは嘘になります）。claude.ai → 設定 → プライバシー で切り替えてください。',

    // ── 入口で回る例(承認モックの18本を逐語)────────────────────────
    'persona.prompt.01': '転職しようか迷ってる',
    'persona.prompt.02': 'この案、私なら通すと思う?',
    'persona.prompt.03': '最近、仕事で消耗してる',
    'persona.prompt.04': '断りたい仕事があるんだけど',
    'persona.prompt.05': '一人でやるか、人に渡すか',
    'persona.prompt.06': '同じような椅子で迷ってる',
    'persona.prompt.07': 'これ、私が続けて使うと思う?',
    'persona.prompt.08': '高いけど買っていいか背中を押してほしい',
    'persona.prompt.09': '友だちに言われたことが刺さってる',
    'persona.prompt.10': '距離を置いたほうがいいのかな',
    'persona.prompt.11': 'この人と長く続くと思う?',
    'persona.prompt.12': '親にどう説明したらいいかわからない',
    'persona.prompt.13': '最近、自分が何をしたいのか分からない',
    'persona.prompt.14': '前より丸くなった気がする',
    'persona.prompt.15': '休みの日、うまく休めてない',
    'persona.prompt.16': '来年どうなっていたいか、まだ言葉にできない',
    'persona.prompt.17': '私って、どういうときに決めるのが遅い?',
    'persona.prompt.18': '去年の私と、何が変わった?',

    'persona.loading': '読み込んでいます…',
    'persona.loadFailed': '読み込めませんでした。',
    'persona.retry': '再試行',
  } as Record<string, string>,
}
