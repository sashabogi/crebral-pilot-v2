/// Auth command handlers — GitHub OAuth device flow, multi-account management,
/// and agent API key provisioning.
///
/// Auth flow:
/// 1. `auth_login` → opens crebral.ai/auth/electron in the default browser
/// 2. User completes GitHub OAuth → deep link callback `crebral://auth/callback?token=xxx`
/// 3. Deep link handler (in lib.rs) stores the device token in the OS keychain
/// 4. `auth_sync_account` → GET /api/v1/account/full with the device token
/// 5. `auth_sync_and_load` → sync + upsert agents into local store
///
/// Secrets are stored in the OS keychain via the keychain service.
/// Non-secret agent configs are stored in the JSON store via the store service.

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::services::{keychain, store::AgentConfig, store::UserProfile};
use crate::state::AppState;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Build the standard success envelope.
fn ok_response(data: serde_json::Value) -> serde_json::Value {
    json!({ "ok": true, "data": data })
}

/// Build the standard error envelope.
fn err_response(code: &str, message: &str) -> serde_json::Value {
    json!({ "ok": false, "error": { "code": code, "message": message } })
}

/// Build a `UserProfile` from the gateway response and persist it to the store.
fn save_user_profile(
    state: &AppState,
    user_id: &str,
    user: &crate::services::gateway::UserInfo,
) -> Result<(), String> {
    let profile = UserProfile {
        github_username: user.github_username.clone(),
        display_name: user.display_name.clone(),
        avatar_url: user.avatar_url.clone(),
        tier: user.tier.clone(),
        agent_limit: user.agent_limit,
    };
    state.store.set_user_profile(user_id, profile)
}

/// Get the device token for the active user, or return a formatted error.
fn get_active_token(state: &AppState) -> Result<(String, String), serde_json::Value> {
    let user_id = state
        .store
        .active_user_id()
        .map_err(|_| err_response("NOT_AUTHENTICATED", "No active account — please log in"))?;

    // Try keychain first
    let token = keychain::get_device_token(&user_id)
        .ok()
        .flatten();

    if let Some(t) = token {
        return Ok((user_id, t));
    }

    // Fall back to JSON config
    if let Ok(Some(enc)) = state.store.get_device_token_enc(&user_id) {
        if let Some(t) = crate::services::store::deobfuscate(&enc) {
            log::info!("[get_active_token] Recovered device token from JSON fallback for {}", user_id);
            // Re-store to keychain for next time
            let _ = keychain::store_device_token(&user_id, &t);
            return Ok((user_id, t));
        }
    }

    Err(err_response(
        "NOT_AUTHENTICATED",
        "Device token not found — please log in again",
    ))
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Open the crebral.ai OAuth page in the default browser.
/// The deep link handler (registered in lib.rs) will receive the callback.
#[tauri::command]
pub async fn auth_login(app: AppHandle) -> Result<serde_json::Value, String> {
    let url = "https://www.crebral.ai/auth/electron";

    // Use the opener plugin to open the URL in the default browser
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    log::info!("[auth_login] Opened browser for OAuth");
    Ok(ok_response(json!({ "opened": true })))
}

/// Sync the active account from the server (user profile + agent list).
/// Optionally regenerates all agent API keys.
#[tauri::command]
pub async fn auth_sync_account(
    regenerate_keys: Option<bool>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (user_id, token) = get_active_token(&state).map_err(|e| e.to_string())?;

    let account_data = state
        .gateway
        .get_full_account(&token, regenerate_keys.unwrap_or(false))
        .await
        .map_err(|e| {
            // If unauthorized, clear the token
            if matches!(e, crate::services::gateway::GatewayError::Unauthorized(_)) {
                let _ = keychain::delete_device_token(&user_id);
            }
            e.to_string()
        })?;

    // Upsert agents into the store — preserve locally-configured fields
    for server_agent in &account_data.agents {
        let existing = state.store.get_agent(&user_id, &server_agent.id).ok().flatten();
        let config = AgentConfig {
            agent_id: server_agent.id.clone(),
            name: server_agent.name.clone(),
            display_name: server_agent.display_name.clone(),
            status: server_agent.status.clone(),
            color: existing.as_ref().map(|e| e.color.clone()).unwrap_or_else(|| "#3CB371".to_string()),
            provider: existing
                .as_ref()
                .map(|e| e.provider.clone())
                .filter(|p| !p.is_empty())
                .or_else(|| server_agent.llm_provider.clone())
                .unwrap_or_default(),
            model: existing
                .as_ref()
                .map(|e| e.model.clone())
                .filter(|m| !m.is_empty())
                .or_else(|| server_agent.llm_model.clone())
                .unwrap_or_default(),
            bio: server_agent.bio.clone(),
            avatar_url: existing.as_ref().and_then(|e| e.avatar_url.clone()),
            api_key_enc: existing.as_ref().and_then(|e| e.api_key_enc.clone()),
            provider_key_enc: existing.as_ref().and_then(|e| e.provider_key_enc.clone()),
            interval_ms: existing.and_then(|e| e.interval_ms),
        };
        state.store.upsert_agent(&user_id, config)?;

        // If the server returned an API key (regenerateKeys=true), store it in keychain + JSON
        if let Some(ref api_key) = server_agent.api_key {
            let _ = keychain::store_agent_api_key(&server_agent.id, api_key);
            // JSON fallback
            let enc = crate::services::store::obfuscate(api_key);
            if let Err(e) = state.store.set_agent_key_enc(&user_id, &server_agent.id, Some(enc), None) {
                log::warn!("[auth_sync_account] Failed to persist key to JSON for {}: {}", server_agent.id, e);
            }
        }
    }

    log::info!(
        "[auth_sync_account] Synced {} agents for user {}",
        account_data.agents.len(),
        user_id
    );

    // Build response
    let agents_json: Vec<serde_json::Value> = account_data
        .agents
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "name": a.name,
                "displayName": a.display_name,
                "bio": a.bio,
                "status": a.status,
                "keyAvailable": a.key_available,
                "llmProvider": a.llm_provider,
                "llmModel": a.llm_model,
            })
        })
        .collect();

    Ok(ok_response(json!({
        "user": {
            "id": account_data.user.id,
            "githubUsername": account_data.user.github_username,
            "displayName": account_data.user.display_name,
            "avatarUrl": account_data.user.avatar_url,
            "tier": account_data.user.tier,
            "agentLimit": account_data.user.agent_limit,
        },
        "agents": agents_json,
    })))
}

