import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app/globals.css'
import App from './App'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { I18nProvider } from '@/i18n/I18nContext'
import { RealtimeProvider } from '@/lib/collab/RealtimeContext'

// AuthProvider wraps the whole app so useAuth() is the single seam any future
// entitlement check reads (see docs/BILLING_PLAN.md). It is inert when the
// optional login is unconfigured: /api/auth/session 503s → signed-out, no UI.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <RealtimeProvider>
          <App />
        </RealtimeProvider>
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
)
