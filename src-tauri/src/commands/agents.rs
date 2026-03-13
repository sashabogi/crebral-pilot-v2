/// Agent command handlers — manage agent configs, secrets, and remote API calls.
///
/// Non-secret data lives in the JSON config store (services/store.rs).
/// Secrets (crebralApiKey, providerApiKey) live in OS keychain (services/keychain.rs).
/// API keys are NEVER returned to the frontend — they appear as "REDACTED".

use serde_json::json;
use tauri::State;

use crate::services::keychain;
use crate::services::store::AgentConfig;
use crate::state::AppState;

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Get the active user ID from the store, or return an error.
fn active_user(state: &AppState) -> Result<String, String> {
    state.store.active_user_id()
}

/// Resolve the Crebral API key for an agent: keychain first, JSON config fallback.
/// On JSON hit, re-stores to keychain so future lookups are fast.
fn resolve_agent_api_key(agent_id: &str, state: &AppState) -> Result<String, String> {
    // 1. Try OS keychain (fast path)
    if let Ok(Some(key)) = keychain::get_agent_api_key(agent_id) {
        return Ok(key);
    }

    // 2. Fall back to JSON config (obfuscated base64)
    let user_id = state.store.active_user_id()
        .map_err(|_| format!("No active account — cannot resolve key for agent {agent_id}"))?;
    let agent = state.store.get_agent(&user_id, agent_id)
        .map_err(|e| format!("Store error: {e}"))?
        .ok_or_else(|| format!("Agent {agent_id} not found in config"))?;

    if let Some(ref enc) = agent.api_key_enc {
        if let Some(key) = crate::services::store::deobfuscate(enc) {
            // Re-store to keychain for next time
            let _ = keychain::store_agent_api_key(agent_id, &key);
            log::info!("resolve_agent_api_key: recovered from JSON fallback for {}", agent_id);
            return Ok(key);
        }
    }

    Err(format!("No Crebral API key found for agent {agent_id} (keychain + JSON both empty)"))
}

/// Serialize an AgentConfig to JSON with redacted secrets.
/// Checks keychain first, falls back to JSON config for key availability.
fn agent_to_json(agent: &AgentConfig) -> serde_json::Value {
    // Crebral API key: try keychain first, fall back to JSON config
    let has_crebral_key = keychain::get_agent_api_key(&agent.agent_id)
        .ok()
        .flatten()
        .is_some()
        || agent.api_key_enc.is_some();

    if !has_crebral_key {
        log::debug!("[agent_to_json] no crebralApiKey for {} (keychain + JSON both empty)", agent.agent_id);
    }

    // Provider API key: try keychain first, fall back to JSON config
    let has_provider_key = keychain::get_provider_key(&agent.agent_id)
        .ok()
        .flatten()
        .is_some()
        || agent.provider_key_enc.is_some();

    if !has_provider_key {
        log::debug!("[agent_to_json] no providerApiKey for {} (keychain + JSON both empty)", agent.agent_id);
    }

    json!({
        "agentId": agent.agent_id,
        "name": agent.name,
        "displayName": agent.display_name,
        "status": agent.status,
        "color": agent.color,
        "provider": agent.provider,
        "model": agent.model,
        "bio": agent.bio,
        "avatarUrl": agent.avatar_url,
        "crebralApiKey": if has_crebral_key { "REDACTED" } else { "" },
        "providerApiKey": if has_provider_key { "REDACTED" } else { "" },
        "intervalMs": agent.interval_ms,
    })
}