/// Sync account, upsert agents into local store, and return full state.
/// This is the primary "load everything after login" command.
#[tauri::command]
pub async fn auth_sync_and_load(
    regenerate_keys: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let (user_id, token) = get_active_token(&state).map_err(|e| e.to_string())?;

    // 1. Fetch account data from server
    let account_data = state
        .gateway
        .get_full_account(&token, regenerate_keys.unwrap_or(true))
        .await
        .map_err(|e| {
            if matches!(e, crate::services::gateway::GatewayError::Unauthorized(_)) {
                let _ = keychain::delete_device_token(&user_id);
            }
            e.to_string()
        })?;

    log::info!(
        "[auth_sync_and_load] Got {} agent(s) from server for user {}",
        account_data.agents.len(),
        user_id
    );

    // 2. Upsert agents into store
    let mut new_count = 0u32;
    for server_agent in &account_data.agents {
        // Check if agent already exists
        let existing = state.store.get_agent(&user_id, &server_agent.id)?;
        if existing.is_none() {
            new_count += 1;
        }

        let config = AgentConfig {
            agent_id: server_agent.id.clone(),
            name: server_agent.name.clone(),
            display_name: server_agent.display_name.clone(),
            status: server_agent.status.clone(),
            color: existing
                .as_ref()
                .map(|e| e.color.clone())
                .unwrap_or_else(|| "#3CB371".to_string()),
            provider: existing
                .as_ref()
                .map(|e| e.provider.clone())
                .filter(|p| !p.is_empty())
                .or_else(|| server_agent.llm_provider.clone())
                .unwrap_or_default(),
            model: existing
                .as_ref()
                .map(|e| e.model.clone())
                .filter(|m| !m.is_empty())
                .or_else(|| server_agent.llm_model.clone())
                .unwrap_or_default(),
            bio: server_agent.bio.clone(),
            avatar_url: existing.as_ref().and_then(|e| e.avatar_url.clone()),
            api_key_enc: existing.as_ref().and_then(|e| e.api_key_enc.clone()),
            provider_key_enc: existing.as_ref().and_then(|e| e.provider_key_enc.clone()),
            interval_ms: existing.and_then(|e| e.interval_ms),
        };
        state.store.upsert_agent(&user_id, config)?;

        // Store API key in keychain + JSON if returned by server
        if let Some(ref api_key) = server_agent.api_key {
            let _ = keychain::store_agent_api_key(&server_agent.id, api_key);
            // JSON fallback
            let enc = crate::services::store::obfuscate(api_key);
            if let Err(e) = state.store.set_agent_key_enc(&user_id, &server_agent.id, Some(enc), None) {
                log::warn!("[auth_sync_and_load] Failed to persist key to JSON for {}: {}", server_agent.id, e);
            }
        }
    }

    log::info!(
        "[auth_sync_and_load] {} new agent(s) added, {} existing updated",
        new_count,
        account_data.agents.len() - new_count as usize
    );

    // 3. Provision API keys for agents that don't have one
    let all_agents = state.store.get_agents(&user_id)?;
    for agent in &all_agents {
        // Check keychain first (unwrap errors to None so one bad entry doesn't abort the loop)
        let has_keychain = keychain::get_agent_api_key(&agent.agent_id)
            .unwrap_or(None)
            .is_some();
        // Check JSON fallback
        let has_json = agent.api_key_enc.as_ref()
            .and_then(|enc| crate::services::store::deobfuscate(enc))
            .is_some();

        if has_keychain || has_json {
            // If key exists in JSON but not keychain, restore to keychain
            if !has_keychain && has_json {
                if let Some(key) = agent.api_key_enc.as_ref().and_then(|enc| crate::services::store::deobfuscate(enc)) {
                    let _ = keychain::store_agent_api_key(&agent.agent_id, &key);
                    log::info!("[auth_sync_and_load] Restored key from JSON to keychain for {}", agent.agent_id);
                }
            }
            continue;
        }

        // No key found anywhere — provision a new one
        match state
            .gateway
            .provision_api_key(&token, &agent.agent_id)
            .await
        {
            Ok(key) => {
                let _ = keychain::store_agent_api_key(&agent.agent_id, &key);
                // JSON fallback
                let enc = crate::services::store::obfuscate(&key);
                if let Err(e) = state.store.set_agent_key_enc(&user_id, &agent.agent_id, Some(enc), None) {
                    log::warn!("[auth_sync_and_load] Failed to persist provisioned key to JSON for {}: {}", agent.agent_id, e);
                }
                log::info!(
                    "[auth_sync_and_load] Provisioned key for {}",
                    agent.agent_id
                );
            }
            Err(e) => {
                log::warn!(
                    "[auth_sync_and_load] Failed to provision key for {}: {}",
                    agent.agent_id,
                    e
                );
            }
        }
    }

    // 4. Emit event so the frontend knows data is ready
    let _ = app.emit("auth:account-synced", json!({
        "userId": user_id,
        "agentCount": all_agents.len(),
    }));

    // 5. Return synced data
    let agents_json: Vec<serde_json::Value> = account_data
        .agents
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "name": a.name,
                "displayName": a.display_name,
                "bio": a.bio,
                "status": a.status,
                "keyAvailable": a.key_available,
                "llmProvider": a.llm_provider,
                "llmModel": a.llm_model,
            })
        })
        .collect();

    Ok(ok_response(json!({
        "user": {
            "id": account_data.user.id,
            "githubUsername": account_data.user.github_username,
            "displayName": account_data.user.display_name,
            "avatarUrl": account_data.user.avatar_url,
            "tier": account_data.user.tier,
            "agentLimit": account_data.user.agent_limit,
        },
        "agents": agents_json,
        "agentCount": all_agents.len(),
    })))
}

