/**
 * LoginView — First-run authentication screen for Crebral Pilot (Tauri v2).
 */

import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/tauri-bridge'

type AuthPhase =
  | 'idle'
  | 'waiting-for-github'
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [agentCount, setAgentCount] = useState(0)
  const [userName, setUserName] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== 'waiting-for-github') return

    const unsubscribe = api.auth.onTokenReceived((_event, data) => {
      const payload = data as { success: boolean; error?: string }
      if (payload.success) {
        handlePostAuth()
      } else {
        setPhase('error')
        setErrorMessage(payload.error || 'GitHub authorization failed')
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
        setErrorMessage(result.error?.message || 'Account sync failed')
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

  const handleLogin = async () => {
    setPhase('waiting-for-github')
    setErrorMessage(null)
    try {
      await api.auth.login()
    } catch {
      setPhase('error')
      setErrorMessage('Failed to open GitHub authorization page')
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
      <div className="titlebar-drag" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '44px' }} />

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
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, var(--crebral-teal-700) 0%, var(--crebral-teal-900) 100%)',
              border: '1px solid var(--crebral-teal-600)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 32px rgba(20, 184, 166, 0.15)',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="4" fill="var(--crebral-teal-400)" />
              <circle cx="14" cy="14" r="8" stroke="var(--crebral-teal-400)" strokeWidth="1" opacity="0.4" />
              <circle cx="14" cy="14" r="12" stroke="var(--crebral-teal-400)" strokeWidth="0.5" opacity="0.2" />
              <line x1="14" y1="2" x2="14" y2="6" stroke="var(--crebral-teal-400)" strokeWidth="1" opacity="0.5" />
              <line x1="14" y1="22" x2="14" y2="26" stroke="var(--crebral-teal-400)" strokeWidth="1" opacity="0.5" />
              <line x1="2" y1="14" x2="6" y2="14" stroke="var(--crebral-teal-400)" strokeWidth="1" opacity="0.5" />
              <line x1="22" y1="14" x2="26" y2="14" stroke="var(--crebral-teal-400)" strokeWidth="1" opacity="0.5" />
            </svg>
          </div>

          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontFamily: 'var(--crebral-font-heading)', fontSize: '1.5rem', fontWeight: 700, color: 'var(--crebral-text-primary)', letterSpacing: '-0.03em', margin: 0, lineHeight: 1.2 }}>
              Crebral Pilot
            </h1>
            <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.8rem', color: 'var(--crebral-text-tertiary)', margin: '8px 0 0 0', lineHeight: 1.5 }}>
              Connect your account to load your agents and start orchestration automatically.
            </p>
          </div>
        </div>

        {phase === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', width: '100%' }}>
            <button
              onClick={handleLogin}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '12px 24px',
                borderRadius: 'var(--crebral-radius-md)',
                background: 'var(--crebral-text-primary)',
                color: 'var(--crebral-bg-deep)',
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
              Connect with GitHub
            </button>

            <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '12px' }}>
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

        {(phase === 'waiting-for-github' || phase === 'syncing-account' || phase === 'loading-agents') && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <Spinner />
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontFamily: 'var(--crebral-font-body)', fontSize: '0.875rem', fontWeight: 500, color: phase === 'waiting-for-github' ? 'var(--crebral-text-secondary)' : 'var(--crebral-teal-400)', margin: 0 }}>
                {phase === 'waiting-for-github' ? 'Waiting for GitHub authorization...' : phase === 'syncing-account' ? 'Syncing account...' : `Loading ${agentCount} agent${agentCount !== 1 ? 's' : ''}...`}
              </p>
              {phase === 'waiting-for-github' && (
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

      <p style={{ position: 'absolute', bottom: '20px', fontFamily: 'var(--crebral-font-mono)', fontSize: '0.65rem', color: 'var(--crebral-text-muted)', opacity: 0.5, margin: 0 }}>
        Crebral Pilot v2.0
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
