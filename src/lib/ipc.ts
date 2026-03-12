/**
 * ipc.ts — Drop-in replacement for the Electron IPC helper.
 *
 * The Electron version checked for `window.api` being present.
 * In Tauri, the api object is always importable, so `isTauri()` replaces
 * `isElectron()`. `safeIpc` is functionally identical.
 */

import { api } from './tauri-bridge'

/**
 * Returns true when running inside the Tauri shell.
 * Also returns true in Vite dev mode (window.api is shimmed via tauri-bridge).
 */
export function isElectron(): boolean {
  // In Tauri we always have the bridge available — the name is kept for
  // compatibility with all copied store files that call isElectron()
  return true
}

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

// Re-export the api object so store files that do `window.api` can be
// updated to import from here instead.
export { api }