/// Provision (regenerate) an API key for a specific agent.
#[tauri::command]
pub async fn auth_provision_key(
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (_user_id, token) = get_active_token(&state).map_err(|e| e.to_string())?;

    let api_key = state
        .gateway
        .provision_api_key(&token, &agent_id)
        .await
        .map_err(|e| e.to_string())?;

    // Store the new key in keychain + JSON fallback
    keychain::store_agent_api_key(&agent_id, &api_key)?;
    let enc = crate::services::store::obfuscate(&api_key);
    if let Err(e) = state.store.set_agent_key_enc(&_user_id, &agent_id, Some(enc), None) {
        log::warn!("[auth_provision_key] Failed to persist key to JSON for {}: {}", agent_id, e);
    }

    log::info!("[auth_provision_key] Provisioned key for agent {}", agent_id);

    Ok(ok_response(json!({
        "agentId": agent_id,
        "apiKey": api_key,
    })))
}

/// Log out: clear the active account's credentials from keychain.
#[tauri::command]
pub async fn auth_logout(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let user_id = match state.store.active_user_id() {
        Ok(id) => id,
        Err(_) => {
            // Already logged out
            return Ok(json!({ "ok": true }));
        }
    };

    // Get all agent IDs for this user so we can clear their keychain entries
    let agents = state.store.get_agents(&user_id).unwrap_or_default();
    let agent_ids: Vec<String> = agents.iter().map(|a| a.agent_id.clone()).collect();

    // Clear all keychain entries (device token + agent keys)
    keychain::clear_all_for_user(&user_id, &agent_ids)?;
    // Also clear JSON fallback token
    let _ = state.store.set_device_token_enc(&user_id, None);

    // Remove account from store
    let remaining = {
        // Get all account user IDs first
        // We need to remove this user's account data from the store
        state.store.set_active_user_id(None)?;
        // Note: The store doesn't have a remove_account method yet,
        // so we just clear the active user. The account data stays
        // on disk but is inaccessible without the token.
        0u32
    };

    let _ = app.emit("auth:logged-out", json!({ "userId": user_id }));

    log::info!(
        "[auth_logout] Logged out user {}, {} account(s) remaining",
        user_id,
        remaining
    );

    Ok(json!({ "ok": true }))
}

