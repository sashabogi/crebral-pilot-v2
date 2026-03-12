/// Command modules — each module owns one logical domain.
/// These are stubs that return Ok(null) so the React UI can compile and run
/// while Rust implementations are built out.

use tauri::State;
use crate::state::AppState;

// ── Heartbeat ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn heartbeat_start(
    agent_id: String,
    config: Option<serde_json::Value>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("heartbeat_start: agent={} config={:?}", agent_id, config);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2 (Rust heartbeat)" } }))
}

#[tauri::command]
pub async fn heartbeat_stop(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("heartbeat_stop: agent={}", agent_id);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn heartbeat_status(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "agentId": agent_id, "running": false, "cycleCount": 0 }))
}

// ── Agents ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn agents_list(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([]))
}

#[tauri::command]
pub async fn agents_get(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": false, "error": { "message": format!("Agent {} not found", agent_id) } }))
}

#[tauri::command]
pub async fn agents_add(
    config: serde_json::Value,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("agents_add: {:?}", config);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn agents_remove(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("agents_remove: {}", agent_id);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn agents_update_color(
    agent_id: String,
    color: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("agents_update_color: {} => {}", agent_id, color);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn agents_validate_key(
    api_key: String,
    base_url: Option<String>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("agents_validate_key: key={}... base_url={:?}", &api_key[..api_key.len().min(8)], base_url);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn agents_profile(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": false, "error": { "message": format!("Profile for {} not available", agent_id) } }))
}

#[tauri::command]
pub async fn agents_activity(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "activity": [] }))
}

#[tauri::command]
pub async fn agents_save_order(
    agent_ids: Vec<String>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("agents_save_order: {:?}", agent_ids);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn agents_get_order(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "agentOrder": [] }))
}

#[tauri::command]
pub async fn agents_dashboard(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": false, "error": { "message": format!("Dashboard for {} not available", agent_id) } }))
}

#[tauri::command]
pub async fn agents_decisions(
    agent_id: String,
    params: Option<serde_json::Value>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("agents_decisions: agent={} params={:?}", agent_id, params);
    Ok(serde_json::json!({ "ok": true, "decisions": [], "meta": { "total": 0, "hasMore": false } }))
}

// ── Settings ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn settings_get(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(settings.clone()).unwrap_or_default())
}

#[tauri::command]
pub async fn settings_set(
    settings: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if let Some(obj) = settings.as_object() {
        let mut store = state.settings.lock().map_err(|e| e.to_string())?;
        for (k, v) in obj {
            store.insert(k.clone(), v.clone());
        }
    }
    Ok(serde_json::json!({ "ok": true }))
}

// ── Models ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn models_get_all_providers(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Return a static list of providers for now — WS3 will fetch dynamically
    Ok(serde_json::json!({
        "ok": true,
        "providers": [
            { "id": "anthropic", "name": "Anthropic (Claude)", "isDirect": true, "requiresApiKey": true },
            { "id": "openai", "name": "OpenAI (GPT)", "isDirect": true, "requiresApiKey": true },
            { "id": "google", "name": "Google (Gemini)", "isDirect": true, "requiresApiKey": true },
            { "id": "deepseek", "name": "DeepSeek", "isDirect": true, "requiresApiKey": true },
            { "id": "xai", "name": "xAI (Grok)", "isDirect": true, "requiresApiKey": true },
            { "id": "perplexity", "name": "Perplexity", "isDirect": true, "requiresApiKey": true },
            { "id": "mistral", "name": "Mistral", "isDirect": true, "requiresApiKey": true },
            { "id": "openrouter", "name": "OpenRouter (multi-model)", "isDirect": true, "requiresApiKey": true },
            { "id": "ollama", "name": "Ollama (local)", "isDirect": true, "requiresApiKey": false },
            { "id": "cohere", "name": "Cohere", "isDirect": false, "requiresApiKey": true },
            { "id": "azure", "name": "Azure OpenAI", "isDirect": false, "requiresApiKey": true }
        ]
    }))
}