/// Normalize a raw decision record from the API into the shape the frontend expects.
/// Handles snake_case → camelCase, field renames, AND inner JSON unwrapping.
///
/// `response_content` is often a JSON string whose shape varies by action type:
///   post:    {"type":"post","content":"text..."}
///   comment: {"type":"comment","content":"text...","targetPostId":"..."}
///   upvote:  {"type":"upvote","targetPostId":"...","reasoning":"..."}
///   skip:    {"type":"skip","reasoning":"..."}
///
/// We parse that inner JSON and merge its fields as fallbacks.
fn normalize_decision(raw: &serde_json::Value) -> serde_json::Value {
    let obj = match raw.as_object() {
        Some(o) => o,
        None => return raw.clone(),
    };

    // Helper: return first non-null value from a list of candidate keys
    let pick = |keys: &[&str]| -> serde_json::Value {
        for key in keys {
            if let Some(v) = obj.get(*key) {
                if !v.is_null() {
                    return v.clone();
                }
            }
        }
        serde_json::Value::Null
    };

    // Try to parse response_content as JSON to extract inner fields
    let inner: Option<serde_json::Value> = obj
        .get("response_content")
        .or_else(|| obj.get("content"))
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with('{'))
        .and_then(|s| serde_json::from_str(s).ok());

    // Helper: pick from inner parsed JSON
    let inner_get = |key: &str| -> serde_json::Value {
        inner
            .as_ref()
            .and_then(|v| v.get(key))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };

    // For each field: prefer top-level (snake or camel), fall back to inner JSON
    let action_type = pick(&["action_type", "actionType"]);
    let action_type = if action_type.is_null() { inner_get("type") } else { action_type };

    let content = inner_get("content");
    let content = if content.is_null() { pick(&["content"]) } else { content };

    let reasoning = pick(&["why_interesting", "agent_take", "reasoning"]);
    let reasoning = if reasoning.is_null() { inner_get("reasoning") } else { reasoning };

    let target_post = pick(&["target_post_id", "targetPostId"]);
    let target_post = if target_post.is_null() { inner_get("targetPostId") } else { target_post };

    let target_comment = pick(&["target_comment_id", "targetCommentId"]);
    let target_comment = if target_comment.is_null() { inner_get("targetCommentId") } else { target_comment };

    let community = pick(&["community_id", "communityId"]);
    let community = if community.is_null() { inner_get("communityId") } else { community };

    json!({
        "id": pick(&["id"]),
        "actionType": action_type,
        "content": content,
        "reasoning": reasoning,
        "targetPostId": target_post,
        "targetCommentId": target_comment,
        "communityId": community,
        "createdAt": pick(&["created_at", "createdAt"]),
        "score": pick(&["score"]),
    })
}

// ── Commands ────────────────────────────────────────────────────────────────

/// List all agents for the active account (secrets redacted).
#[tauri::command]
pub async fn agents_list(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = active_user(&state)?;
    let agents = state.store.get_agents(&user_id)?;
    let list: Vec<serde_json::Value> = agents.iter().map(|a| agent_to_json(a)).collect();
    Ok(json!(list))
}

/// Get a single agent by ID (secrets redacted).
#[tauri::command]
pub async fn agents_get(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = active_user(&state)?;
    match state.store.get_agent(&user_id, &agent_id)? {
        Some(agent) => Ok(json!({ "ok": true, "agent": agent_to_json(&agent) })),
        None => Ok(json!({
            "ok": false,
            "error": { "code": "AGENT_NOT_FOUND", "message": format!("Agent {} not found", agent_id) }
        })),
    }
}

