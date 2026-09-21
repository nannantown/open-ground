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
  'record a question in the heartbeat blocker with a question mark so it reaches the owner inbox. ' +
  'Use plain language: state the decision, the choices and the consequence of each. ' +
  'The commander owns integration; the worker must not bypass stops, holds or approval gates.'
