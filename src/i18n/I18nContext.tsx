import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { messages, type Lang, type MessageKey } from './messages'

// OPEN GROUND is English-first: the app defaults to English and only starts in
// Japanese when the browser locale is Japanese or the user explicitly switched.
// The persisted key ('og-lang') is shared with landing/index.html so the two
// surfaces agree on the visitor's language choice.
const STORAGE_KEY = 'og-lang'

function detectLang(): Lang {
  const nav =
    (typeof navigator !== 'undefined' &&
      (navigator.language || (navigator.languages && navigator.languages[0]))) ||
    'en'
  return nav.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

function initialLang(): Lang {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'ja') return saved
  }
  return detectLang()
}

interface I18nValue {
  lang: Lang
  setLang: (l: Lang) => void
  toggleLang: () => void
  /** Translate a key, with optional `{name}`-style interpolation. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)

  useEffect(() => {
    document.documentElement.lang = lang
    // Mirror the choice into server settings so run prompts (and Claude's
    // replies) follow the same language. Fire-and-forget; merges server-side.
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang }),
    }).catch(() => {
      /* offline / server not up yet — UI language still works locally */
    })
  }, [lang])

  const setLang = (l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      /* storage unavailable (private mode) — language still works in-session */
    }
  }

  const toggleLang = () => setLang(lang === 'ja' ? 'en' : 'ja')

  const t: I18nValue['t'] = (key, vars) => {
    let s = messages[lang][key] ?? messages.en[key] ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
    }
    return s
  }

  return <I18nContext.Provider value={{ lang, setLang, toggleLang, t }}>{children}</I18nContext.Provider>
}

export function useT(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT must be used within <I18nProvider>')
  return ctx
}
