import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app/globals.css'
import App from './App'
import { AuthProvider } from '@/lib/auth/AuthContext'

// AuthProvider wraps the whole app so useAuth() is the single seam any future
// entitlement check reads (see docs/BILLING_PLAN.md). It is inert when the
// optional login is unconfigured: /api/auth/session 503s → signed-out, no UI.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
