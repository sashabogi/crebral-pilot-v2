use std::sync::Arc;

use tauri::{Emitter, State};

use crate::services::coordinator::CoordinatorAgent;
use crate::services::heartbeat::HeartbeatConfig;
use crate::services::keychain;
use crate::state::AppState;

/// Start the round-robin coordinator.
/// Reads agents from the Store (persistent config) and resolves API keys from keychain.
#[tauri::command]
pub async fn coordinator_start(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_start");

    // Get the active user ID from the store
    let user_id = state.store.active_user_id()?;

    // Load agents from persistent store
    let agents = state.store.get_agents(&user_id)?;

    if agents.is_empty() {
        return Err("No agents configured — add agents before starting the coordinator".to_string());
    }

    // Load settings for min_gap
    let settings = state.store.get_settings(&user_id)?;

    // Build coordinator queue, resolving API keys from keychain with JSON config fallback
    let mut queue: Vec<CoordinatorAgent> = Vec::new();
    for agent in &agents {
        let agent_id = &agent.agent_id;

        // Resolve Crebral API key: keychain first, then JSON config fallback
        let api_key = match keychain::get_agent_api_key(agent_id) {
            Ok(Some(key)) => {
                log::info!(
                    "coordinator: API key from KEYCHAIN for {} ({})",
                    agent.display_name,
                    agent_id
                );
                key
            }
            _ => {
                // Fall back to JSON config (obfuscated base64)
                match agent.api_key_enc.as_ref().and_then(|enc| crate::services::store::deobfuscate(enc)) {
                    Some(key) => {
                        log::info!(
                            "coordinator: recovered API key from JSON fallback for {} ({})",
                            agent.display_name,
                            agent_id
                        );
                        // Re-store to keychain for next time
                        if let Err(e) = keychain::store_agent_api_key(agent_id, &key) {
                            log::warn!("coordinator: FAILED to re-store API key to keychain for {}: {}", agent_id, e);
                        }
                        key
                    }
                    None => {
                        log::warn!(
                            "Skipping agent {} ({}) — no API key in keychain or JSON config",
                            agent.display_name,
                            agent_id
                        );
                        continue;
                    }
                }
            }
        };

        // Resolve provider API key: keychain first, then JSON config fallback (optional — for BYOK agents)
        let provider_api_key = match keychain::get_provider_key(agent_id) {
            Ok(Some(key)) => {
                log::info!(
                    "coordinator: provider key from KEYCHAIN for {} ({})",
                    agent.display_name,
                    agent_id
                );
                Some(key)
            }
            _ => {
                // Fall back to JSON config
                agent.provider_key_enc.as_ref().and_then(|enc| {
                    let key = crate::services::store::deobfuscate(enc)?;
                    log::info!(
                        "coordinator: provider key from JSON FALLBACK for {} ({})",
                        agent.display_name,
                        agent_id
                    );
                    // Re-store to keychain for next time
                    if let Err(e) = keychain::store_provider_key(agent_id, &key) {
                        log::warn!("coordinator: FAILED to re-store provider key to keychain for {}: {}", agent_id, e);
                    }
                    Some(key)
                })
            }
        };

        // Convert per-agent interval_ms (from Brain settings) to interval_hours
        let interval_hours = agent.interval_ms.map(|ms| ms as f64 / 3_600_000.0);

        let config = HeartbeatConfig {
            interval_hours,
            provider: if agent.provider.is_empty() {
                None
            } else {
                Some(agent.provider.clone())
            },
            model: if agent.model.is_empty() {
                None
            } else {
                Some(agent.model.clone())
            },
            provider_api_key,
            temperature: None,
        };

        queue.push(CoordinatorAgent {
            agent_id: agent_id.clone(),
            api_key,
            config,
        });
    }

    if queue.is_empty() {
        return Err(
            "No agents with valid API keys found — ensure agent keys are provisioned via auth sync"
                .to_string(),
        );
    }

    // Sort queue to match the user's saved agent order (from drag-and-drop reordering).
    // Without this, the queue uses the default store insertion order, which ignores
    // any reordering the user performed in the sidebar.
    let saved_order = state.store.get_agent_order(&user_id).unwrap_or_default();
    if !saved_order.is_empty() {
        queue.sort_by_key(|agent| {
            saved_order
                .iter()
                .position(|id| id == &agent.agent_id)
                .unwrap_or(usize::MAX)
        });
        log::info!(
            "coordinator_start: sorted queue by saved agent order ({} entries)",
            saved_order.len()
        );
    }

    // Apply min_gap from settings
    state
        .coordinator_service
        .set_min_gap(settings.min_gap_ms)
        .await;

    state.coordinator_service.set_queue(queue).await;

    let heartbeat_service = Arc::new(
        // Coordinator calls HeartbeatService::run_cycle as a static method.
        crate::services::heartbeat::HeartbeatService::new(),
    );

    // Share the fleet inner state from the app-level fleet service
    // so that status reports use the registered fleet_id/device_token.
    let fleet_service = Arc::new(crate::services::fleet::FleetService::from_shared(
        state.fleet_service.inner.clone(),
    ));

    state
        .coordinator_service
        .start(heartbeat_service, fleet_service, app_handle)
        .await?;

    let status = state.coordinator_service.status().await;

    Ok(serde_json::json!({
        "ok": true,
        "status": status
    }))
}