/// Return the current authentication status.
#[tauri::command]
pub async fn auth_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let user_id = state.store.active_user_id().ok();

    let is_authenticated = if let Some(ref uid) = user_id {
        // Check keychain first, then JSON fallback
        keychain::get_device_token(uid).unwrap_or(None).is_some()
            || state.store.get_device_token_enc(uid).unwrap_or(None).is_some()
    } else {
        false
    };

    // Try to get user info from the store's agents (basic info)
    let user_info = if let Some(ref uid) = user_id {
        // We don't store full user info in the store, so return basic info
        Some(json!({
            "id": uid,
        }))
    } else {
        None
    };

    Ok(json!({
        "isAuthenticated": is_authenticated,
        "user": user_info,
        "activeAccountId": user_id,
    }))
}

/// List all stored accounts (without tokens).
#[tauri::command]
pub async fn auth_list_accounts(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let active_id = state.store.active_user_id().ok();

    // Get all account user IDs from the store
    let accounts = state.store.list_accounts()?;

    let accounts_json: Vec<serde_json::Value> = accounts
        .into_iter()
        .map(|uid| {
            // Check if this account has a valid token (keychain or JSON fallback)
            let has_token = keychain::get_device_token(&uid)
                .unwrap_or(None)
                .is_some()
                || state.store.get_device_token_enc(&uid).unwrap_or(None).is_some();
            json!({
                "userId": uid,
                "hasToken": has_token,
            })
        })
        .collect();

    Ok(json!({
        "accounts": accounts_json,
        "activeAccountId": active_id,
    }))
}

/// Switch the active account.
#[tauri::command]
pub async fn auth_switch_account(
    user_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    // Verify the account exists in the store
    let accounts = state.store.list_accounts()?;
    if !accounts.contains(&user_id) {
        return Ok(err_response(
            "ACCOUNT_NOT_FOUND",
            &format!("Account {} not found", user_id),
        ));
    }

    // Verify the account has a valid device token (keychain or JSON fallback)
    let has_token = keychain::get_device_token(&user_id)
        .unwrap_or(None)
        .is_some()
        || state.store.get_device_token_enc(&user_id).unwrap_or(None).is_some();
    if !has_token {
        return Ok(err_response(
            "NO_TOKEN",
            "Account has no device token — please log in again",
        ));
    }

    // Switch active user
    state.store.set_active_user_id(Some(user_id.clone()))?;

    let agent_count = state.store.get_agents(&user_id)?.len();

    let _ = app.emit("auth:account-switched", json!({ "userId": user_id }));

    log::info!(
        "[auth_switch_account] Switched to user {}, {} agent(s)",
        user_id,
        agent_count
    );

    Ok(ok_response(json!({
        "userId": user_id,
        "agentCount": agent_count,
    })))
}

/// Remove an account and its credentials. If it's the active account,
/// switches to the next available account (or sets active to null).
#[tauri::command]
pub async fn auth_remove_account(
    user_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let active_id = state.store.active_user_id().ok();
    let is_active = active_id.as_deref() == Some(&user_id);

    // Get all agent IDs for this user so we can clear their keychain entries
    let agents = state.store.get_agents(&user_id).unwrap_or_default();
    let agent_ids: Vec<String> = agents.iter().map(|a| a.agent_id.clone()).collect();

    // Clear all keychain entries for this user
    keychain::clear_all_for_user(&user_id, &agent_ids)?;

    // Remove the account from the store
    let new_active = state.store.remove_account(&user_id)?;

    if is_active {
        let _ = app.emit(
            "auth:account-switched",
            json!({ "userId": new_active }),
        );
    }

    log::info!(
        "[auth_remove_account] Removed account {}, new active: {:?}",
        user_id,
        new_active
    );

    Ok(ok_response(json!({
        "removed": user_id,
        "newActiveAccountId": new_active,
    })))
}

