// Owned by the in-app notifications track (the Ground お知らせ bell + panel). Add
// keys as 'notifications.*'. English is the source of truth; every EN key MUST
// have a JA counterpart (the messages.test.ts parity guard enforces this).
export const notifications = {
  en: {
    // Bell button (tooltip / a11y name). `bellWithUnread` is used when there are
    // unread notifications so the count is announced without a hover.
    'notifications.bell': 'Notifications',
    'notifications.bellWithUnread': 'Notifications ({count} new)',
    // Panel
    'notifications.title': 'Notifications',
    'notifications.empty': 'No notifications',
    // collab-invite row. {inviter} = who invited you, {project} = the shared name.
    'notifications.collabInvite': '{inviter} invited you to “{project}”',
    'notifications.collabInviteNoName': '{inviter} invited you to a shared project',
    // Fallback when the inviter's email can't be resolved.
    'notifications.someone': 'Someone',
    // Action button on an invite row.
    'notifications.join': 'Join',
  } as Record<string, string>,
  ja: {
    'notifications.bell': 'お知らせ',
    'notifications.bellWithUnread': 'お知らせ（新着 {count} 件）',
    'notifications.title': 'お知らせ',
    'notifications.empty': 'お知らせはありません',
    'notifications.collabInvite': '{inviter} さんが「{project}」に招待しました',
    'notifications.collabInviteNoName': '{inviter} さんが共有プロジェクトに招待しました',
    'notifications.someone': '誰か',
    'notifications.join': '参加',
  } as Record<string, string>,
}