/// Add or update an agent. Secrets go to keychain, non-secrets to JSON store.
///
/// Expected `config` fields:
///   agentId, name, displayName, status?, color?, provider, model,
///   crebralApiKey?, providerApiKey?, bio?, avatarUrl?
#[tauri::command]
pub async fn agents_add(
    config: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = active_user(&state)?;

    let agent_id = config
        .get("agentId")
        .and_then(|v| v.as_str())
        .ok_or("Missing required field: agentId")?
        .to_string();

    let name = config
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&agent_id)
        .to_string();

    let display_name = config
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(&name)
        .to_string();

    // Preserve existing encoded keys through the upsert (prevents wiping JSON fallback keys)
    let existing = state.store.get_agent(&user_id, &agent_id).ok().flatten();

    let agent_config = AgentConfig {
        agent_id: agent_id.clone(),
        name,
        display_name,
        status: config
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("active")
            .to_string(),
        color: config
            .get("color")
            .and_then(|v| v.as_str())
            .unwrap_or("#3CB371")
            .to_string(),
        provider: config
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        model: config
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        bio: config.get("bio").and_then(|v| v.as_str()).map(String::from),
        avatar_url: config
            .get("avatarUrl")
            .and_then(|v| v.as_str())
            .map(String::from),
        api_key_enc: existing.as_ref().and_then(|a| a.api_key_enc.clone()),
        provider_key_enc: existing.as_ref().and_then(|a| a.provider_key_enc.clone()),
        interval_ms: config
            .get("intervalMs")
            .and_then(|v| v.as_u64()),
    };

    // Store non-secret config to JSON file
    state.store.upsert_agent(&user_id, agent_config)?;

    // Store secrets: write to BOTH keychain (primary) and JSON config (fallback)
    if let Some(key) = config.get("crebralApiKey").and_then(|v| v.as_str()) {
        if !key.is_empty() && key != "REDACTED" {
            log::info!("agents_add: storing crebralApiKey for {} (len={})", agent_id, key.len());
            // Primary: OS keychain
            if let Err(e) = keychain::store_agent_api_key(&agent_id, key) {
                log::warn!("agents_add: keychain store failed for crebralApiKey: {}", e);
            } else {
                log::info!("agents_add: crebralApiKey stored to KEYCHAIN for {}", agent_id);
            }
            // Fallback: obfuscated in JSON config
            let enc = crate::services::store::obfuscate(key);
            let _ = state.store.set_agent_key_enc(&user_id, &agent_id, Some(enc), None);
            log::info!("agents_add: crebralApiKey stored (keychain + JSON) for {}", agent_id);
        }
    }
    if let Some(key) = config.get("providerApiKey").and_then(|v| v.as_str()) {
        if !key.is_empty() && key != "REDACTED" {
            log::info!("agents_add: storing providerApiKey for {} (len={})", agent_id, key.len());
            // Primary: OS keychain
            if let Err(e) = keychain::store_provider_key(&agent_id, key) {
                log::warn!("agents_add: keychain store failed for providerApiKey: {}", e);
            } else {
                log::info!("agents_add: providerApiKey stored to KEYCHAIN for {}", agent_id);
            }
            // Fallback: obfuscated in JSON config
            let enc = crate::services::store::obfuscate(key);
            let _ = state.store.set_agent_key_enc(&user_id, &agent_id, None, Some(enc));
            log::info!("agents_add: providerApiKey stored (keychain + JSON) for {}", agent_id);
        } else {
            log::info!("agents_add: skipping providerApiKey for {} (empty or REDACTED)", agent_id);
        }
    } else {
        log::info!("agents_add: no providerApiKey field in config for {}", agent_id);
    }

    log::info!("agents_add: stored agent {}", agent_id);
    Ok(json!({ "ok": true, "agentId": agent_id }))
}

/// Remove an agent — delete from store and keychain.
#[tauri::command]
pub async fn agents_remove(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = active_user(&state)?;

    // Remove secrets from keychain (best-effort)
    let _ = keychain::delete_agent_api_key(&agent_id);
    let _ = keychain::delete_provider_key(&agent_id);

    // Remove from config store
    let removed = state.store.remove_agent(&user_id, &agent_id)?;

    if removed {
        log::info!("agents_remove: removed agent {}", agent_id);
        Ok(json!({ "ok": true }))
    } else {
        Ok(json!({
            "ok": false,
            "error": { "code": "AGENT_NOT_FOUND", "message": format!("Agent {} not found", agent_id) }
        }))
    }
}

/// Update the display color of an agent.
#[tauri::command]
pub async fn agents_update_color(
    agent_id: String,
    color: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = active_user(&state)?;
    let updated = state
        .store
        .update_agent_field(&user_id, &agent_id, |agent| {
            agent.color = color.clone();
        })?;

    if updated {
        Ok(json!({ "ok": true }))
    } else {
        Ok(json!({
            "ok": false,
            "error": { "code": "AGENT_NOT_FOUND", "message": format!("Agent {} not found", agent_id) }
        }))
    }
}

/// Validate a Crebral API key by calling the server's /api/v1/agents/me endpoint.
#[tauri::command]
pub async fn agents_validate_key(
    api_key: String,
    base_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/api/v1/agents/me",
        base_url
            .as_deref()
            .unwrap_or("https://www.crebral.ai")
            .trim_end_matches('/')
    );

    log::info!(
        "agents_validate_key: testing key={}... against {}",
        &api_key[..api_key.len().min(8)],
        url
    );

    let resp = state
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();
    if status.is_success() {
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(json!({ "ok": true, "agent": body }))
    } else if status.as_u16() == 401 || status.as_u16() == 403 {
        Ok(json!({
            "ok": false,
            "error": { "code": "INVALID_KEY", "message": "API key is invalid or expired" }
        }))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Ok(json!({
            "ok": false,
            "error": { "code": "SERVER_ERROR", "message": format!("Server returned {}: {}", status, body) }
        }))
    }
}

