/**
 * ipc.ts — Drop-in replacement for the Tauri IPC helper.
 *
 * The api object is always importable from tauri-bridge.
 * `isTauri()` returns true when the Tauri runtime is available.
 * `safeIpc` wraps calls in try/catch with a fallback value.
 */

import { api } from './tauri-bridge'

/**
 * Returns true when running inside the Tauri shell.
 * Also returns true in Vite dev mode (window.api is shimmed via tauri-bridge).
 */
export function isTauri(): boolean {
  // In Tauri we always have the bridge available
  return true
}

/**
 * @deprecated Use `isTauri()` instead. Kept temporarily for grep-ability.
 */
export const isElectron = isTauri

/**
 * Wraps an IPC call in a try/catch. Returns the result on success or the
 * provided `fallback` on failure.
 */
export async function safeIpc<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.error('[IPC]', err)
    return fallback
  }
}

// Re-export the api object so store files can import from here.
export { api }
