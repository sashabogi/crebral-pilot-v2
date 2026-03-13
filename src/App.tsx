/**
 * App — Root layout for the Crebral desktop client (Tauri v2).
 * Left sidebar (80px icon-only) + title bar + main content area.
 * View navigation via useState; agent state via Zustand store.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { TitleBar } from './components/layout/title-bar'
import { Sidebar, type ViewId } from './components/layout/sidebar'
import { ThoughtTray } from './components/layout/thought-tray'
import { DashboardView } from './components/dashboard/dashboard-view'
import { AgentsView } from './components/agents/agents-view'
import { ActivityView } from './components/activity/activity-view'
import { SettingsView } from './components/settings/settings-view'
import { BrainView } from './components/brain/brain-view'
import { ModerationView } from './components/moderation/moderation-view'
import { NeuralField } from './components/ui/neural-field'
import { LoginView } from './components/auth/login-view'
import { useAppStore } from './store/app-store'
import { api } from './lib/tauri-bridge'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const VIEW_LABELS: Record<ViewId, string> = {
  dashboard: 'Dashboard',
  agents: 'Agents',
  activity: 'Activity',
  moderation: 'Moderation',
  brain: 'Brain',
  settings: 'Settings',
}

export default function App() {
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const validateConnection = useAppStore((s) => s.validateConnection)
  const currentView = useAppStore((s) => s.currentView)
  const setViewStore = useAppStore((s) => s.setView)

  // Auth gate state: null = checking, true = show login, false = show app
  const [showLogin, setShowLogin] = useState<boolean | null>(null)

  // Auto-updater state
  const [updateAvailable, setUpdateAvailable] = useState<Update | null>(null)
  const [updateInstalling, setUpdateInstalling] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const updateChecked = useRef(false)

  const VALID_VIEWS: ViewId[] = ['dashboard', 'agents', 'activity', 'moderation', 'brain', 'settings']
  const activeView: ViewId = VALID_VIEWS.includes(currentView as ViewId)
    ? (currentView as ViewId)
    : 'dashboard'

  const setActiveView = (view: ViewId) => setViewStore(view)

  useEffect(() => {
    const init = async () => {
      await loadSettings()
      await loadAgents()

      // Background: sync avatar URLs from server (non-blocking)
      const allAgents = useAppStore.getState().agents
      if (allAgents.length > 0) {
        Promise.all(
          allAgents.map(a => api.agents.dashboard(a.agentId).catch(() => null))
        ).then(() => loadAgents())
      }

      const agentList = useAppStore.getState().agents
      if (agentList.length > 0) {
        setShowLogin(false)
        await validateConnection()
      } else {
        try {
          const authStatus = await api.auth.status()
          if ((authStatus as { isAuthenticated?: boolean }).isAuthenticated) {
            setShowLogin(false)
          } else {
            setShowLogin(true)
          }
        } catch {
          setShowLogin(true)
        }
      }
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Check for app updates on startup (once)
  useEffect(() => {
    if (updateChecked.current) return
    updateChecked.current = true

    check()
      .then((update) => {
        if (update?.available) {
          setUpdateAvailable(update)
        }
      })
      .catch((err) => {
        console.warn('[updater] Failed to check for updates:', err)
      })
  }, [])

  const handleInstallUpdate = useCallback(async () => {
    if (!updateAvailable) return
    setUpdateInstalling(true)
    try {
      await updateAvailable.downloadAndInstall()
      await relaunch()
    } catch (err) {
      console.error('[updater] Failed to install update:', err)
      setUpdateInstalling(false)
    }
  }, [updateAvailable])

  const handleLoginComplete = useCallback(async () => {
    await loadAgents()
    await validateConnection()
    setShowLogin(false)
  }, [loadAgents, validateConnection])

  const handleLoginSkip = useCallback(() => {
    setShowLogin(false)
  }, [])

  const renderContent = () => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardView />
      case 'agents':
        return <AgentsView />
      case 'activity':
        return <ActivityView />
      case 'moderation':
        return <ModerationView />
      case 'brain':
        return <BrainView />
      case 'settings':
        return <SettingsView />
      default:
        return <DashboardView />
    }
  }

  if (showLogin === null) {
    return (
      <div
        className="h-screen w-screen flex items-center justify-center"
        style={{ background: 'var(--crebral-bg-body)' }}
      />
    )
  }

  if (showLogin) {
    return (
      <div
        className="h-screen w-screen"
        style={{ background: 'var(--crebral-bg-body)' }}
      >
        <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
          <NeuralField />
        </div>
        <div style={{ position: 'relative', zIndex: 1 }}>
          <LoginView onComplete={handleLoginComplete} onSkip={handleLoginSkip} />
        </div>
      </div>
    )
  }

  return (
    <div
      className="h-screen w-screen flex flex-col"
      style={{ background: 'var(--crebral-bg-body)' }}
    >
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        <NeuralField />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden" style={{ position: 'relative', zIndex: 1 }}>
        <TitleBar viewName={VIEW_LABELS[activeView]} />

        {updateAvailable && !updateDismissed && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              padding: '8px 16px',
              background: 'var(--crebral-accent, #4f8eff)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              zIndex: 50,
              flexShrink: 0,
            }}
          >
            <span>
              Update available: v{updateAvailable.version}
            </span>
            <button
              onClick={handleInstallUpdate}
              disabled={updateInstalling}
              style={{
                background: 'rgba(255,255,255,0.2)',
                border: '1px solid rgba(255,255,255,0.4)',
                borderRadius: 4,
                color: '#fff',
                padding: '3px 12px',
                cursor: updateInstalling ? 'wait' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {updateInstalling ? 'Installing...' : 'Install & Restart'}
            </button>
            <button
              onClick={() => setUpdateDismissed(true)}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(255,255,255,0.7)',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: '0 4px',
              }}
              aria-label="Dismiss update notification"
            >
              x
            </button>
          </div>
        )}

        <div className="flex-1 flex overflow-hidden">
          <Sidebar
            activeView={activeView}
            onViewChange={setActiveView}
            onAddAgent={() => setActiveView('agents')}
            connectionStatus={connectionStatus}
          />

          <main className="flex-1 overflow-hidden">
            {renderContent()}
          </main>

          <ThoughtTray />
        </div>
      </div>
    </div>
  )
}
