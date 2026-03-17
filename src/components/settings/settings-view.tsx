/**
 * SettingsView — Configuration panel for the Crebral desktop client.
 *
 * Sections:
 *   - Accounts: Login/logout, multi-account management
 *   - Synaptogenesis: Default interval + retry delay
 *   - About: App version + links
 *
 * Saves via api.settings.set() when IPC is wired (Phase 5D).
 */

// @ts-nocheck
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/tauri-bridge';
import {
  Settings,
  Timer,
  Info,
  Save,
  Loader2,
  CheckCircle,
  ExternalLink,
  User,
  LogOut,
  Github,
  Plus,
  Check,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store/app-store';

// UserInfo type (migrated from @crebral/shared)
interface UserInfo {
  id: string;
  githubUsername: string;
  displayName: string;
  avatarUrl: string | null;
  tier: string;
  agentLimit: number;
  qualificationStatus: string;
}

type AuthProvider = 'github' | 'google' | 'apple';
type AuthPhase = 'idle' | 'checking' | 'waiting-for-provider' | 'syncing' | 'error';

interface AuthState {
  isAuthenticated: boolean;
  user: UserInfo | null;
}

interface SettingsState {
  heartbeatIntervalMs: number;
  heartbeatRetryDelayMs: number;
}

const DEFAULT_SETTINGS: SettingsState = {
  heartbeatIntervalMs: 3_600_000,
  heartbeatRetryDelayMs: 30_000,
};

const HEARTBEAT_OPTIONS = [
  { label: '15 min', ms: 900_000 },
  { label: '30 min', ms: 1_800_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '2 hours', ms: 7_200_000 },
  { label: '6 hours', ms: 21_600_000 },
];

const RETRY_OPTIONS = [
  { label: '10 sec', ms: 10_000 },
  { label: '30 sec', ms: 30_000 },
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 300_000 },
];

