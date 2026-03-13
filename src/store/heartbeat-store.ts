import { create } from 'zustand'
import { isTauri, safeIpc, api } from '../lib/ipc'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThoughtEvent {
  id: string
  type: string
  message: string
  timestamp: string
  agentId?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_THOUGHTS = 200

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface HeartbeatState {
  statuses: HeartbeatStatus[]
  thoughts: ThoughtEvent[]
  trayOpen: boolean
  unreadCount: number
  isStarting: boolean
  isStopping: boolean
  coordinatorRunning: boolean
  cycleActive: boolean
  currentAgentId: string | null
  nextScheduledAt: string | null

  startHeartbeat: (agentId: string) => Promise<boolean>
  stopHeartbeat: (agentId: string) => Promise<boolean>
  refreshStatuses: (agentIds: string[]) => Promise<void>
  addThought: (event: ThoughtEvent) => void
  clearThoughts: () => void
  setTrayOpen: (open: boolean) => void
  toggleTray: () => void
  resetUnread: () => void
  clearAll: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useHeartbeatStore = create<HeartbeatState>((set, get) => ({
  statuses: [],
  thoughts: [],
  trayOpen: false,
  unreadCount: 0,
  isStarting: false,
  isStopping: false,
  coordinatorRunning: false,
  cycleActive: false,
  currentAgentId: null,
  nextScheduledAt: null,

  startHeartbeat: async (agentId) => {
    if (!isTauri()) return false
    set({ isStarting: true })
    try {
      const result = await safeIpc(
        () => api.heartbeat.start(agentId) as Promise<{ ok: boolean }>,
        { ok: false }
      )
      if (result.ok) {
        await get().refreshStatuses([agentId])
      }
      return result.ok
    } finally {
      set({ isStarting: false })
    }
  },

  stopHeartbeat: async (agentId) => {
    if (!isTauri()) return false
    set({ isStopping: true })
    try {
      const result = await safeIpc(
        () => api.heartbeat.stop(agentId) as Promise<{ ok: boolean }>,
        { ok: false }
      )
      if (result.ok) {
        await get().refreshStatuses([agentId])
      }
      return result.ok
    } finally {
      set({ isStopping: false })
    }
  },

  refreshStatuses: async (agentIds) => {
    if (!isTauri() || agentIds.length === 0) return

    const results = await Promise.all(
      agentIds.map(async (agentId) => {
        const status = await safeIpc(
          () => api.heartbeat.status(agentId) as Promise<HeartbeatStatus>,
          { agentId, running: false } as HeartbeatStatus
        )
        return { ...status, agentId }
      })
    )

    set((state) => {
      const refreshedIds = new Set(agentIds)
      const kept = state.statuses.filter((s) => !refreshedIds.has(s.agentId))
      return { statuses: [...kept, ...results] }
    })
  },

  addThought: (event) => {
    set((state) => ({
      thoughts: [...state.thoughts, event].slice(-MAX_THOUGHTS),
      unreadCount: state.trayOpen ? 0 : state.unreadCount + 1,
    }))
  },

  clearThoughts: () => {
    set({ thoughts: [], unreadCount: 0 })
  },

  setTrayOpen: (open) => {
    set({ trayOpen: open, ...(open ? { unreadCount: 0 } : {}) })
  },

  toggleTray: () => {
    set((state) => {
      const next = !state.trayOpen
      return { trayOpen: next, ...(next ? { unreadCount: 0 } : {}) }
    })
  },

  resetUnread: () => {
    set({ unreadCount: 0 })
  },

  clearAll: () => {
    set({
      statuses: [],
      thoughts: [],
      trayOpen: false,
      unreadCount: 0,
      isStarting: false,
      isStopping: false,
      coordinatorRunning: false,
      cycleActive: false,
      currentAgentId: null,
      nextScheduledAt: null,
    })
  },
}))

// ---------------------------------------------------------------------------
// Tauri event subscriptions — wire up once at module load
// ---------------------------------------------------------------------------

if (isTauri()) {
  api.heartbeat.onStatusUpdated((_event, data) => {
    const status = data as HeartbeatStatus
    if (status && status.agentId) {
      useHeartbeatStore.setState((state) => {
        const idx = state.statuses.findIndex((s) => s.agentId === status.agentId)
        if (idx >= 0) {
          const updated = [...state.statuses]
          updated[idx] = status
          return { statuses: updated }
        }
        return { statuses: [...state.statuses, status] }
      })
    }
  })

  api.coordinator.onStatusUpdated((_event, data) => {
    const status = data as {
      isRunning: boolean
      currentAgentId: string | null
      nextScheduledAt: string | null
    }
    if (status) {
      useHeartbeatStore.setState({
        coordinatorRunning: status.isRunning,
        currentAgentId: status.currentAgentId,
        nextScheduledAt: status.nextScheduledAt,
      })
    }
  })

  api.coordinator.onAgentStart((_event, data) => {
    const payload = data as { agentId: string }
    if (payload) {
      useHeartbeatStore.setState({
        cycleActive: true,
        currentAgentId: payload.agentId,
      })
    }
  })

  api.coordinator.onAgentComplete(() => {
    useHeartbeatStore.setState({
      cycleActive: false,
      currentAgentId: null,
    })
  })
}
