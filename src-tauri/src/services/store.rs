/// Persistent JSON config store — holds non-secret agent configs, settings, and agent ordering.
///
/// File location: {app_data_dir}/config.json
/// Atomic writes: write to .tmp then rename to prevent corruption.
///
/// Structure:
/// {
///   "accounts": {
///     "<userId>": {
///       "agents": [ { agentId, name, displayName, ... (no secrets) } ],
///       "settings": { heartbeatIntervalHours: 4, ... },
///       "agentOrder": ["id1", "id2"]
///     }
///   },
///   "activeUserId": "..."
/// }

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// ── Data Types ──────────────────────────────────────────────────────────────

/// Non-secret agent configuration stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub agent_id: String,
    pub name: String,
    pub display_name: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_enc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key_enc: Option<String>,
    /// Per-agent synaptogenesis interval in milliseconds (set from Brain settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
}

/// Simple obfuscation — base64 encode with marker prefix.
/// NOT cryptographic encryption — provides casual-read protection only.
/// TODO: Replace with AES-GCM encryption in a future release.
pub fn obfuscate(plaintext: &str) -> String {
    use base64::Engine;
    format!("ob1:{}", base64::engine::general_purpose::STANDARD.encode(plaintext))
}

pub fn deobfuscate(stored: &str) -> Option<String> {
    use base64::Engine;
    if let Some(encoded) = stored.strip_prefix("ob1:") {
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    } else {
        // Legacy plaintext — return as-is
        Some(stored.to_string())
    }
}

fn default_status() -> String {
    "active".to_string()
}
fn default_color() -> String {
    "#3CB371".to_string()
}

/// Per-account settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_interval")]
    pub heartbeat_interval_hours: f64,
    #[serde(default = "default_min_gap")]
    pub min_gap_ms: u64,
    #[serde(default)]
    pub auto_start_on_launch: bool,
    #[serde(default = "default_true")]
    pub show_notifications: bool,
    #[serde(default)]
    pub cron_secret: Option<String>,
    #[serde(default = "default_gateway")]
    pub gateway_url: String,
    /// Catch-all for unknown keys added by the frontend.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

fn default_interval() -> f64 {
    4.0
}
fn default_min_gap() -> u64 {
    15000
}
fn default_true() -> bool {
    true
}
fn default_gateway() -> String {
    "https://www.crebral.ai".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            heartbeat_interval_hours: default_interval(),
            min_gap_ms: default_min_gap(),
            auto_start_on_launch: false,
            show_notifications: true,
            cron_secret: None,
            gateway_url: default_gateway(),
            extra: HashMap::new(),
        }
    }
}

/// User profile info persisted locally for display (e.g. sidebar, settings).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    #[serde(default)]
    pub github_username: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub agent_limit: i64,
}

/// Per-account data bucket.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountData {
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub agent_order: Vec<String>,
    #[serde(default)]
    pub user_profile: Option<UserProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_token_enc: Option<String>,
}

/// Root-level store structure.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreData {
    #[serde(default)]
    pub accounts: HashMap<String, AccountData>,
    #[serde(default)]
    pub active_user_id: Option<String>,
}

// ── Store Service ───────────────────────────────────────────────────────────

pub struct Store {
    file_path: PathBuf,
    data: Mutex<StoreData>,
}

