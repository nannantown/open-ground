// Owned by the Canvas-elements translation track (Screen/Frame/Image/Comment/
// EditableText/InfiniteCanvas). Add keys as 'canvasEl.*'. English is source of truth.
export const canvasElements = {
  en: {
    // Screen/Mock iframe interactivity affordances
    'canvasEl.iframe.clickToInteract': 'Click to interact',
    'canvasEl.iframe.interactive': 'Interactive',
    // Screen/Mock tweak (inspect-and-instruct) flow
    'canvasEl.tweak.enter': 'Tweak',
    'canvasEl.tweak.title': 'Pick an element inside the design and tweak it with Claude',
    'canvasEl.tweak.placeholder': 'e.g. Make this button bigger',
    'canvasEl.tweak.send': 'Send',
    'canvasEl.tweak.close': 'Close',
    'canvasEl.tweak.applied': 'Applied. Click an element to tweak further.',
    'canvasEl.tweak.unchanged': 'No change was needed.',
    'canvasEl.tweak.pickHint': 'Click an element in the design',
    'canvasEl.tweak.error': 'Tweak failed. Try again.',
    'canvasEl.tweak.claudeMissing':
      'claude CLI not found — install Claude Code to use this.',
    // Signed-out (503 claudeLoggedOut): a sign-in CTA, not a generic error.
    'canvasEl.tweak.claudeLoggedOut':
      'Claude is installed but not signed in. Sign in once, then tweak again.',
    // ScreenView
    'canvasEl.screen.legacyTitle': 'Legacy Screen format',
    'canvasEl.screen.emptyTitle': 'Empty Screen',
    'canvasEl.screen.emptyHint':
      'Double-click to write source, or ask Claude in the Canvas chat to “build this screen”.',
    // FrameView
    'canvasEl.frame.tidy': 'Tidy',
    'canvasEl.frame.tidyTooltip': 'Tidy the cards inside this frame',
    // ImageView
    'canvasEl.image.notFound': 'Image not found',
    // Folder-less collab member: the image bytes live only on the owner's
    // device (the shared doc carries the reference, not the binary).
    'canvasEl.image.unavailable': 'Image not synced',
    // CommentPin
    'canvasEl.comment.placeholder': 'Comment on this element — ⌘↵ to Run',
    // InfiniteCanvas context menu
    'canvasEl.menu.duplicate': 'Duplicate',
    'canvasEl.menu.bringToFront': 'Bring to front',
    'canvasEl.menu.sendToBack': 'Send to back',
    'canvasEl.menu.group': 'Group',
    'canvasEl.menu.ungroup': 'Ungroup',
    // EditableText
  } as Record<string, string>,
  ja: {
    'canvasEl.iframe.clickToInteract': 'クリックで操作',
    'canvasEl.iframe.interactive': '操作モード',
    // Screen/Mock tweak (inspect-and-instruct) flow
    'canvasEl.tweak.enter': '調整',
    'canvasEl.tweak.title': 'デザイン内の要素を選んで Claude に調整を頼む',
    'canvasEl.tweak.placeholder': '例: このボタンをもっと大きく',
    'canvasEl.tweak.send': '送信',
    'canvasEl.tweak.unchanged': '変更は不要でした。',
    'canvasEl.tweak.pickHint': 'デザイン内の要素をクリック',
    'canvasEl.tweak.close': '閉じる',
    'canvasEl.tweak.applied': '適用しました。続けるには要素をクリック。',
    'canvasEl.tweak.error': '調整に失敗しました。もう一度お試しください。',
    'canvasEl.tweak.claudeMissing':
      'claude CLI が見つかりません — Claude Code をインストールしてください。',
    // Signed-out (503 claudeLoggedOut): a sign-in CTA, not a generic error.
    'canvasEl.tweak.claudeLoggedOut':
      'Claude はインストール済みですが未サインインです。一度サインインしてから、もう一度調整してください。',
    // ScreenView
    'canvasEl.screen.legacyTitle': '旧形式の Screen です',
    'canvasEl.screen.emptyTitle': '空の Screen',
    'canvasEl.screen.emptyHint':
      'ダブルクリックでソースを書くか、Canvas チャットで Claude に「この画面を作って」と頼んでください。',
    // FrameView
    'canvasEl.frame.tidy': '整理',
    'canvasEl.frame.tidyTooltip': 'フレーム内のカードを整理',
    // ImageView
    'canvasEl.image.notFound': '画像が見つかりません',
    'canvasEl.image.unavailable': '画像は同期されていません',
    // CommentPin
    'canvasEl.comment.placeholder': 'この要素についてのコメント — ⌘↵ で Run',
    // InfiniteCanvas context menu
    'canvasEl.menu.duplicate': '複製',
    'canvasEl.menu.bringToFront': '最前面へ',
    'canvasEl.menu.sendToBack': '最背面へ',
    'canvasEl.menu.group': 'グループ化',
    'canvasEl.menu.ungroup': 'グループ解除',
    // EditableText
  } as Record<string, string>,
}
