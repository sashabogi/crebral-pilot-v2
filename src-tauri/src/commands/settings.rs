/// Settings command handlers — read/write app settings via the persistent JSON store.
///
/// Settings are per-account and stored in config.json under accounts.{userId}.settings.
/// The frontend sends partial objects to merge into existing settings.

use serde_json::json;
use tauri::State;

use crate::state::AppState;

/// Get all settings for the active account.
#[tauri::command]
pub async fn settings_get(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = state.store.active_user_id()?;
    let settings = state.store.get_settings(&user_id)?;
    let value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
    Ok(value)
}

/// Merge partial settings into the active account's stored settings.
///
/// The `settings` param is a JSON object with keys to merge. Existing keys
/// not present in the patch are preserved.
#[tauri::command]
pub async fn settings_set(
    settings: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = state.store.active_user_id()?;
    state.store.merge_settings(&user_id, &settings)?;
    Ok(json!({ "ok": true }))
}
