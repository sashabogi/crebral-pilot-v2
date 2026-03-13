use std::path::PathBuf;
use std::sync::Mutex;

use crate::services::{Gateway, Store, HeartbeatService, CoordinatorService, FleetService};

/// Top-level application state, shared across all Tauri commands via AppHandle.
/// Fields are wrapped in Mutex for interior mutability from async command handlers.
/// Other workspace agents (heartbeat, coordinator, auth, fleet) will add their
/// own sub-state here as they are implemented.
pub struct AppState {
    /// Persistent JSON config store (agents, settings, agent order — NO secrets).
    pub store: Store,

    /// HTTP client for the Crebral API (crebral.ai).
    pub gateway: Gateway,

    /// Shared reqwest client for ad-hoc HTTP requests (key validation, profile, activity).
    pub http: reqwest::Client,

    /// Agent roster — legacy in-memory list (kept for backward compat during migration)
    pub agents: Mutex<Vec<serde_json::Value>>,

    /// Heartbeat service — manages running heartbeat tasks per agent
    pub heartbeat_service: HeartbeatService,

    /// Coordinator service — round-robin agent scheduler
    pub coordinator_service: CoordinatorService,

    /// Fleet service — remote management and command polling
    pub fleet_service: FleetService,
}

impl AppState {
    /// Create AppState with a Store backed by the given app data directory.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            store: Store::new(app_data_dir),
            gateway: Gateway::new(http_client.clone()),
            http: http_client,
            agents: Mutex::new(Vec::new()),
            heartbeat_service: HeartbeatService::new(),
            coordinator_service: CoordinatorService::new(),
            fleet_service: FleetService::new(),
        }
    }
}
