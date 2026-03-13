/// Command modules — each module owns one logical domain.
/// Each submodule exports its Tauri command functions.
///
/// Submodules must be `pub` so that `tauri::generate_handler!` in lib.rs can
/// resolve both the function AND its generated `__cmd__` companion symbol.

pub mod agents;
pub mod auth;
pub mod coordinator;
pub mod fleet;
pub mod heartbeat;
pub mod models;
pub mod settings;

use tauri::State;
use crate::state::AppState;

// ── Account ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn account_get_info(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = _state.store.active_user_id().unwrap_or_default();
    let agent_count = _state.store.get_agents(&user_id).map(|a| a.len()).unwrap_or(0);
    Ok(serde_json::json!({ "tier": "pro", "agentLimit": 50, "agentCount": agent_count }))
}

// ── Utilities ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_external(url: String) -> Result<serde_json::Value, String> {
    log::info!("open_external: {}", url);
    // Delegated to shell plugin — see lib.rs setup
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn get_platform() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return Ok("darwin".to_string());
    #[cfg(target_os = "windows")]
    return Ok("win32".to_string());
    #[cfg(target_os = "linux")]
    return Ok("linux".to_string());
}