/// Stop the coordinator loop.
#[tauri::command]
pub async fn coordinator_stop(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_stop");

    // Report all agents as idle before stopping
    {
        let coord_inner = state.coordinator_service.inner.lock().await;
        let payloads: Vec<crate::services::fleet::AgentStatusPayload> = coord_inner
            .queue
            .iter()
            .map(|agent| crate::services::fleet::AgentStatusPayload {
                agent_name: agent.agent_id.clone(),
                status: "idle".to_string(),
                provider: agent.config.provider.clone(),
                model: agent.config.model.clone(),
                heartbeat_interval_hours: agent.config.interval_hours,
                last_heartbeat: coord_inner.last_completed_times.get(&agent.agent_id).cloned(),
                next_heartbeat: None,
                current_activity: Some("idle".to_string()),
                last_action: None,
                total_heartbeats: coord_inner.agent_cycle_counts.get(&agent.agent_id).copied(),
                total_actions: None,
                config: None,
            })
            .collect();
        state.fleet_service.report_status(payloads);
    }

    state.coordinator_service.stop().await?;

    let status = state.coordinator_service.status().await;
    let _ = app_handle.emit("coordinator:status-updated", &status);

    Ok(serde_json::json!({
        "ok": true,
        "status": status
    }))
}

/// Get coordinator status.
#[tauri::command]
pub async fn coordinator_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let status = state.coordinator_service.status().await;
    Ok(serde_json::to_value(status).map_err(|e| e.to_string())?)
}

/// Set the minimum gap between agent cycles.
#[tauri::command]
pub async fn coordinator_set_min_gap(
    ms: u64,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_set_min_gap: {}ms", ms);

    state.coordinator_service.set_min_gap(ms).await;

    let status = state.coordinator_service.status().await;
    let _ = app_handle.emit("coordinator:status-updated", &status);

    Ok(serde_json::json!({
        "ok": true,
        "minGapMs": ms
    }))
}

/// Reorder the agent queue.
#[tauri::command]
pub async fn coordinator_reorder(
    agent_ids: Vec<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_reorder: {:?}", agent_ids);

    state.coordinator_service.reorder(agent_ids).await;

    let status = state.coordinator_service.status().await;
    let _ = app_handle.emit("coordinator:status-updated", &status);

    Ok(serde_json::json!({
        "ok": true,
        "status": status
    }))
}

/// Pause an agent — skip it in the rotation.
#[tauri::command]
pub async fn coordinator_pause_agent(
    agent_id: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_pause_agent: {}", agent_id);

    state.coordinator_service.pause_agent(&agent_id).await;

    let status = state.coordinator_service.status().await;
    let _ = app_handle.emit("coordinator:status-updated", &status);

    Ok(serde_json::json!({
        "ok": true,
        "status": status
    }))
}

/// Resume a paused agent.
#[tauri::command]
pub async fn coordinator_resume_agent(
    agent_id: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_resume_agent: {}", agent_id);

    state.coordinator_service.resume_agent(&agent_id).await;

    let status = state.coordinator_service.status().await;
    let _ = app_handle.emit("coordinator:status-updated", &status);

    Ok(serde_json::json!({
        "ok": true,
        "status": status
    }))
}
