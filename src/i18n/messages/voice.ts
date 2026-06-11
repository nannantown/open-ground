// Owned by the voice dictation feature: the VoiceController status pill and
// its error guidance. Settings-drawer strings live in settings.ts.
export const voice = {
  en: {
    'voice.recording': 'Recording',
    'voice.transcribing': 'Transcribing…',
    'voice.hint.release': 'release to insert',
    'voice.hint.toggle': '{combo} to stop',
    'voice.hint.esc': 'Esc to cancel',
    'voice.noSpeech': 'No speech detected.',
    'voice.copied': 'No text field focused — transcript copied to clipboard.',
    'voice.error.micDenied': 'Microphone access was denied.',
    'voice.error.binaryMissing':
      'whisper-cli not found. Install it, then check Settings → Voice dictation.',
    'voice.error.modelMissing':
      'Voice model not downloaded yet — see Settings → Voice dictation.',
    'voice.error.failed': 'Transcription failed.',
  } as Record<string, string>,
  ja: {
    'voice.recording': '録音中',
    'voice.transcribing': '文字起こし中…',
    'voice.hint.release': 'キーを離すと挿入',
    'voice.hint.toggle': '{combo} で停止',
    'voice.hint.esc': 'Esc でキャンセル',
    'voice.noSpeech': '音声を検出できませんでした。',
    'voice.copied': '入力先が無いため、クリップボードにコピーしました。',
    'voice.error.micDenied': 'マイクへのアクセスが拒否されました。',
    'voice.error.binaryMissing':
      'whisper-cli が見つかりません。インストール後、設定 → 音声入力 を確認してください。',
    'voice.error.modelMissing':
      '音声モデルが未ダウンロードです。設定 → 音声入力 を確認してください。',
    'voice.error.failed': '文字起こしに失敗しました。',
  } as Record<string, string>,
}