export function SettingsView() {
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  // ── Account / Auth state ──────────────────────────────────────────
  const [auth, setAuth] = useState<AuthState>({ isAuthenticated: false, user: null });
  const [authPhase, setAuthPhase] = useState<AuthPhase>('checking');
  const [activeProvider, setActiveProvider] = useState<AuthProvider>('github');
  const [authError, setAuthError] = useState<string | null>(null);

  // Multi-account store
  const { accounts, activeAccountId, loadAccounts, switchAccount, removeAccount } = useAppStore();

  // Load accounts on mount
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  // Check auth status on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const status = await api.auth.status();
        setAuth(status as AuthState);
      } catch {
        // Auth not available — treat as disconnected
      } finally {
        setAuthPhase('idle');
      }
    };
    checkAuth();
  }, []);

  // Listen for token arrival when waiting for provider
  useEffect(() => {
    if (authPhase !== 'waiting-for-provider') return;

    const unsubscribe = api.auth.onTokenReceived((_event, data) => {
      const payload = data as { success: boolean; error?: string };
      if (payload.success) {
        handlePostConnect();
      } else {
        setAuthPhase('error');
        setAuthError(payload.error || 'Authorization failed');
      }
    });

    return unsubscribe;
  }, [authPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  const providerLabel = (p: AuthProvider) => p === 'github' ? 'GitHub' : p === 'google' ? 'Google' : 'Apple';

  const handleConnect = async (provider: AuthProvider = 'github') => {
    setActiveProvider(provider);
    setAuthPhase('waiting-for-provider');
    setAuthError(null);
    try {
      await api.auth.login(provider);
    } catch {
      setAuthPhase('error');
      setAuthError(`Failed to open ${providerLabel(provider)} authorization page`);
    }
  };

  const handlePostConnect = useCallback(async () => {
    try {
      setAuthPhase('syncing');
      const result = await api.auth.syncAndLoad(true);
      if (result && (result as { ok?: boolean }).ok === false) {
        setAuthPhase('error');
        setAuthError(
          ((result as { error?: { message?: string } }).error?.message) || 'Account sync failed',
        );
        return;
      }
      // Re-fetch status to get user info
      const status = await api.auth.status();
      setAuth(status as AuthState);
      setAuthPhase('idle');
      loadAccounts();
    } catch (err) {
      setAuthPhase('error');
      setAuthError(err instanceof Error ? err.message : 'Unexpected error during sync');
    }
  }, [loadAccounts]);

  const handleDisconnect = async () => {
    try {
      if (activeAccountId) {
        await removeAccount(activeAccountId);
      } else {
        await api.auth.logout();
      }
      setAuth({ isAuthenticated: false, user: null });
      setAuthPhase('idle');
      setAuthError(null);
      loadAccounts();
    } catch (err) {
      console.error('Disconnect failed:', err);
    }
  };

  // Load settings from IPC if available
  useEffect(() => {
    const load = async () => {
      try {
        if (api.settings?.get) {
          const data = await api.settings.get();
          if (data) {
            setSettings((prev) => ({
              ...prev,
              heartbeatIntervalMs: data.heartbeatIntervalMs ?? prev.heartbeatIntervalMs,
              heartbeatRetryDelayMs: data.heartbeatRetryDelayMs ?? prev.heartbeatRetryDelayMs,
            }));
          }
        }
      } catch (err) {
        console.warn('Settings load not available yet:', err);
      }
    };
    load();
  }, []);

  const updateField = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  };

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      if (api.settings?.set) {
        await api.settings.set(settings as AppSettings);
      }
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  // Shared style helpers
  const cardStyle: React.CSSProperties = {
    background: 'var(--crebral-bg-card)',
    border: '1px solid var(--crebral-border-card)',
    borderRadius: 'var(--crebral-radius-lg)',
  };

  const sectionHeadingStyle: React.CSSProperties = {
    fontFamily: 'var(--crebral-font-heading)',
    color: 'var(--crebral-text-primary)',
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Settings size={22} style={{ color: 'var(--crebral-text-tertiary)' }} />
            <h1
              className="text-2xl font-bold"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-primary)',
                letterSpacing: '-0.02em',
              }}
            >
              Settings
            </h1>
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={isSaving || !dirty}
            className="flex items-center gap-2 px-5 py-2 text-sm rounded-full transition-all"
            style={{
              background: dirty ? 'var(--crebral-teal-600)' : 'var(--crebral-bg-elevated)',
              color: dirty ? 'var(--crebral-text-primary)' : 'var(--crebral-text-muted)',
              border: 'none',
              fontFamily: 'var(--crebral-font-body)',
              fontWeight: 600,
              cursor: dirty ? 'pointer' : 'default',
              opacity: dirty ? 1 : 0.5,
            }}
          >
            {isSaving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saved ? (
              <CheckCircle size={14} />
            ) : (
              <Save size={14} />
            )}
            {saved ? 'Saved' : 'Save Changes'}
          </button>
        </div>

        {/* ============================================ */}
        {/* Section 0: Accounts                          */}
        {/* ============================================ */}
        <div className="p-6" style={cardStyle}>
          <div className="flex items-center gap-2 mb-5">
            <User size={18} style={{ color: 'var(--crebral-teal-500)' }} />
            <h2 className="text-lg font-semibold" style={sectionHeadingStyle}>
              Accounts
            </h2>
          </div>

          {authPhase === 'checking' && (
            <div className="flex items-center gap-3">
              <Loader2 size={16} className="animate-spin" style={{ color: 'var(--crebral-text-muted)' }} />
              <span className="text-sm" style={{ color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}>
                Checking account status...
              </span>
            </div>
          )}

          {authPhase !== 'checking' && accounts.length > 0 && (
            <div className="space-y-2">
              {accounts.map((account) => {
                const isActive = account.userId === activeAccountId;
                return (
                  <div
                    key={account.userId}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg transition-all group"
                    style={{
                      background: isActive ? 'rgba(58, 175, 185, 0.06)' : 'transparent',
                      border: isActive ? '1px solid rgba(58, 175, 185, 0.15)' : '1px solid transparent',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      {account.avatarUrl ? (
                        <img
                          src={account.avatarUrl}
                          alt={account.username}
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '50%',
                            border: isActive ? '2px solid var(--crebral-teal-600)' : '2px solid var(--crebral-border-subtle)',
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '50%',
                            background: 'var(--crebral-bg-elevated)',
                            border: '1px solid var(--crebral-border-subtle)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Github size={16} style={{ color: 'var(--crebral-text-muted)' }} />
                        </div>
                      )}
                      <div>
                        <p
                          className="text-sm font-medium"
                          style={{
                            color: 'var(--crebral-text-primary)',
                            fontFamily: 'var(--crebral-font-body)',
                            margin: 0,
                            lineHeight: 1.3,
                          }}
                        >
                          @{account.username}
                        </p>
                      </div>
                      {isActive && (
                        <span
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                          style={{
                            background: 'rgba(58, 175, 185, 0.15)',
                            color: 'var(--crebral-teal-400)',
                            fontFamily: 'var(--crebral-font-body)',
                          }}
                        >
                          Active
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      {!isActive && (
                        <button
                          onClick={() => switchAccount(account.userId)}
                          className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2.5 py-1 text-xs rounded-full transition-all"
                          style={{
                            background: 'var(--crebral-bg-elevated)',
                            border: '1px solid var(--crebral-border-subtle)',
                            color: 'var(--crebral-text-secondary)',
                            fontFamily: 'var(--crebral-font-body)',
                            fontWeight: 500,
                            cursor: 'pointer',
                          }}
                        >
                          <Check size={10} />
                          Switch
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (isActive) {
                            handleDisconnect();
                          } else {
                            removeAccount(account.userId);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 flex items-center justify-center p-1 rounded-full transition-all"
                        style={{
                          background: 'transparent',
                          border: '1px solid transparent',
                          color: 'var(--crebral-text-muted)',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.color = 'var(--crebral-red-bright)';
                          (e.currentTarget as HTMLElement).style.borderColor = 'rgba(239, 68, 68, 0.2)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-muted)';
                          (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
                        }}
                        title={isActive ? 'Disconnect' : 'Remove account'}
                      >
                        {isActive ? <LogOut size={12} /> : <X size={12} />}
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Add Account */}
              {authPhase === 'waiting-for-provider' || authPhase === 'syncing' ? (
                <div className="flex items-center gap-3 px-3 py-2.5 mt-3 rounded-lg" style={{ border: '1px dashed var(--crebral-border-subtle)' }}>
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--crebral-teal-500)' }} />
                  <span className="text-sm" style={{ color: 'var(--crebral-text-tertiary)', fontFamily: 'var(--crebral-font-body)' }}>
                    {authPhase === 'waiting-for-provider'
                      ? `Waiting for ${providerLabel(activeProvider)}...`
                      : 'Syncing account...'}
                  </span>
                </div>
              ) : (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => handleConnect('github')}
                    className="flex items-center justify-center gap-1.5 flex-1 px-3 py-2 text-xs rounded-lg transition-all"
                    style={{
                      background: '#24292F',
                      color: '#FFFFFF',
                      border: 'none',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                    title="Add GitHub account"
                  >
                    <Plus size={12} />
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    GitHub
                  </button>
                  <button
                    onClick={() => handleConnect('google')}
                    className="flex items-center justify-center gap-1.5 flex-1 px-3 py-2 text-xs rounded-lg transition-all"
                    style={{
                      background: '#FFFFFF',
                      color: '#1F1F1F',
                      border: '1px solid #DADCE0',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                    title="Add Google account"
                  >
                    <Plus size={12} />
                    <svg width="14" height="14" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    </svg>
                    Google
                  </button>
                  <button
                    onClick={() => handleConnect('apple')}
                    className="flex items-center justify-center gap-1.5 flex-1 px-3 py-2 text-xs rounded-lg transition-all"
                    style={{
                      background: '#000000',
                      color: '#FFFFFF',
                      border: 'none',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                    title="Add Apple account"
                  >
                    <Plus size={12} />
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                    </svg>
                    Apple
                  </button>
                </div>
              )}
            </div>
          )}

          {authPhase !== 'checking' && accounts.length === 0 && !auth.isAuthenticated && (
            <div className="space-y-3">
              <p
                className="text-sm"
                style={{
                  color: 'var(--crebral-text-tertiary)',
                  fontFamily: 'var(--crebral-font-body)',
                  margin: '0 0 12px 0',
                  lineHeight: 1.5,
                }}
              >
                Connect an account to sync agents and get a device token.
              </p>

              {authPhase === 'waiting-for-provider' || authPhase === 'syncing' ? (
                <div className="flex flex-col items-center gap-3 py-2">
                  <Loader2 size={18} className="animate-spin" style={{ color: 'var(--crebral-teal-500)' }} />
                  <p className="text-sm" style={{ color: 'var(--crebral-text-secondary)', fontFamily: 'var(--crebral-font-body)', margin: 0 }}>
                    {authPhase === 'waiting-for-provider'
                      ? `Waiting for ${providerLabel(activeProvider)}...`
                      : 'Syncing account...'}
                  </p>
                  {authPhase === 'waiting-for-provider' && (
                    <p className="text-xs" style={{ color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)', margin: 0 }}>
                      Complete sign-in in your browser, then return here.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {/* GitHub */}
                  <button
                    onClick={() => handleConnect('github')}
                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm rounded-lg transition-all"
                    style={{
                      background: '#24292F',
                      color: '#FFFFFF',
                      border: 'none',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    Continue with GitHub
                  </button>

                  {/* Google */}
                  <button
                    onClick={() => handleConnect('google')}
                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm rounded-lg transition-all"
                    style={{
                      background: '#FFFFFF',
                      color: '#1F1F1F',
                      border: '1px solid #DADCE0',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    </svg>
                    Continue with Google
                  </button>

                  {/* Apple */}
                  <button
                    onClick={() => handleConnect('apple')}
                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm rounded-lg transition-all"
                    style={{
                      background: '#000000',
                      color: '#FFFFFF',
                      border: 'none',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.9' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                    </svg>
                    Continue with Apple
                  </button>
                </div>
              )}
            </div>
          )}

          {authPhase === 'error' && authError && (
            <div
              className="mt-3"
              style={{
                padding: '10px 14px',
                borderRadius: 'var(--crebral-radius-md)',
                background: 'var(--crebral-red-soft)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
              }}
            >
              <p
                className="text-xs"
                style={{
                  color: 'var(--crebral-red-bright)',
                  fontFamily: 'var(--crebral-font-body)',
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                {authError}
              </p>
            </div>
          )}
        </div>

        {/* ============================================ */}
        {/* Section 1: Synaptogenesis                     */}
        {/* ============================================ */}
        <div className="p-6" style={cardStyle}>
          <div className="flex items-center gap-2 mb-5">
            <Timer size={18} style={{ color: 'var(--crebral-teal-500)' }} />
            <h2 className="text-lg font-semibold" style={sectionHeadingStyle}>
              Synaptogenesis
            </h2>
          </div>

          <div className="space-y-5">
            {/* Default interval */}
            <div>
              <label style={{
                color: 'var(--crebral-text-secondary)',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.75rem',
                display: 'block',
                marginBottom: '6px',
              }}>Default Interval</label>
              <div className="flex flex-wrap gap-2">
                {HEARTBEAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.ms}
                    onClick={() => updateField('heartbeatIntervalMs', opt.ms)}
                    className="px-3 py-1.5 text-xs rounded-full transition-all"
                    style={{
                      background:
                        settings.heartbeatIntervalMs === opt.ms
                          ? 'var(--crebral-teal-900)'
                          : 'var(--crebral-bg-elevated)',
                      border:
                        settings.heartbeatIntervalMs === opt.ms
                          ? '1px solid var(--crebral-teal-700)'
                          : '1px solid var(--crebral-border-subtle)',
                      color:
                        settings.heartbeatIntervalMs === opt.ms
                          ? 'var(--crebral-teal-400)'
                          : 'var(--crebral-text-secondary)',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Retry delay */}
            <div>
              <label style={{
                color: 'var(--crebral-text-secondary)',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.75rem',
                display: 'block',
                marginBottom: '6px',
              }}>Retry Delay</label>
              <div className="flex flex-wrap gap-2">
                {RETRY_OPTIONS.map((opt) => (
                  <button
                    key={opt.ms}
                    onClick={() => updateField('heartbeatRetryDelayMs', opt.ms)}
                    className="px-3 py-1.5 text-xs rounded-full transition-all"
                    style={{
                      background:
                        settings.heartbeatRetryDelayMs === opt.ms
                          ? 'var(--crebral-teal-900)'
                          : 'var(--crebral-bg-elevated)',
                      border:
                        settings.heartbeatRetryDelayMs === opt.ms
                          ? '1px solid var(--crebral-teal-700)'
                          : '1px solid var(--crebral-border-subtle)',
                      color:
                        settings.heartbeatRetryDelayMs === opt.ms
                          ? 'var(--crebral-teal-400)'
                          : 'var(--crebral-text-secondary)',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ============================================ */}
        {/* Section 2: About                             */}
        {/* ============================================ */}
        <div className="p-6" style={cardStyle}>
          <div className="flex items-center gap-2 mb-5">
            <Info size={18} style={{ color: 'var(--crebral-teal-500)' }} />
            <h2 className="text-lg font-semibold" style={sectionHeadingStyle}>
              About
            </h2>
          </div>

          <div className="space-y-3">
            {[
              { label: 'App Version', value: api.appVersion },
              { label: 'Platform', value: 'Tauri v2' },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between">
                <span
                  className="text-sm"
                  style={{
                    color: 'var(--crebral-text-secondary)',
                    fontFamily: 'var(--crebral-font-body)',
                  }}
                >
                  {label}
                </span>
                <span
                  className="text-sm"
                  style={{
                    color: 'var(--crebral-text-tertiary)',
                    fontFamily: 'var(--crebral-font-mono)',
                  }}
                >
                  {value}
                </span>
              </div>
            ))}

            {/* Links */}
            <div
              className="pt-3 mt-3 flex items-center gap-4"
              style={{ borderTop: '1px solid var(--crebral-border-subtle)' }}
            >
              {[
                { label: 'Website', url: 'https://www.crebral.ai' },
                { label: 'Documentation', url: 'https://www.crebral.ai/docs/quickstart' },
              ].map(({ label, url }) => (
                <a
                  key={label}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs transition-all hover:opacity-80"
                  style={{
                    color: 'var(--crebral-teal-400)',
                    fontFamily: 'var(--crebral-font-body)',
                    textDecoration: 'none',
                  }}
                >
                  {label}
                  <ExternalLink size={10} />
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* Footer spacer */}
        <div className="h-4" />
      </div>
    </div>
  );
}
