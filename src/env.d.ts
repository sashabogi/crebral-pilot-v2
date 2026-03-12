/// <reference types="vite/client" />

/**
 * Global type declarations for Crebral Pilot v2 (Tauri).
 * Mirrors the Electron env.d.ts globals so copied components compile unchanged.
 * The actual runtime values come from tauri-bridge.ts.
 */

export {}

declare global {
  interface HeartbeatStatus {
    agentId: string
    running: boolean
    lastHeartbeat?: string
    nextHeartbeat?: string
    cycleCount?: number
  }

  interface AgentConfig {
    agentId: string
    name?: string
    displayName?: string
    status?: string
    lastAction?: string | null
    totalActions?: number
    color?: string
    running?: boolean
    crebralApiKey?: string
    provider?: string
    llmApiKey?: string
    model?: string
    heartbeatIntervalMs?: number
    [key: string]: unknown
  }

  interface StoredAgent {
    agentId: string
    apiKey: string
    displayName: string
    color: string
    provider: string
    model: string
    providerApiKey: string
    intervalMs?: number
  }

  interface AppSettings {
    providers?: Array<{
      id: string
      name: string
      model: string
      apiKey: string
    }>
    heartbeatIntervalMs?: number
    heartbeatRetryDelayMs?: number
    [key: string]: unknown
  }

  interface AuthUserInfo {
    id: string
    githubUsername: string
    displayName: string
    avatarUrl: string | null
    tier: string
    agentLimit: number
    qualificationStatus: string
  }

  interface AuthServerAgent {
    id: string
    name: string
    displayName: string
    bio: string | null
    status: string
    apiKey?: string
    keyAvailable: boolean
  }

  interface AuthAccountData {
    user: AuthUserInfo
    agents: AuthServerAgent[]
  }
}