impl Store {
    /// Create a new Store pointed at `{app_data_dir}/config.json`.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let file_path = app_data_dir.join("config.json");
        let data = Self::load_from_disk(&file_path);
        Self {
            file_path,
            data: Mutex::new(data),
        }
    }

    /// Read store data from disk, returning default if file doesn't exist or is invalid.
    fn load_from_disk(path: &PathBuf) -> StoreData {
        match std::fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => StoreData::default(),
        }
    }

    /// Persist current data to disk atomically (write .tmp, then rename).
    fn flush(&self, data: &StoreData) -> Result<(), String> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
        }
        let tmp_path = self.file_path.with_extension("json.tmp");
        let contents = serde_json::to_string_pretty(data)
            .map_err(|e| format!("Failed to serialize config: {e}"))?;
        std::fs::write(&tmp_path, &contents)
            .map_err(|e| format!("Failed to write temp config: {e}"))?;
        std::fs::rename(&tmp_path, &self.file_path)
            .map_err(|e| format!("Failed to rename config: {e}"))?;
        Ok(())
    }

    // ── Active user helpers ─────────────────────────────────────────────────

    /// Get the active user ID, or an error if none is set.
    pub fn active_user_id(&self) -> Result<String, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        data.active_user_id
            .clone()
            .ok_or_else(|| "No active user — please log in first".to_string())
    }

    /// Set the active user ID.
    pub fn set_active_user_id(&self, user_id: Option<String>) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.active_user_id = user_id;
        self.flush(&data)
    }

    /// Ensure an account bucket exists for the given user.
    fn ensure_account(data: &mut StoreData, user_id: &str) {
        if !data.accounts.contains_key(user_id) {
            data.accounts.insert(user_id.to_string(), AccountData::default());
        }
    }

    // ── Agent CRUD ──────────────────────────────────────────────────────────

    /// Get all agent configs for a user.
    pub fn get_agents(&self, user_id: &str) -> Result<Vec<AgentConfig>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data
            .accounts
            .get(user_id)
            .map(|a| a.agents.clone())
            .unwrap_or_default())
    }

    /// Get a single agent config by ID.
    pub fn get_agent(&self, user_id: &str, agent_id: &str) -> Result<Option<AgentConfig>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data
            .accounts
            .get(user_id)
            .and_then(|a| a.agents.iter().find(|ag| ag.agent_id == agent_id).cloned()))
    }

    /// Add or update an agent config (upsert by agent_id).
    pub fn upsert_agent(&self, user_id: &str, agent: AgentConfig) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        Self::ensure_account(&mut data, user_id);
        let account = data.accounts.get_mut(user_id).unwrap();
        if let Some(existing) = account.agents.iter_mut().find(|a| a.agent_id == agent.agent_id) {
            *existing = agent;
        } else {
            account.agents.push(agent);
        }
        self.flush(&data)
    }

    /// Remove an agent config by ID.
    pub fn remove_agent(&self, user_id: &str, agent_id: &str) -> Result<bool, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        if let Some(account) = data.accounts.get_mut(user_id) {
            let before = account.agents.len();
            account.agents.retain(|a| a.agent_id != agent_id);
            // Also remove from agent order
            account.agent_order.retain(|id| id != agent_id);
            let removed = account.agents.len() < before;
            if removed {
                self.flush(&data)?;
            }
            Ok(removed)
        } else {
            Ok(false)
        }
    }

    /// Update a single field on an agent.
    pub fn update_agent_field(
        &self,
        user_id: &str,
        agent_id: &str,
        updater: impl FnOnce(&mut AgentConfig),
    ) -> Result<bool, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        if let Some(account) = data.accounts.get_mut(user_id) {
            if let Some(agent) = account.agents.iter_mut().find(|a| a.agent_id == agent_id) {
                updater(agent);
                self.flush(&data)?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    // ── Settings ────────────────────────────────────────────────────────────

    /// Get settings for a user (returns defaults if no account exists).
    pub fn get_settings(&self, user_id: &str) -> Result<Settings, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data
            .accounts
            .get(user_id)
            .map(|a| a.settings.clone())
            .unwrap_or_default())
    }

    /// Merge partial settings (from a serde_json::Value object) into stored settings.
    pub fn merge_settings(&self, user_id: &str, partial: &serde_json::Value) -> Result<Settings, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        Self::ensure_account(&mut data, user_id);
        let account = data.accounts.get_mut(user_id).unwrap();

        // Serialize current settings to Value, merge, deserialize back
        let mut current = serde_json::to_value(&account.settings).map_err(|e| e.to_string())?;
        if let (Some(base), Some(patch)) = (current.as_object_mut(), partial.as_object()) {
            for (k, v) in patch {
                base.insert(k.clone(), v.clone());
            }
        }
        let merged: Settings = serde_json::from_value(current).map_err(|e| e.to_string())?;
        account.settings = merged.clone();
        self.flush(&data)?;
        Ok(merged)
    }

    // ── Agent Order ─────────────────────────────────────────────────────────

    /// Get saved sidebar agent ordering.
    pub fn get_agent_order(&self, user_id: &str) -> Result<Vec<String>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data
            .accounts
            .get(user_id)
            .map(|a| a.agent_order.clone())
            .unwrap_or_default())
    }

    /// Save sidebar agent ordering.
    pub fn set_agent_order(&self, user_id: &str, order: Vec<String>) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        Self::ensure_account(&mut data, user_id);
        data.accounts.get_mut(user_id).unwrap().agent_order = order;
        self.flush(&data)
    }

    // ── User Profile ────────────────────────────────────────────────────────

    /// Get the user profile for an account.
    pub fn get_user_profile(&self, user_id: &str) -> Result<Option<UserProfile>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data
            .accounts
            .get(user_id)
            .and_then(|a| a.user_profile.clone()))
    }

    /// Save or update the user profile for an account.
    pub fn set_user_profile(&self, user_id: &str, profile: UserProfile) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        Self::ensure_account(&mut data, user_id);
        data.accounts.get_mut(user_id).unwrap().user_profile = Some(profile);
        self.flush(&data)
    }

    // ── Account Management ──────────────────────────────────────────────────

    /// List all account user IDs in the store.
    pub fn list_accounts(&self) -> Result<Vec<String>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data.accounts.keys().cloned().collect())
    }

    /// Update encrypted key fields on an agent config. Pass None to leave unchanged.
    pub fn set_agent_key_enc(
        &self,
        user_id: &str,
        agent_id: &str,
        api_key_enc: Option<String>,
        provider_key_enc: Option<String>,
    ) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let account = data.accounts.get_mut(user_id)
            .ok_or_else(|| format!("Account {} not found", user_id))?;

        if let Some(agent) = account.agents.iter_mut().find(|a| a.agent_id == agent_id) {
            if let Some(enc) = api_key_enc {
                agent.api_key_enc = Some(enc);
            }
            if let Some(enc) = provider_key_enc {
                agent.provider_key_enc = Some(enc);
            }
        }

        self.flush(&data)
    }

    /// Store obfuscated device token in JSON config (fallback for keychain).
    pub fn set_device_token_enc(&self, user_id: &str, token_enc: Option<String>) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let account = data.accounts.entry(user_id.to_string()).or_default();
        account.device_token_enc = token_enc;
        self.flush(&data)
    }

    /// Get obfuscated device token from JSON config.
    pub fn get_device_token_enc(&self, user_id: &str) -> Result<Option<String>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data.accounts.get(user_id).and_then(|a| a.device_token_enc.clone()))
    }

    /// Remove an account and all its data from the store.
    /// If the removed account was active, switches to the next available account.
    /// Returns the new active user ID (or None if no accounts remain).
    pub fn remove_account(&self, user_id: &str) -> Result<Option<String>, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.accounts.remove(user_id);

        // If we removed the active account, switch to next available or None
        if data.active_user_id.as_deref() == Some(user_id) {
            data.active_user_id = data.accounts.keys().next().cloned();
        }

        self.flush(&data)?;
        Ok(data.active_user_id.clone())
    }
}