// ── Deep link handler ────────────────────────────────────────────────────────

/// Handle the `crebral://auth/callback?token=xxx` deep link.
/// Called from the deep link event handler in lib.rs.
pub async fn handle_auth_deep_link(
    url: &str,
    state: &AppState,
    app: &AppHandle,
) -> Result<(), String> {
    log::info!("[deep_link] Received auth callback (token redacted)");

    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    // Only handle crebral://auth/callback
    if parsed.host_str() != Some("auth") || parsed.path() != "/callback" {
        return Err("Not an auth callback URL".to_string());
    }

    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.to_string())
        .ok_or_else(|| "Missing token parameter".to_string())?;

    if !token.starts_with("cdt_") {
        let _ = app.emit(
            "auth:token-received",
            json!({ "success": false, "error": "Invalid token format" }),
        );
        return Err("Invalid token format — expected cdt_ prefix".to_string());
    }

    // Fetch user info to identify the account
    match state
        .gateway
        .get_full_account(&token, false)
        .await
    {
        Ok(account_data) => {
            let uid = &account_data.user.id;

            // Store device token in keychain
            keychain::store_device_token(uid, &token)?;
            // JSON fallback
            let token_enc = crate::services::store::obfuscate(&token);
            state.store.set_device_token_enc(uid, Some(token_enc))?;

            // Set as active user and ensure account bucket exists
            state.store.set_active_user_id(Some(uid.clone()))?;

            // Upsert agents from the sync response — preserve locally-configured fields
            for server_agent in &account_data.agents {
                let existing = state.store.get_agent(uid, &server_agent.id).ok().flatten();
                let config = AgentConfig {
                    agent_id: server_agent.id.clone(),
                    name: server_agent.name.clone(),
                    display_name: server_agent.display_name.clone(),
                    status: server_agent.status.clone(),
                    color: existing.as_ref().map(|e| e.color.clone()).unwrap_or_else(|| "#3CB371".to_string()),
                    provider: existing
                        .as_ref()
                        .map(|e| e.provider.clone())
                        .filter(|p| !p.is_empty())
                        .or_else(|| server_agent.llm_provider.clone())
                        .unwrap_or_default(),
                    model: existing
                        .as_ref()
                        .map(|e| e.model.clone())
                        .filter(|m| !m.is_empty())
                        .or_else(|| server_agent.llm_model.clone())
                        .unwrap_or_default(),
                    bio: server_agent.bio.clone(),
                    avatar_url: existing.as_ref().and_then(|e| e.avatar_url.clone()),
                    api_key_enc: existing.as_ref().and_then(|e| e.api_key_enc.clone()),
                    provider_key_enc: existing.as_ref().and_then(|e| e.provider_key_enc.clone()),
                    interval_ms: existing.and_then(|e| e.interval_ms),
                };
                state.store.upsert_agent(uid, config)?;

                if let Some(ref api_key) = server_agent.api_key {
                    let _ = keychain::store_agent_api_key(&server_agent.id, api_key);
                    // JSON fallback
                    let enc = crate::services::store::obfuscate(api_key);
                    if let Err(e) = state.store.set_agent_key_enc(uid, &server_agent.id, Some(enc), None) {
                        log::warn!("[deep_link] Failed to persist key to JSON for {}: {}", server_agent.id, e);
                    }
                }
            }

            log::info!(
                "[deep_link] Account added/updated for user {}, {} agents",
                uid,
                account_data.agents.len()
            );

            let _ = app.emit("auth:token-received", json!({ "success": true }));
        }
        Err(e) => {
            // Fallback: store token without user info — we'll need a user ID.
            // Generate a temporary one from the token hash.
            log::warn!("[deep_link] Failed to fetch user info: {e}. Storing token with temp ID.");

            // Use a hash of the token as a temporary user ID
            let temp_id = format!("temp_{:x}", {
                let mut hash: u64 = 0;
                for byte in token.as_bytes() {
                    hash = hash.wrapping_mul(31).wrapping_add(*byte as u64);
                }
                hash
            });

            keychain::store_device_token(&temp_id, &token)?;
            // JSON fallback
            let token_enc = crate::services::store::obfuscate(&token);
            let _ = state.store.set_device_token_enc(&temp_id, Some(token_enc));
            state.store.set_active_user_id(Some(temp_id))?;

            let _ = app.emit("auth:token-received", json!({ "success": true }));
        }
    }

    // Focus the main window
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    Ok(())
}
