/// Keychain service — wraps the `keyring` crate for OS-level secret storage.
/// Secrets (API keys, tokens) are NEVER stored in the JSON config file.
///
/// Key naming convention:
///   com.crebral.pilot:device_token_{userId}          — device auth token
///   com.crebral.pilot:api_key_{agentId}              — per-agent Crebral API key
///   com.crebral.pilot:provider_key_{agentId}         — per-agent LLM provider key

const SERVICE_NAME: &str = "com.crebral.pilot";

// ── Low-level helpers ────────────────────────────────────────────────────────

/// Store a secret in the OS keychain by raw key name.
pub fn store_raw(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

/// Retrieve a secret from the OS keychain by raw key name. Returns None if not found.
pub fn get_raw(key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(val) => Ok(Some(val)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret from the OS keychain by raw key name. Silently succeeds if not found.
pub fn delete_raw(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Device token (user-level) ────────────────────────────────────────────────

pub fn store_device_token(user_id: &str, token: &str) -> Result<(), String> {
    store_raw(&format!("device_token_{user_id}"), token)
}

pub fn get_device_token(user_id: &str) -> Result<Option<String>, String> {
    get_raw(&format!("device_token_{user_id}"))
}

pub fn delete_device_token(user_id: &str) -> Result<(), String> {
    delete_raw(&format!("device_token_{user_id}"))
}

// ── Agent API key (crebral platform key) ─────────────────────────────────────

pub fn store_agent_api_key(agent_id: &str, key: &str) -> Result<(), String> {
    store_raw(&format!("api_key_{agent_id}"), key)
}

pub fn get_agent_api_key(agent_id: &str) -> Result<Option<String>, String> {
    get_raw(&format!("api_key_{agent_id}"))
}

pub fn delete_agent_api_key(agent_id: &str) -> Result<(), String> {
    delete_raw(&format!("api_key_{agent_id}"))
}

// ── Provider API key (LLM provider key per agent) ────────────────────────────

pub fn store_provider_key(agent_id: &str, key: &str) -> Result<(), String> {
    store_raw(&format!("provider_key_{agent_id}"), key)
}

pub fn get_provider_key(agent_id: &str) -> Result<Option<String>, String> {
    get_raw(&format!("provider_key_{agent_id}"))
}

pub fn delete_provider_key(agent_id: &str) -> Result<(), String> {
    delete_raw(&format!("provider_key_{agent_id}"))
}

// ── Bulk operations ──────────────────────────────────────────────────────────

/// Clear all keychain entries for a user: device token + all agent keys.
/// `agent_ids` should be the list of agents associated with this user.
pub fn clear_all_for_user(user_id: &str, agent_ids: &[String]) -> Result<(), String> {
    delete_device_token(user_id)?;
    for agent_id in agent_ids {
        // Best-effort: delete both key types, ignore individual errors
        let _ = delete_agent_api_key(agent_id);
        let _ = delete_provider_key(agent_id);
    }
    Ok(())
}
