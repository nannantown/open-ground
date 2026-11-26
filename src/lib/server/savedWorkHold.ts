// savedWorkHold — ONE wording and ONE predicate for "this project has an
// operation whose result nobody confirmed" (an uncertain receipt).
//
// While one is left, every SDK launch in the project throws at its first step
// and every tool call of a running session is denied (runtimeActionReceipts.ts:
// the launch guard and the PreToolUse hook ask the same question). That safeguard
// is right and stays — nothing here retries, clears or bypasses it. What was
// missing is the engine KNOWING: it kept dispatching workers that died on arrival
// ("worker lost", no reason), kept waking a commander that could not start, and
// told nobody (2026-11-09 → 11-23, five projects).
//
// The words point at the Settings screen by its OWN labels, read from the same
// table the screen renders. The earlier hint named 「会話の復旧」, a heading that
// screen does not have, so the owner could not find where to go.

import { settings as settingsMessages } from '../../i18n/messages/settings'

const ja = settingsMessages.ja

/** Where the owner reviews unconfirmed operations, as the Settings screen spells it. */
export const OWNER_REVIEW_WHERE = `設定の「${ja['settings.advanced']}」›「ChatGPT」›「${ja['settings.recovery.title']}」`

/** The words every hold that only the owner's review can clear carries. Matched
 *  by the boot resume (`ownerOnly`) — keep it one constant. */
export const OWNER_REVIEW_HOLD_HINT = `${OWNER_REVIEW_WHERE}で確認すると再開します`

/** How many unconfirmed operations hold this project's automatic work right now —
 *  the question every SDK launch and tool call asks
 *  (`assertNoUncertainRuntimeActions(cwd, false)`), answered for the engine.
 *  Throws exactly when that question throws (the owner's sign-in cannot be
 *  confirmed, the record cannot be read): a launch would then fail the same way. */
export const savedWorkHoldCount = async (projectPath: string): Promise<number> => {
  const { listUncertainRuntimeActions } = await import('./runtimeActionReceipts')
  return (await listUncertainRuntimeActions(projectPath, false)).length
}

/** Why the commander could not be started, in the owner's words. The reflex used
 *  to call every failed wake "no usable model tier" — for eight hours on
 *  2026-11-24 while the real cause was an unconfirmed operation, and it went on
 *  saying so after the limit had lifted. The launch's own words decide first
 *  (`reason`: what the launch threw, or why the desk ended at start); a wall in
 *  the model table (`wall`) is named only when the launch did not say otherwise.
 *  An unconfirmed operation comes with where to go and what clears it. */
export const commanderFailureWords = (reason: string | undefined, wall: 'all-cooling' | 'none-allowed' | null): string =>
  reason && /unconfirmed result/i.test(reason)
    ? `結果を確かめられなかった操作が残っています(${OWNER_REVIEW_HOLD_HINT})`
    : wall === 'all-cooling'
      ? '使用量の上限で、いま使えるモデルがありません(上限が明けると自動で起動します)'
      : wall === 'none-allowed'
        ? '使えるモデルがすべてオフになっています(設定の「使用可能モデル」で1つオンにすると起動します)'
        : reason && plainReason(reason)
          ? `起動時の理由: ${plainReason(reason)}`
          : reason
            ? `起動直後に止まりました(${IN_THE_JOURNAL})`
            : '理由は記録されていません(エンジンの記録の integrate 行を確認してください)'

const IN_THE_JOURNAL = '詳しい理由はエンジンの記録にあります'

/** A failure's own words, when they are the owner's language: the known cases
 *  are written plain (swarmWorker.ts). A raw English error or git's output is
 *  not — it stays in the engine journal, which every caller writes it to, and
 *  the notice says so instead (review 2026-11-26). */
const plainReason = (reason: string): string | null => {
  const words = reason.replace(/^createSwarmWorktree: /, '')
  return /[぀-ヿ一-鿿]/.test(words) ? words : null
}

/** The president's notice for a card whose dispatch keeps failing. */
export const dispatchFailureNotice = (taskTitle: string, reason: string): string =>
  `「${taskTitle}」の作業を始めようとして、失敗が続いています(${plainReason(reason) ? `理由: ${plainReason(reason)}` : IN_THE_JOURNAL})。` +
  '原因が解消すると自動で始まります。'

/** The president's notice for a project in the automation frame whose engine
 *  keeps failing to start. */
export const automationStartNotice = (reason: string): string =>
  `このプロジェクトは自動運用の枠に入っていますが、作業を自動で始められない状態が続いています(${plainReason(reason) ? `理由: ${plainReason(reason)}` : IN_THE_JOURNAL})。` +
  '理由が解消すると自動で始まります。'

/** The president's notice for a worker whose every tool call is refused (the
 *  runtime action guard: the owner's account could not be confirmed, or the
 *  operation could not be recorded). Plain words, one line. */
export const toolDenialNotice = (taskTitle: string): string =>
  `「${taskTitle}」の担当が、道具(コマンドやファイルの操作)をすべて断られていて作業を進められません。` +
  'オーナーのアカウントが確かめられないときや、操作の記録ができないときに起きます。' +
  `設定でサインインしているかを確かめ、${OWNER_REVIEW_WHERE}に項目があれば確認してください。`

/** The president's notice when the launch guard cannot even ask: every launch
 *  would fail at its first step, so nothing is started. Worded by cause — only a
 *  sign-in failure sends the owner to check their sign-in; a record that could
 *  not be read is a different thing (review 2026-11-26). */
export const ownerUnconfirmedNotice = (running: number, signIn = true): string =>
  (signIn ? 'オーナーのアカウントが確かめられないため' : '操作の記録が読み取れないため') +
  '、このプロジェクトで新しい作業の開始と司令官の起動を止めています' +
  (running > 0 ? `(作業中の ${running} 件も道具を使えず止まっています)` : '') +
  (signIn
    ? '。設定でサインインしているかを確かめてください。確かめられると自動で再開します。'
    : '。読み取れるようになると自動で再開します。長く続くときはアプリを再起動してください。')

/** The president's notice for a saved-work hold: what is happening, and where to
 *  press what. Plain words, one line, under the supply desk's 400-character cap. */
export const savedWorkHoldNotice = (running: number): string =>
  'このプロジェクトに、結果を確かめられなかった操作が残っているため、新しい作業の開始と司令官の起動を止めています' +
  (running > 0 ? `(作業中の ${running} 件も道具を使えず止まっています)` : '') +
  `。${OWNER_REVIEW_WHERE}を開き、「${ja['settings.recovery.note']}」を書いて「${ja['settings.recovery.review']}」を押すと自動で再開します。` +
  '確認が済むまで、同じ操作を自動でやり直すことはありません。'