#[tauri::command]
pub async fn models_get_for_provider(
    provider_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Static fallback model lists — WS3 will fetch dynamically
    let models = match provider_id.as_str() {
        "anthropic" => serde_json::json!({
            "ok": true,
            "defaultModel": "claude-sonnet-4-5",
            "models": [
                { "id": "claude-opus-4-5", "name": "Claude Opus 4.5", "contextWindow": 200000 },
                { "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "contextWindow": 200000 },
                { "id": "claude-haiku-3-5", "name": "Claude Haiku 3.5", "contextWindow": 200000 }
            ]
        }),
        "openai" => serde_json::json!({
            "ok": true,
            "defaultModel": "gpt-4o-mini",
            "models": [
                { "id": "gpt-4o", "name": "GPT-4o", "contextWindow": 128000 },
                { "id": "gpt-4o-mini", "name": "GPT-4o mini", "contextWindow": 128000 },
                { "id": "o1-mini", "name": "o1 mini", "contextWindow": 128000 }
            ]
        }),
        "google" => serde_json::json!({
            "ok": true,
            "defaultModel": "gemini-2.0-flash",
            "models": [
                { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "contextWindow": 1000000 },
                { "id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash", "contextWindow": 1000000 },
                { "id": "gemini-1.5-flash", "name": "Gemini 1.5 Flash", "contextWindow": 1000000 }
            ]
        }),
        "deepseek" => serde_json::json!({
            "ok": true,
            "defaultModel": "deepseek-chat",
            "models": [
                { "id": "deepseek-chat", "name": "DeepSeek V3", "contextWindow": 64000 },
                { "id": "deepseek-reasoner", "name": "DeepSeek R1", "contextWindow": 64000 }
            ]
        }),
        "xai" => serde_json::json!({
            "ok": true,
            "defaultModel": "grok-2",
            "models": [
                { "id": "grok-2", "name": "Grok 2", "contextWindow": 131000 },
                { "id": "grok-2-mini", "name": "Grok 2 mini", "contextWindow": 131000 }
            ]
        }),
        "ollama" => serde_json::json!({
            "ok": true,
            "defaultModel": "llama3.2",
            "models": [
                { "id": "llama3.2", "name": "Llama 3.2", "contextWindow": 128000 },
                { "id": "mistral", "name": "Mistral 7B", "contextWindow": 32000 },
                { "id": "qwen2.5", "name": "Qwen 2.5", "contextWindow": 128000 }
            ]
        }),
        _ => serde_json::json!({
            "ok": true,
            "models": []
        }),
    };
    Ok(models)
}

#[tauri::command]
pub async fn models_fetch_with_key(
    provider_id: String,
    api_key: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("models_fetch_with_key: provider={}", provider_id);
    // WS3 will implement dynamic model fetching — for now fall through to static list
    let _ = api_key;
    Ok(serde_json::json!({ "ok": false, "models": [] }))
}

// ── Coordinator ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn coordinator_start(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut running = state.coordinator_running.lock().map_err(|e| e.to_string())?;
    *running = true;
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn coordinator_stop(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut running = state.coordinator_running.lock().map_err(|e| e.to_string())?;
    *running = false;
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn coordinator_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let running = state.coordinator_running.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "isRunning": *running,
        "minGapMs": 300000,
        "queue": [],
        "pausedAgentIds": [],
        "currentAgentId": null,
        "nextAgentId": null,
        "nextScheduledAt": null,
        "totalCycles": 0,
        "lastCompletedTimes": {},
        "agentCycleCounts": {}
    }))
}

#[tauri::command]
pub async fn coordinator_set_min_gap(
    ms: u64,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_set_min_gap: {}ms", ms);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn coordinator_reorder(
    agent_ids: Vec<String>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_reorder: {:?}", agent_ids);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn coordinator_pause_agent(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_pause_agent: {}", agent_id);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

#[tauri::command]
pub async fn coordinator_resume_agent(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("coordinator_resume_agent: {}", agent_id);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS2" } }))
}

// ── Auth ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn auth_login(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS4 (auth)" } }))
}

#[tauri::command]
pub async fn auth_sync_account(
    regenerate_keys: Option<bool>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("auth_sync_account: regenerate={:?}", regenerate_keys);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS4" } }))
}

#[tauri::command]
pub async fn auth_sync_and_load(
    regenerate_keys: Option<bool>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("auth_sync_and_load: regenerate={:?}", regenerate_keys);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS4" } }))
}

#[tauri::command]
pub async fn auth_provision_key(
    agent_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("auth_provision_key: agent={}", agent_id);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS4" } }))
}

#[tauri::command]
pub async fn auth_logout(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "success": false }))
}

#[tauri::command]
pub async fn auth_status(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "isAuthenticated": false,
        "user": null,
        "accountCount": 0,
        "activeAccountId": null
    }))
}

#[tauri::command]
pub async fn auth_list_accounts(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "accounts": [], "activeAccountId": null }))
}

#[tauri::command]
pub async fn auth_switch_account(
    user_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("auth_switch_account: {}", user_id);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS4" } }))
}

#[tauri::command]
pub async fn auth_remove_account(
    user_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("auth_remove_account: {}", user_id);
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS4" } }))
}

// ── Account ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn account_get_info(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "tier": "free", "agentLimit": 1, "agentCount": 0 }))
}

// ── Fleet ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn fleet_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let registered = state.fleet_registered.lock().map_err(|e| e.to_string())?;
    let fleet_id = state.fleet_id.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "isRegistered": *registered,
        "fleetId": *fleet_id,
        "isHeartbeatRunning": false
    }))
}

#[tauri::command]
pub async fn fleet_register(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": false, "error": { "message": "Not implemented — WS5 (fleet)" } }))
}

#[tauri::command]
pub async fn fleet_disconnect(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut registered = state.fleet_registered.lock().map_err(|e| e.to_string())?;
    let mut fleet_id = state.fleet_id.lock().map_err(|e| e.to_string())?;
    *registered = false;
    *fleet_id = None;
    Ok(serde_json::json!({ "ok": true }))
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
