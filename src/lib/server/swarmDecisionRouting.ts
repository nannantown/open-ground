// Approval boundaries are explicit product rules, never a learned owner profile.
export const PERMANENT_OWNER_BOUNDARIES: readonly string[] = [
  'リリース・公開',
  'プロジェクトの削除',
  '使用可能モデルの変更',
  '停止(none-allowed park)の解除',
  '自案カードの着手承認',
  '過去 escalation への回答',
  '[hold] カードの統合',
]

// A single line because this is appended to the /order goal argument.
export const DECISION_ROUTING_RULES =
  ' Decision authority: implement the requested task within its explicit scope. ' +
  'Resolve ordinary technical choices through repository conventions, investigation and the commander. ' +
  'Never infer permission from a personal profile or impersonate the owner. ' +
  'Obtain explicit owner approval for irreversible actions and these standing boundaries: ' +
  PERMANENT_OWNER_BOUNDARIES.join(' / ') + '. ' +
  'Existing explicit approval applies only to its stated scope. When approval or missing intent blocks the task, ' +
  'record a question in the heartbeat blocker with a question mark; the commander answers it first and hands on to the owner only what the owner must decide. ' +
  'Use plain language: state the decision, the choices and the consequence of each. ' +
  'The commander owns integration; the worker must not bypass stops, holds or approval gates.'

/**
 * Does this worker question touch a standing owner boundary, so it must skip the
 * commander and go straight to the owner? (Owner decision 2026-09-23: worker
 * questions are settled inside the company first — commanderQuestions.ts.)
 *
 * DELIBERATELY AN OVER-APPROXIMATION. A false positive costs one question the
 * owner could have been spared, which is what happened to EVERY question before
 * this lane existed. A false negative would let the commander answer something
 * the owner reserved — and the commander lane still refuses nothing by itself,
 * so this word list is the structural stop. When in doubt, add a word here.
 * Pure.
 */
const OWNER_BOUNDARY_WORDS =
  /(リリース|公開|配布|デプロイ|本番|削除|消去|消す|破棄|課金|支払|請求|料金|費用|予算|お金|契約|解約|モデル|アカウント|パスワード|秘密|個人情報|権限|停止.*解除|見送|取り込まない|push|release|publish|deploy|production|delet|remove (the )?(project|repo)|billing|payment|price|cost|budget|credential|password|secret|token|model)/i

export const needsOwnerDirectly = (text: string): boolean => OWNER_BOUNDARY_WORDS.test(text)
