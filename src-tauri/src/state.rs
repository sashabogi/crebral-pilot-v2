use std::sync::Mutex;
use std::collections::HashMap;

/// Top-level application state, shared across all Tauri commands via AppHandle.
/// Fields are wrapped in Mutex for interior mutability from async command handlers.
/// Other workspace agents (heartbeat, coordinator, auth, fleet) will add their
/// own sub-state here as they are implemented.
pub struct AppState {
    /// Persisted app settings (synaptogenesis intervals, etc.)
    pub settings: Mutex<HashMap<String, serde_json::Value>>,

    /// Agent roster — persisted to disk by the agents service
    pub agents: Mutex<Vec<serde_json::Value>>,

    /// Running heartbeat status per agent ID
    pub heartbeat_statuses: Mutex<HashMap<String, serde_json::Value>>,

    /// Coordinator running flag
    pub coordinator_running: Mutex<bool>,

    /// Fleet registration state
    pub fleet_registered: Mutex<bool>,
    pub fleet_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(HashMap::new()),
            agents: Mutex::new(Vec::new()),
            heartbeat_statuses: Mutex::new(HashMap::new()),
            coordinator_running: Mutex::new(false),
            fleet_registered: Mutex::new(false),
            fleet_id: Mutex::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
