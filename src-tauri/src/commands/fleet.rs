use tauri::State;

use crate::services::fleet::FleetDeviceInfo;
use crate::state::AppState;

/// Get fleet registration status.
#[tauri::command]
pub async fn fleet_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Check if coordinator is running to report heartbeat status
    let coordinator_status = state.coordinator_service.status().await;
    let is_heartbeat_running = coordinator_status.is_running;

    let status = state
        .fleet_service
        .status_snapshot(is_heartbeat_running)
        .await;

    Ok(serde_json::to_value(status).map_err(|e| e.to_string())?)
}

/// Register this device with the fleet server.
#[tauri::command]
pub async fn fleet_register(
    device_token: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("fleet_register");

    // Generate device token if not provided
    let token = device_token.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Gather device info
    let device_info = FleetDeviceInfo {
        hostname: hostname().unwrap_or_else(|| "unknown".to_string()),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };

    // Collect agent IDs from the persistent Store
    let agent_ids: Vec<String> = match state.store.active_user_id() {
        Ok(user_id) => state
            .store
            .get_agents(&user_id)
            .unwrap_or_default()
            .iter()
            .map(|a| a.agent_id.clone())
            .collect(),
        Err(_) => {
            // Fall back to the legacy in-memory roster
            let agents = state.agents.lock().map_err(|e| e.to_string())?;
            agents
                .iter()
                .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        }
    };

    let status = state
        .fleet_service
        .register(token, device_info, agent_ids, app_handle)
        .await?;

    Ok(serde_json::json!({
        "ok": true,
        "status": status
    }))
}

/// Disconnect from the fleet.
#[tauri::command]
pub async fn fleet_disconnect(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("fleet_disconnect");

    state.fleet_service.disconnect().await?;

    Ok(serde_json::json!({ "ok": true }))
}

/// Get the system hostname.
fn hostname() -> Option<String> {
    #[cfg(unix)]
    {
        use std::process::Command;
        Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").ok()
    }
}
