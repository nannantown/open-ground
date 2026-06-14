// Owned by the Modals translation track (Account / Feedback / NewProject).
// Add keys as 'modals.*'. English is the source of truth.
export const modals = {
  en: {
    // AccountModal
    'modals.account.label': 'Account',
    'modals.account.titleSignedIn': 'Account',
    'modals.account.titleSignedOut': 'Sign in',
    'modals.account.signedInWith': 'Signed in with {provider}',
    'modals.account.signOut': 'Sign out',
    'modals.account.intro':
      'Signing in is optional. OPEN GROUND works fully without an account. Sign in to carry your settings across machines.',
    'modals.account.continueWithGoogle': 'Continue with Google',
    'modals.account.continueWithGitHub': 'Continue with GitHub',
    'modals.account.completeInBrowser':
      'Complete sign-in in your browser. When you return to this screen, it will update automatically.',
    'modals.account.browserWillOpen':
      'A browser window will open for sign-in. Return to this screen once you are done.',

    // FeedbackModal
    'modals.feedback.label': 'Feedback',
    'modals.feedback.title': 'Send feedback',
    'modals.feedback.sendFailed': 'Could not send feedback',
    'modals.feedback.thanks': 'Thank you. Your feedback has been sent.',
    'modals.feedback.messageLabel': 'Message',
    'modals.feedback.messagePlaceholder':
      'What worked well, what is not working, what you wish it did, and so on…',
    'modals.feedback.emailLabel': 'Email',
    'modals.feedback.emailOptional': '(optional — only if you need a reply)',
    'modals.feedback.about': 'About: {label}',
    'modals.feedback.aboutTab': 'Feedback about this tab',
    'modals.feedback.attachLabel': 'Images',
    'modals.feedback.attachOptional': '(optional)',
    'modals.feedback.attachAdd': 'Add images',
    'modals.feedback.attachHint': 'Paste or drag images here',
    'modals.feedback.attachDrop': 'Drop to attach',
    'modals.feedback.attachRemove': 'Remove image',
    'modals.feedback.attachBusy': 'Processing images…',
    'modals.feedback.attachTooMany': 'Up to {max} images',
    'modals.feedback.attachFailed': 'Some images could not be added',
    'modals.feedback.attachTooLarge':
      'Images are too large — remove one and try again',

    // NewProjectModal
    'modals.newProject.label': 'Create',
    'modals.newProject.title': 'New project',
    'modals.newProject.pickerFailed': 'Could not open the folder picker',
    'modals.newProject.createFailed': 'Failed to create project',
    'modals.newProject.folderNameLabel': 'Folder name',
    'modals.newProject.chooseLocation': 'Choose where the folder is created',
    'modals.newProject.change': 'Change',
    'modals.newProject.chooseLocationBtn': 'Choose location',
    'modals.newProject.descriptionLabel': 'Description',
    'modals.newProject.descriptionOptional': '(optional)',
    'modals.newProject.descriptionPlaceholder':
      'A short note is fine (you can edit it later)',
    'modals.newProject.create': 'Create',
  } as Record<string, string>,
  ja: {
    // AccountModal
    'modals.account.label': 'アカウント',
    'modals.account.titleSignedIn': 'アカウント',
    'modals.account.titleSignedOut': 'サインイン',
    'modals.account.signedInWith': '{provider} でサインイン中',
    'modals.account.signOut': 'サインアウト',
    'modals.account.intro':
      'サインインは任意です。OPEN GROUND はアカウントなしでも全機能を使えます。サインインすると、設定を複数のマシン間で引き継げます。',
    'modals.account.continueWithGoogle': 'Google で続ける',
    'modals.account.continueWithGitHub': 'GitHub で続ける',
    'modals.account.completeInBrowser':
      'ブラウザでサインインを完了してください。完了後、この画面に戻ると自動的に反映されます。',
    'modals.account.browserWillOpen':
      'サインイン用のブラウザウィンドウが開きます。完了したらこの画面に戻ってください。',

    // FeedbackModal
    'modals.feedback.label': 'フィードバック',
    'modals.feedback.title': 'フィードバックを送る',
    'modals.feedback.sendFailed': 'フィードバックを送信できませんでした',
    'modals.feedback.thanks': 'ありがとうございます。フィードバックを送信しました。',
    'modals.feedback.messageLabel': 'メッセージ',
    'modals.feedback.messagePlaceholder':
      '良かった点・うまく動かない点・こうだったらいいのに、など…',
    'modals.feedback.emailLabel': 'メール',
    'modals.feedback.emailOptional': '（任意 — 返信が必要な場合のみ）',
    'modals.feedback.about': '対象: {label}',
    'modals.feedback.aboutTab': 'このタブについてのフィードバック',
    'modals.feedback.attachLabel': '画像',
    'modals.feedback.attachOptional': '（任意）',
    'modals.feedback.attachAdd': '画像を追加',
    'modals.feedback.attachHint': 'ここに画像を貼り付け / ドラッグ',
    'modals.feedback.attachDrop': 'ドロップして添付',
    'modals.feedback.attachRemove': '画像を削除',
    'modals.feedback.attachBusy': '画像を処理中…',
    'modals.feedback.attachTooMany': '画像は最大 {max} 枚です',
    'modals.feedback.attachFailed': '一部の画像を追加できませんでした',
    'modals.feedback.attachTooLarge':
      '画像の合計サイズが大きすぎます — 1枚減らして再試行してください',

    // NewProjectModal
    'modals.newProject.label': '作成',
    'modals.newProject.title': '新規プロジェクト',
    'modals.newProject.pickerFailed': 'フォルダ選択を開けませんでした',
    'modals.newProject.createFailed': 'プロジェクトを作成できませんでした',
    'modals.newProject.folderNameLabel': 'フォルダ名',
    'modals.newProject.chooseLocation': 'フォルダの作成先を選択してください',
    'modals.newProject.change': '変更',
    'modals.newProject.chooseLocationBtn': '場所を選択',
    'modals.newProject.descriptionLabel': '説明',
    'modals.newProject.descriptionOptional': '（任意）',
    'modals.newProject.descriptionPlaceholder': 'ひとことでOK（あとから直せます）',
    'modals.newProject.create': '作成',
  } as Record<string, string>,
}