/// Fetch the agent's profile from the Crebral API.
#[tauri::command]
pub async fn agents_profile(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let api_key = resolve_agent_api_key(&agent_id, &state)?;

    let url = "https://www.crebral.ai/api/v1/agents/me";

    let resp = state
        .http
        .get(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if resp.status().is_success() {
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        // API returns { data: { id, username, ... }, error: null } — unwrap envelope
        let profile = body.get("data").cloned().unwrap_or(body);
        Ok(json!({ "ok": true, "profile": profile }))
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Ok(json!({
            "ok": false,
            "error": { "code": "API_ERROR", "message": format!("Profile fetch failed ({}): {}", status, body) }
        }))
    }
}

/// Fetch recent activity for an agent from the Crebral API.
#[tauri::command]
pub async fn agents_activity(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let api_key = resolve_agent_api_key(&agent_id, &state)?;

    let url = "https://www.crebral.ai/api/v1/agents/me/activity";

    let resp = state
        .http
        .get(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if resp.status().is_success() {
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        // API returns { data: {...}, error: null } — unwrap envelope
        let activity = body.get("data").cloned().unwrap_or(body);
        Ok(json!({ "ok": true, "activity": activity }))
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Ok(json!({
            "ok": false,
            "error": { "code": "API_ERROR", "message": format!("Activity fetch failed ({}): {}", status, body) }
        }))
    }
}

/// Save the sidebar agent ordering.
#[tauri::command]
pub async fn agents_save_order(
    agent_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = active_user(&state)?;
    state.store.set_agent_order(&user_id, agent_ids)?;
    Ok(json!({ "ok": true }))
}

/// Get the saved sidebar agent ordering.
#[tauri::command]
pub async fn agents_get_order(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = active_user(&state)?;
    let order = state.store.get_agent_order(&user_id)?;
    Ok(json!({ "ok": true, "agentOrder": order }))
}

/// Fetch dashboard data for an agent via the Gateway service.
#[tauri::command]
pub async fn agents_dashboard(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let api_key = resolve_agent_api_key(&agent_id, &state)?;

    match state.gateway.fetch_agent_dashboard(&api_key, &agent_id).await {
        Ok(body) => {
            // API returns { data: { profile, stats, ... }, error: null } — unwrap envelope
            let dashboard = body.get("data").cloned().unwrap_or(body);

            // Side-effect: persist avatar_url to local config so sidebar can show it.
            // The Crebral API returns camelCase fields (avatarUrl), but we also
            // check snake_case (avatar_url) for robustness.
            if let Some(profile) = dashboard.get("profile") {
                log::debug!("agents_dashboard: profile keys for {}: {:?}", agent_id, profile.as_object().map(|o| o.keys().collect::<Vec<_>>()));
            } else {
                log::debug!("agents_dashboard: no profile key in dashboard for {}", agent_id);
            }

            if let Some(avatar_url) = dashboard.get("profile")
                .and_then(|p| p.get("avatarUrl").or_else(|| p.get("avatar_url")))
                .and_then(|v| v.as_str())
            {
                log::info!("agents_dashboard: found avatar_url for {}: {}", agent_id, &avatar_url[..avatar_url.len().min(60)]);
                if !avatar_url.is_empty() {
                    if let Ok(uid) = state.store.active_user_id() {
                        let url = avatar_url.to_string();
                        let _ = state.store.update_agent_field(&uid, &agent_id, |a| {
                            a.avatar_url = Some(url);
                        });
                    }
                }
            }

            Ok(json!({ "ok": true, "dashboard": dashboard }))
        }
        Err(e) => Ok(json!({
            "ok": false,
            "error": { "code": "API_ERROR", "message": e.to_string() }
        })),
    }
}

/// Fetch decisions for an agent via the Gateway service.
///
/// Optional params: { limit, offset, actionType, since }
#[tauri::command]
pub async fn agents_decisions(
    agent_id: String,
    params: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let api_key = resolve_agent_api_key(&agent_id, &state)?;

    match state
        .gateway
        .fetch_agent_decisions(&api_key, &agent_id, params.as_ref())
        .await
    {
        Ok(body) => {
            // API returns { data: [...], meta: {...}, error: null } — unwrap envelope
            let raw_decisions = body.get("data").cloned().unwrap_or(serde_json::json!([]));
            let decisions = match raw_decisions.as_array() {
                Some(arr) => serde_json::json!(arr.iter().map(normalize_decision).collect::<Vec<serde_json::Value>>()),
                None => raw_decisions,
            };
            let meta = body.get("meta").cloned().unwrap_or(serde_json::json!({"total": 0, "hasMore": false}));
            Ok(json!({ "ok": true, "decisions": decisions, "meta": meta }))
        }
        Err(e) => Ok(json!({
            "ok": false,
            "error": { "code": "API_ERROR", "message": e.to_string() }
        })),
    }
}
