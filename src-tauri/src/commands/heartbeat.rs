use tauri::State;

use crate::services::heartbeat::HeartbeatConfig;
use crate::services::keychain;
use crate::state::AppState;

/// Resolve the Crebral API key for an agent: keychain first, JSON config fallback.
fn resolve_crebral_key(agent_id: &str, state: &AppState) -> Option<String> {
    // 1. Try OS keychain
    if let Ok(Some(key)) = keychain::get_agent_api_key(agent_id) {
        log::debug!("resolve_crebral_key: found in keychain for {}", agent_id);
        return Some(key);
    }

    // 2. Fall back to JSON config
    let user_id = state.store.active_user_id().ok()?;
    let agent = state.store.get_agent(&user_id, agent_id).ok().flatten()?;
    if let Some(ref enc) = agent.api_key_enc {
        if let Some(key) = crate::services::store::deobfuscate(enc) {
            log::info!("resolve_crebral_key: recovered from JSON fallback for {}", agent_id);
            // Re-store to keychain for next time
            let _ = keychain::store_agent_api_key(agent_id, &key);
            return Some(key);
        }
    }

    None
}

/// Start a recurring heartbeat for an agent.
/// Config: `{ intervalHours, provider, model, providerApiKey, temperature }`
#[tauri::command]
pub async fn heartbeat_start(
    agent_id: String,
    config: Option<serde_json::Value>,
    api_key: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    log::info!("heartbeat_start: agent={}", agent_id);

    let hb_config: HeartbeatConfig = match config {
        Some(v) => serde_json::from_value(v).map_err(|e| format!("Invalid config: {}", e))?,
        None => {
            // Read per-agent interval from Brain settings (like the coordinator does)
            let agent_interval_hours = state.store.active_user_id().ok()
                .and_then(|uid| state.store.get_agent(&uid, &agent_id).ok().flatten())
                .and_then(|a| a.interval_ms)
                .map(|ms| ms as f64 / 3_600_000.0);
            HeartbeatConfig {
                interval_hours: Some(agent_interval_hours.unwrap_or(1.0)),
                provider: None,
                model: None,
                provider_api_key: None,
                temperature: None,
            }
        }
    };

    // API key resolution order: explicit param → config → keychain → JSON fallback → auto-provision
    let resolved_key = api_key
        .or_else(|| hb_config.provider_api_key.clone())
        .or_else(|| resolve_crebral_key(&agent_id, &state));

    let resolved_key = match resolved_key {
        Some(k) => k,
        None => {
            // Try auto-provision as last resort
            log::info!("heartbeat_start: no key found for {}, attempting auto-provision", agent_id);
            let user_id = state.store.active_user_id()
                .map_err(|_| "No active account — please log in first".to_string())?;
            // Try keychain first, then JSON fallback for device token
            let token = keychain::get_device_token(&user_id)
                .ok()
                .flatten()
                .or_else(|| {
                    state.store.get_device_token_enc(&user_id).ok().flatten()
                        .and_then(|enc| crate::services::store::deobfuscate(&enc))
                })
                .ok_or_else(|| "No device token — please log in again".to_string())?;

            match state.gateway.provision_api_key(&token, &agent_id).await {
                Ok(key) => {
                    // Store in both keychain and JSON
                    let _ = keychain::store_agent_api_key(&agent_id, &key);
                    let enc = crate::services::store::obfuscate(&key);
                    let _ = state.store.set_agent_key_enc(&user_id, &agent_id, Some(enc), None);
                    log::info!("heartbeat_start: auto-provisioned key for {}", agent_id);
                    key
                }
                Err(e) => {
                    return Err(format!(
                        "No API key for agent {} and auto-provision failed: {}. Re-sync your account in Settings.",
                        agent_id, e
                    ));
                }
            }
        }
    };

    // Resolve BYOK provider key from keychain/JSON if not already in config
    let mut hb_config = hb_config;
    if hb_config.provider_api_key.is_none() {
        let provider_key = keychain::get_provider_key(&agent_id)
            .ok()
            .flatten()
            .or_else(|| {
                let uid = state.store.active_user_id().ok()?;
                let agent = state.store.get_agent(&uid, &agent_id).ok().flatten()?;
                agent.provider_key_enc.as_ref()
                    .and_then(|enc| crate::services::store::deobfuscate(enc))
            });
        if provider_key.is_some() {
            log::info!("heartbeat_start: resolved BYOK provider key for {}", agent_id);
            hb_config.provider_api_key = provider_key;
        }
    }

    // Share the fleet inner state so heartbeat can report status
    let fleet_service = std::sync::Arc::new(
        crate::services::fleet::FleetService::from_shared(state.fleet_service.inner.clone()),
    );

    state
        .heartbeat_service
        .start(agent_id.clone(), resolved_key, hb_config, fleet_service, app_handle)
        .await?;

    let status = state.heartbeat_service.status(&agent_id).await;

    Ok(serde_json::json!({
        "ok": true,
        "status": status
    }))
}

/// Stop a running heartbeat for an agent.
#[tauri::command]
pub async fn heartbeat_stop(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("heartbeat_stop: agent={}", agent_id);

    state.heartbeat_service.stop(&agent_id).await?;

    // Report agent as idle to fleet (fire-and-forget)
    state.fleet_service.report_status(vec![
        crate::services::fleet::AgentStatusPayload {
            agent_name: agent_id.clone(),
            status: "idle".to_string(),
            provider: None,
            model: None,
            heartbeat_interval_hours: None,
            last_heartbeat: None,
            next_heartbeat: None,
            current_activity: Some("idle".to_string()),
            last_action: None,
            total_heartbeats: None,
            total_actions: None,
            config: None,
        },
    ]);

    Ok(serde_json::json!({
        "ok": true,
        "agentId": agent_id,
        "running": false
    }))
}

/// Get the heartbeat status for an agent.
#[tauri::command]
pub async fn heartbeat_status(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let status = state.heartbeat_service.status(&agent_id).await;

    Ok(serde_json::to_value(status).map_err(|e| e.to_string())?)
}
