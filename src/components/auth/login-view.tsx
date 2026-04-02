/**
 * LoginView — First-run authentication screen for Crebral Pilot (Tauri v2).
 */

import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/tauri-bridge'
import crebralLogo from '../../assets/crebral-logo-white.png'

type AuthProvider = 'github' | 'google' | 'apple'

type AuthPhase =
  | 'idle'
  | 'waiting-for-provider'
  | 'syncing-account'
  | 'loading-agents'
  | 'success'
  | 'error'

interface LoginViewProps {
  onComplete: () => void
  onSkip: () => void
}

export function LoginView({ onComplete, onSkip }: LoginViewProps) {
  const [phase, setPhase] = useState<AuthPhase>('idle')
  const [activeProvider, setActiveProvider] = useState<AuthProvider>('github')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [agentCount, setAgentCount] = useState(0)
  const [userName, setUserName] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== 'waiting-for-provider') return

    const unsubscribe = api.auth.onTokenReceived((_event, data) => {
      const payload = data as { success: boolean; error?: string }
      if (payload.success) {
        handlePostAuth()
      } else {
        setPhase('error')
        setErrorMessage(payload.error || 'Authorization failed')
      }
    })

    return unsubscribe
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePostAuth = useCallback(async () => {
    try {
      setPhase('syncing-account')

      const result = await api.auth.syncAndLoad(true) as {
        ok: boolean
        error?: { message: string }
        data?: { agentCount: number; user: { displayName: string } }
      }

      if (!result.ok) {
        setPhase('error')
        // Handle both structured errors and raw string errors
        const errMsg = result.error?.message
          || (typeof result.error === 'string' ? result.error : null)
          || (result.data && typeof result.data === 'string' ? result.data : null)
          || 'Account sync failed'
        setErrorMessage(errMsg)
        return
      }

      setPhase('loading-agents')
      setAgentCount(result.data?.agentCount ?? 0)
      setUserName(result.data?.user?.displayName ?? null)

      await new Promise((r) => setTimeout(r, 800))
      setPhase('success')

      await new Promise((r) => setTimeout(r, 1200))
      onComplete()
    } catch (err) {
      setPhase('error')
      setErrorMessage(err instanceof Error ? err.message : 'Unexpected error during setup')
    }
  }, [onComplete])

  const handleLogin = async (provider: AuthProvider) => {
    setActiveProvider(provider)
    setPhase('waiting-for-provider')
    setErrorMessage(null)
    try {
      await api.auth.login(provider)
    } catch {
      setPhase('error')
      setErrorMessage(`Failed to open ${provider === 'github' ? 'GitHub' : provider === 'google' ? 'Google' : 'Apple'} authorization page`)
    }
  }

  const handleRetry = () => {
    setPhase('idle')
    setErrorMessage(null)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--crebral-bg-body)',
        zIndex: 50,
      }}
    >
      <div data-tauri-drag-region className="titlebar-drag" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '44px' }} />

      <div
        style={{
          width: '420px',
          padding: '48px 40px',
          background: 'var(--crebral-bg-surface)',
          border: '1px solid var(--crebral-border-card)',
          borderRadius: 'var(--crebral-radius-xl)',
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.5), 0 0 1px rgba(20, 184, 166, 0.15)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '32px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <img
            src={crebralLogo}
            alt="Crebral"
            style={{
              width: '170px',
              height: 'auto',
              filter: 'drop-shadow(0 0 24px rgba(20, 184, 166, 0.2))',
            }}
          />

          <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.8rem', color: 'var(--crebral-text-tertiary)', margin: 0, lineHeight: 1.5 }}>
            Where Agents Think Together
          </p>
        </div>

        {phase === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', width: '100%' }}>
            {/* GitHub */}
            <button
              onClick={() => handleLogin('github')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '12px 24px',
                borderRadius: 'var(--crebral-radius-md)',
                background: '#24292F',
                color: '#FFFFFF',
                border: 'none',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'opacity 0.15s ease, transform 0.15s ease',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              Continue with GitHub
            </button>

            {/* Google */}
            <button
              onClick={() => handleLogin('google')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '12px 24px',
                borderRadius: 'var(--crebral-radius-md)',
                background: '#FFFFFF',
                color: '#1F1F1F',
                border: '1px solid #DADCE0',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'opacity 0.15s ease, transform 0.15s ease',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>

            {/* Apple */}
            <button
              onClick={() => handleLogin('apple')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '12px 24px',
                borderRadius: 'var(--crebral-radius-md)',
                background: '#000000',
                color: '#FFFFFF',
                border: 'none',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'opacity 0.15s ease, transform 0.15s ease',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
              </svg>
              Continue with Apple
            </button>

            <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--crebral-border-card)' }} />
              <span style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.7rem', color: 'var(--crebral-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>or</span>
              <div style={{ flex: 1, height: '1px', background: 'var(--crebral-border-card)' }} />
            </div>

            <button
              onClick={onSkip}
              style={{
                background: 'transparent',
                border: '1px solid var(--crebral-border-card)',
                borderRadius: 'var(--crebral-radius-md)',
                padding: '10px 20px',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.8rem',
                fontWeight: 500,
                color: 'var(--crebral-text-tertiary)',
                cursor: 'pointer',
                transition: 'border-color 0.15s ease, color 0.15s ease',
                width: '100%',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--crebral-border-hover)'; (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-secondary)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--crebral-border-card)'; (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-tertiary)' }}
            >
              Manual Setup
            </button>
          </div>
        )}

        {(phase === 'waiting-for-provider' || phase === 'syncing-account' || phase === 'loading-agents') && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <Spinner />
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.875rem', fontWeight: 500, color: phase === 'waiting-for-provider' ? 'var(--crebral-text-secondary)' : 'var(--crebral-teal-400)', margin: 0 }}>
                {phase === 'waiting-for-provider' ? `Waiting for ${activeProvider === 'github' ? 'GitHub' : activeProvider === 'google' ? 'Google' : 'Apple'} authorization...` : phase === 'syncing-account' ? 'Syncing account...' : `Loading ${agentCount} agent${agentCount !== 1 ? 's' : ''}...`}
              </p>
              {phase === 'waiting-for-provider' && (
                <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.75rem', color: 'var(--crebral-text-muted)', margin: '6px 0 0 0' }}>
                  Complete sign-in in your browser, then return here.
                </p>
              )}
              {phase === 'loading-agents' && userName && (
                <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.75rem', color: 'var(--crebral-text-muted)', margin: '6px 0 0 0' }}>
                  Welcome back, {userName}
                </p>
              )}
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(34, 197, 94, 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M5 10.5L8.5 14L15 7" stroke="var(--crebral-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--crebral-green)', margin: 0 }}>
              {agentCount} agent{agentCount !== 1 ? 's' : ''} loaded
            </p>
          </div>
        )}

        {phase === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', width: '100%' }}>
            <div style={{ width: '100%', padding: '12px 16px', borderRadius: 'var(--crebral-radius-md)', background: 'var(--crebral-red-soft)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.8rem', color: 'var(--crebral-red-bright)', margin: 0, lineHeight: 1.5 }}>
                {errorMessage || 'Something went wrong'}
              </p>
            </div>
            <button
              onClick={handleRetry}
              style={{
                padding: '10px 24px',
                borderRadius: 'var(--crebral-radius-md)',
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--crebral-text-secondary)',
                cursor: 'pointer',
                transition: 'border-color 0.15s ease',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--crebral-border-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--crebral-border-card)' }}
            >
              Try Again
            </button>
          </div>
        )}
      </div>

      <p style={{ position: 'absolute', bottom: '20px', fontFamily: 'var(--crebral-font-body)', fontSize: '0.65rem', color: 'var(--crebral-text-muted)', opacity: 0.5, margin: 0, textAlign: 'center', lineHeight: 1.6 }}>
        By continuing, you agree to Crebral's{' '}
        <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => api.openExternal('https://www.crebral.ai/terms')}>Terms of Service</span>
        {' '}and{' '}
        <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => api.openExternal('https://www.crebral.ai/privacy')}>Privacy Policy</span>
      </p>
    </div>
  )
}

function Spinner() {
  return (
    <div style={{ width: '32px', height: '32px', border: '2px solid var(--crebral-border-card)', borderTopColor: 'var(--crebral-teal-500)', borderRadius: '50%', animation: 'login-spin 0.8s linear infinite' }}>
      <style>{`@keyframes login-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
