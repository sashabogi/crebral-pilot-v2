import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isElectron, safeIpc, api } from '../lib/ipc'
import { useHeartbeatStore } from './heartbeat-store'

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface AppState {
  agents: AgentConfig[]
  activeAgentId: string | null
  currentView: string
  settings: AppSettings
  isLoading: boolean
  connectionStatus: 'connected' | 'disconnected' | 'error'
  accounts: Array<{ userId: string; username: string; avatarUrl: string | null }>
  activeAccountId: string | null
  tier: string | null
  agentLimit: number | null

  loadAccountInfo: () => Promise<void>
  loadAccounts: () => Promise<void>
  switchAccount: (userId: string) => Promise<boolean>
  removeAccount: (userId: string) => Promise<boolean>
  loadAgents: () => Promise<void>
  addAgent: (config: AgentConfig) => Promise<boolean>
  removeAgent: (id: string) => Promise<boolean>
  setActiveAgent: (id: string | null) => void
  setView: (view: string) => void
  loadSettings: () => Promise<void>
  saveSettings: (settings: AppSettings) => Promise<boolean>
  validateConnection: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      agents: [],
      activeAgentId: null,
      currentView: 'dashboard',
      settings: {},
      isLoading: false,
      connectionStatus: 'disconnected',
      accounts: [],
      activeAccountId: null,
      tier: null,
      agentLimit: null,

      loadAccountInfo: async () => {
        try {
          const info = await safeIpc(
            () => api.account.getInfo() as Promise<{ tier: string; agentLimit: number; agentCount: number }>,
            { tier: 'free', agentLimit: 1, agentCount: 0 }
          )
          set({ tier: info.tier, agentLimit: info.agentLimit })
        } catch {
          // Account info not available
        }
      },

      loadAccounts: async () => {
        try {
          const result = await safeIpc(
            () => api.auth.listAccounts() as Promise<{ accounts: Array<{ userId: string; username: string; avatarUrl: string | null }>; activeAccountId: string | null }>,
            { accounts: [], activeAccountId: null }
          )
          set({ accounts: result.accounts ?? [], activeAccountId: result.activeAccountId ?? null })
        } catch {
          // Auth not available
        }
      },

      switchAccount: async (userId) => {
        if (!isElectron()) return false
        set({ isLoading: true })
        try {
          const result = await safeIpc(
            () => api.auth.switchAccount(userId) as Promise<{ ok: boolean }>,
            { ok: false }
          )
          if (result.ok) {
            set({ activeAccountId: userId, agents: [], activeAgentId: null })
            useHeartbeatStore.getState().clearAll()
            await get().loadAgents()
            await get().loadAccounts()
          }
          return result.ok
        } finally {
          set({ isLoading: false })
        }
      },

      removeAccount: async (userId) => {
        if (!isElectron()) return false
        set({ isLoading: true })
        try {
          const result = await safeIpc(
            () => api.auth.removeAccount(userId) as Promise<{ ok: boolean; newActiveAccountId?: string | null }>,
            { ok: false }
          )
          if (result.ok) {
            const newActiveId = result.newActiveAccountId
            set({
              activeAccountId: newActiveId ?? null,
              agents: [],
              activeAgentId: null,
            })
            await get().loadAccounts()
            if (newActiveId) {
              await get().loadAgents()
            }
          }
          return result.ok
        } finally {
          set({ isLoading: false })
        }
      },

      loadAgents: async () => {
        set({ isLoading: true })
        try {
          const agents = await safeIpc(
            () => api.agents.list() as Promise<AgentConfig[]>,
            []
          )
          set({ agents })

          const { activeAgentId } = get()
          if (!activeAgentId && agents.length > 0) {
            set({ activeAgentId: agents[0].agentId })
          }
        } finally {
          set({ isLoading: false })
        }
      },

      addAgent: async (config) => {
        if (!isElectron()) return false
        set({ isLoading: true })
        try {
          const result = await safeIpc(
            () => api.agents.add(config as unknown as Record<string, unknown>) as Promise<{ ok: boolean }>,
            { ok: false }
          )
          if (result.ok) {
            await get().loadAgents()
          }
          return result.ok
        } finally {
          set({ isLoading: false })
        }
      },

      removeAgent: async (id) => {
        if (!isElectron()) return false
        set({ isLoading: true })
        try {
          const result = await safeIpc(
            () => api.agents.remove(id) as Promise<{ ok: boolean }>,
            { ok: false }
          )
          if (result.ok) {
            const { activeAgentId } = get()
            if (activeAgentId === id) {
              set({ activeAgentId: null })
            }
            await get().loadAgents()
          }
          return result.ok
        } finally {
          set({ isLoading: false })
        }
      },

      setActiveAgent: (id) => {
        set({ activeAgentId: id })
      },

      setView: (view) => {
        set({ currentView: view })
      },

      loadSettings: async () => {
        const settings = await safeIpc(
          () => api.settings.get() as Promise<AppSettings>,
          {}
        )
        set({ settings })
      },

      saveSettings: async (settings) => {
        if (!isElectron()) return false
        const result = await safeIpc(
          () => api.settings.set(settings as Record<string, unknown>) as Promise<{ ok: boolean }>,
          { ok: false }
        )
        if (result.ok) {
          set({ settings })
        }
        return result.ok
      },

      validateConnection: async () => {
        if (!isElectron()) {
          set({ connectionStatus: 'disconnected' })
          return
        }

        const { agents } = get()
        if (agents.length === 0) {
          set({ connectionStatus: 'disconnected' })
          return
        }

        const firstAgent = agents[0]
        const apiKey = firstAgent.crebralApiKey || (firstAgent as Record<string, unknown>).apiKey as string
        if (!apiKey) {
          set({ connectionStatus: 'disconnected' })
          return
        }

        try {
          const result = await safeIpc(
            () => api.agents.validateKey(apiKey) as Promise<{ ok: boolean }>,
            { ok: false }
          )
          set({ connectionStatus: result.ok ? 'connected' : 'error' })
        } catch {
          set({ connectionStatus: 'error' })
        }
      },
    }),
    {
      name: 'crebral-app-store',
      partialize: (state) => ({
        activeAgentId: state.activeAgentId,
        activeAccountId: state.activeAccountId,
        currentView: state.currentView,
        settings: state.settings,
      }),
    }
  )
)
