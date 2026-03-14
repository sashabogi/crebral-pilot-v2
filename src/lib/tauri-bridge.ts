/**
 * tauri-bridge.ts — Replaces Electron's window.api with Tauri invoke() calls.
 *
 * Exposes an `api` object with the EXACT same shape as the Electron preload
 * bridge. All components import from this file instead of using window.api.
 *
 * Commands use snake_case Rust function names.
 * Events use Tauri event names matching the original IPC channel names.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import packageJson from '../../package.json'

// ---------------------------------------------------------------------------
// Helper — wraps a Tauri invoke call with a fallback for when running in
// pure Vite dev mode (without the Tauri binary). Returns the fallback
// synchronously if window.__TAURI_INTERNALS__ is not present.
// ---------------------------------------------------------------------------

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safeInvoke(
  cmd: string,
  args?: Record<string, unknown>,
  fallback?: unknown
): Promise<unknown> {
  if (!isTauri()) {
    return fallback
  }
  try {
    return await invoke(cmd, args)
  } catch (err) {
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
    console.error(`[tauri-bridge] invoke(${cmd}) failed:`, msg)
    // Preserve the error message in the returned envelope so callers can display it
    if (fallback && typeof fallback === 'object' && 'ok' in (fallback as Record<string, unknown>)) {
      return { ok: false, error: { code: 'INVOKE_ERROR', message: msg } }
    }
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Event subscription helper — returns an unlisten function exactly matching
// the Electron preload pattern: `() => void`
// ---------------------------------------------------------------------------

function tauriListen(
  eventName: string,
  callback: (_event: unknown, data: unknown) => void
): () => void {
  if (!isTauri()) return () => {}

  let unlisten: UnlistenFn | null = null

  listen(eventName, (event) => {
    callback(event, event.payload)
  }).then((fn) => {
    unlisten = fn
  })

  return () => {
    if (unlisten) unlisten()
  }
}

// ---------------------------------------------------------------------------
// API surface — matches the Electron preload's `window.api` shape exactly
// ---------------------------------------------------------------------------

export const api = {
  // ── Heartbeat ─────────────────────────────────────────────────────────────

  heartbeat: {
    start: (agentId: string, config?: Record<string, unknown>) =>
      safeInvoke('heartbeat_start', { agentId, config }, { ok: false }),

    stop: (agentId: string) =>
      safeInvoke('heartbeat_stop', { agentId }, { ok: false }),

    status: (agentId: string) =>
      safeInvoke('heartbeat_status', { agentId }, {
        agentId,
        running: false,
        cycleCount: 0,
      }),

    onThought: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('heartbeat:thought', callback),

    onResult: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('heartbeat:result', callback),

    onStatusUpdated: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('heartbeat:status-updated', callback),
  },

  // ── Agents ────────────────────────────────────────────────────────────────

  agents: {
    list: () =>
      safeInvoke('agents_list', {}, []),

    get: (agentId: string) =>
      safeInvoke('agents_get', { agentId }, { ok: false }),

    add: (config: Record<string, unknown>) =>
      safeInvoke('agents_add', { config }, { ok: false }),

    remove: (agentId: string) =>
      safeInvoke('agents_remove', { agentId }, { ok: false }),

    updateColor: (agentId: string, color: string) =>
      safeInvoke('agents_update_color', { agentId, color }, { ok: false }),

    validateKey: (apiKey: string, baseUrl?: string) =>
      safeInvoke('agents_validate_key', { apiKey, baseUrl }, { ok: false }),

    profile: (agentId: string) =>
      safeInvoke('agents_profile', { agentId }, { ok: false }),

    activity: (agentId: string) =>
      safeInvoke('agents_activity', { agentId }, { ok: true, activity: [] }),

    saveOrder: (agentIds: string[]) =>
      safeInvoke('agents_save_order', { agentIds }, { ok: false }),

    getOrder: () =>
      safeInvoke('agents_get_order', {}, { ok: true, agentOrder: [] }),

    dashboard: (agentId: string) =>
      safeInvoke('agents_dashboard', { agentId }, { ok: false }),

    decisions: (
      agentId: string,
      params?: { limit?: number; offset?: number; actionType?: string; since?: string }
    ) =>
      safeInvoke('agents_decisions', { agentId, params }, {
        ok: true,
        decisions: [],
        meta: { total: 0, hasMore: false },
      }),
  },

  // ── Settings ──────────────────────────────────────────────────────────────

  settings: {
    get: () =>
      safeInvoke('settings_get', {}, {}),

    set: (settings: Record<string, unknown>) =>
      safeInvoke('settings_set', { settings }, { ok: false }),
  },

  // ── Models ────────────────────────────────────────────────────────────────

  models: {
    getAllProviders: () =>
      safeInvoke('models_get_all_providers', {}, { ok: false, providers: [] }),

    getForProvider: (providerId: string) =>
      safeInvoke('models_get_for_provider', { providerId }, { ok: false, models: [] }),

    fetchWithKey: (providerId: string, apiKey: string) =>
      safeInvoke('models_fetch_with_key', { providerId, apiKey }, { ok: false, models: [] }),

    fetchForAgent: (agentId: string, providerId: string) =>
      safeInvoke('models_fetch_for_agent', { agentId, providerId }, { ok: false, models: [] }),
  },

  // ── Coordinator ───────────────────────────────────────────────────────────

  coordinator: {
    start: () =>
      safeInvoke('coordinator_start', {}, { ok: false }),

    stop: () =>
      safeInvoke('coordinator_stop', {}, { ok: false }),

    status: () =>
      safeInvoke('coordinator_status', {}, {
        isRunning: false,
        minGapMs: 300000,
        queue: [],
        pausedAgentIds: [],
        currentAgentId: null,
        nextAgentId: null,
        nextScheduledAt: null,
        totalCycles: 0,
        lastCompletedTimes: {},
        agentCycleCounts: {},
      }),

    setMinGap: (ms: number) =>
      safeInvoke('coordinator_set_min_gap', { ms }, { ok: false }),

    reorder: (agentIds: string[]) =>
      safeInvoke('coordinator_reorder', { agentIds }, { ok: false }),

    pauseAgent: (agentId: string) =>
      safeInvoke('coordinator_pause_agent', { agentId }, { ok: false }),

    resumeAgent: (agentId: string) =>
      safeInvoke('coordinator_resume_agent', { agentId }, { ok: false }),

    onStatusUpdated: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('coordinator:status-updated', callback),

    onAgentStart: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('coordinator:agent-start', callback),

    onAgentComplete: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('coordinator:agent-complete', callback),
  },

  // ── Auth ──────────────────────────────────────────────────────────────────

  auth: {
    login: () =>
      safeInvoke('auth_login', {}, { ok: false }),

    syncAccount: (regenerateKeys?: boolean) =>
      safeInvoke('auth_sync_account', { regenerateKeys }, { ok: false }),

    syncAndLoad: (regenerateKeys?: boolean) =>
      safeInvoke('auth_sync_and_load', { regenerateKeys }, { ok: false }),

    provisionKey: (agentId: string) =>
      safeInvoke('auth_provision_key', { agentId }, { ok: false }),

    logout: () =>
      safeInvoke('auth_logout', {}, { success: false }),

    status: () =>
      safeInvoke('auth_status', {}, {
        isAuthenticated: false,
        user: null,
        accountCount: 0,
        activeAccountId: null,
      }),

    listAccounts: () =>
      safeInvoke('auth_list_accounts', {}, { accounts: [], activeAccountId: null }),

    switchAccount: (userId: string) =>
      safeInvoke('auth_switch_account', { userId }, { ok: false }),

    removeAccount: (userId: string) =>
      safeInvoke('auth_remove_account', { userId }, { ok: false }),

    onTokenReceived: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('auth:token-received', callback),

    onAccountSwitched: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('auth:account-switched', callback),
  },

  // ── Account ───────────────────────────────────────────────────────────────

  account: {
    getInfo: () =>
      safeInvoke('account_get_info', {}, { tier: 'free', agentLimit: 1, agentCount: 0 }),

    onInfoUpdated: (callback: (_event: unknown, data: unknown) => void) =>
      tauriListen('account:info-updated', callback),
  },

  // ── Fleet ─────────────────────────────────────────────────────────────────

  fleet: {
    status: () =>
      safeInvoke('fleet_status', {}, {
        isRegistered: false,
        fleetId: null,
        isHeartbeatRunning: false,
      }),

    register: () =>
      safeInvoke('fleet_register', {}, { ok: false }),

    disconnect: () =>
      safeInvoke('fleet_disconnect', {}, { ok: false }),

    onCommandReceived: (callback: (_event: unknown, command: unknown) => void) =>
      tauriListen('fleet:command-received', callback),
  },

  // ── Utilities ─────────────────────────────────────────────────────────────

  openExternal: async (url: string) => {
    try {
      if (isTauri()) {
        await shellOpen(url)
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      return { ok: true }
    } catch (err) {
      console.error('[tauri-bridge] openExternal failed:', err)
      return { ok: false, error: String(err) }
    }
  },

  // ── Platform / App Version ────────────────────────────────────────────────

  platform: ((): string => {
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__TAURI_OS_PLUGIN_INTERNALS__) {
      // Will be populated at runtime — default to darwin for macOS dev
    }
    return 'darwin'
  })(),

  appVersion: packageJson.version,
}

// ---------------------------------------------------------------------------
// Type aliases — match the global declarations from the Electron env.d.ts
// so that copied components compile without changes.
// ---------------------------------------------------------------------------

export type TauriApi = typeof api
