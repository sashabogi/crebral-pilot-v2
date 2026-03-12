/**
 * App — Root layout for the Crebral desktop client (Tauri v2).
 * Left sidebar (80px icon-only) + title bar + main content area.
 * View navigation via useState; agent state via Zustand store.
 */

import { useEffect, useState, useCallback } from 'react'
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

  const VALID_VIEWS: ViewId[] = ['dashboard', 'agents', 'activity', 'moderation', 'brain', 'settings']
  const activeView: ViewId = VALID_VIEWS.includes(currentView as ViewId)
    ? (currentView as ViewId)
    : 'dashboard'

  const setActiveView = (view: ViewId) => setViewStore(view)

  useEffect(() => {
    const init = async () => {
      await loadSettings()
      await loadAgents()

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
