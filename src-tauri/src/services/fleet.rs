use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::coordinator::CoordinatorService;

const FLEET_BASE_URL: &str = "https://crebral.com/api/fleet";
const POLL_INTERVAL_SECS: u64 = 30;
const HEARTBEAT_INTERVAL_SECS: u64 = 10;

// ── Types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatus {
    pub is_registered: bool,
    pub fleet_id: Option<String>,
    pub device_token: Option<String>,
    pub is_heartbeat_running: bool,
    pub is_polling: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetDeviceInfo {
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
}

#[derive(Debug, Serialize)]
struct RegisterRequest {
    fleet_name: String,
    machine_id: String,
    hostname: Option<String>,
    os_platform: Option<String>,
    os_version: Option<String>,
    agent_count: usize,
    running_agent_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    moltfleet_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RegisterResponse {
    fleet_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    status: Option<String>,
}

#[derive(Debug, Serialize)]
struct HeartbeatRequest {
    fleet_id: String,
}

#[derive(Debug, Serialize)]
struct DisconnectRequest {
    fleet_id: String,
    device_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetCommand {
    pub id: Option<String>,
    pub command: String,
    pub agent_id: Option<String>,
    pub payload: Option<serde_json::Value>,
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandsResponse {
    commands: Option<Vec<FleetCommand>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetCommandEvent {
    pub command: FleetCommand,
    pub received_at: String,
}

/// Agent status payload for POST /api/fleet/status
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusPayload {
    pub agent_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heartbeat_interval_hours: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_heartbeat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_heartbeat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_heartbeats: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_actions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
}

/// Full orchestration state payload for POST /api/fleet/orchestration-state.
/// Sent on every coordinator state transition (start, agent-begin, agent-complete, stop).
#[derive(Debug, Clone, Serialize)]
pub struct OrchestrationStatePayload {
    pub is_running: bool,
    pub current_agent_name: Option<String>,
    pub next_agent_name: Option<String>,
    pub next_scheduled_at: Option<String>,
    pub queue_order: Vec<String>,
    pub paused_agents: Vec<String>,
    pub min_gap_ms: u64,
    pub total_cycles: u64,
    pub agent_cycle_counts: HashMap<String, u64>,
    pub last_completed_times: HashMap<String, String>,
    pub orchestrating_device_id: String,
    pub orchestrating_device_name: String,
    pub orchestrating_platform: String,
    pub cycle_started_at: Option<String>,
}

/// Thought broadcast payload for POST /api/fleet/thoughts/broadcast.
/// Fire-and-forget relay to all connected devices via Supabase Broadcast.
#[derive(Debug, Clone, Serialize)]
pub struct ThoughtBroadcastPayload {
    pub agent_name: String,
    pub kind: String,
    pub content: String,
    pub cycle_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct StatusReportRequest {
    fleet_id: String,
    agents: Vec<AgentStatusPayload>,
}

// ── Inner state ──────────────────────────────────────────────────────────

pub struct FleetInner {
    pub is_registered: bool,
    pub fleet_id: Option<String>,
    pub device_token: Option<String>,
    pub machine_id: Option<String>,
}

impl FleetInner {
    fn new() -> Self {
        Self {
            is_registered: false,
            fleet_id: None,
            device_token: None,
            machine_id: None,
        }
    }
}

// ── Service ──────────────────────────────────────────────────────────────

pub struct FleetService {
    pub inner: Arc<Mutex<FleetInner>>,
    poll_cancel: Arc<Mutex<Option<CancellationToken>>>,
    heartbeat_cancel: Arc<Mutex<Option<CancellationToken>>>,
    http: reqwest::Client,
}

impl FleetService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FleetInner::new())),
            poll_cancel: Arc::new(Mutex::new(None)),
            heartbeat_cancel: Arc::new(Mutex::new(None)),
            http: reqwest::Client::new(),
        }
    }

    /// Create a FleetService that shares inner state with another instance.
    /// Used to pass fleet registration context (fleet_id, device_token) to
    /// sub-services like coordinator and heartbeat without duplicating state.
    pub fn from_shared(inner: Arc<Mutex<FleetInner>>) -> Self {
        Self {
            inner,
            poll_cancel: Arc::new(Mutex::new(None)),
            heartbeat_cancel: Arc::new(Mutex::new(None)),
            http: reqwest::Client::new(),
        }
    }

    /// Generate a stable machine ID for this device.
    /// Uses a UUID stored in the fleet inner state, or generates a new one.
    pub fn get_or_create_machine_id() -> String {
        // Use the macOS IOPlatformUUID via sysctl as a stable machine identifier.
        // Falls back to a generated UUID if unavailable.
        #[cfg(target_os = "macos")]
        {
            if let Ok(output) = std::process::Command::new("ioreg")
                .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if line.contains("IOPlatformUUID") {
                        if let Some(uuid_part) = line.split('\"').nth(3) {
                            return uuid_part.to_string();
                        }
                    }
                }
            }
        }
        // Fallback: generate a persistent UUID (won't survive reinstall, but good enough)
        uuid::Uuid::new_v4().to_string()
    }

    /// Register this device with the fleet server.
    /// Uses x-api-key header with the device token for auth.
    pub async fn register(
        &self,
        device_token: String,
        device_info: FleetDeviceInfo,
        agent_ids: Vec<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<FleetStatus, String> {
        let machine_id = Self::get_or_create_machine_id();

        let body = RegisterRequest {
            fleet_name: format!("crebral-pilot-{}", &machine_id[..8.min(machine_id.len())]),
            machine_id: machine_id.clone(),
            hostname: Some(device_info.hostname.clone()),
            os_platform: Some(device_info.os.clone()),
            os_version: Some(device_info.arch.clone()),
            agent_count: agent_ids.len(),
            running_agent_count: 0,
            moltfleet_version: Some(device_info.app_version.clone()),
            metadata: Some(serde_json::json!({
                "client": "crebral-pilot",
                "version": device_info.app_version,
            })),
        };

        let resp = self
            .http
            .post(format!("{}/register", FLEET_BASE_URL))
            .header("x-api-key", &device_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Fleet register request failed: {}", e))?;

        let status_code = resp.status();
        if !status_code.is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Fleet register returned {}: {}",
                status_code.as_u16(),
                err_text
            ));
        }

        let register_resp: RegisterResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse fleet register response: {}", e))?;

        let fleet_id = register_resp.fleet_id.clone();

        {
            let mut inner = self.inner.lock().await;
            inner.is_registered = true;
            inner.fleet_id = fleet_id.clone();
            inner.device_token = Some(device_token.clone());
            inner.machine_id = Some(machine_id);
        }

        // Start polling for commands if we got a fleet_id
        if let Some(ref fid) = fleet_id {
            self.start_polling(fid.clone(), device_token.clone(), app_handle.clone())
                .await;
            // Start automatic heartbeat loop
            self.start_heartbeat_loop(fid.clone(), device_token.clone())
                .await;
        }

        log::info!("Fleet registered: fleet_id={:?}", fleet_id);

        Ok(self.status_snapshot(false).await)
    }

    /// Auto-register fleet on app startup (non-blocking).
    /// Resolves device token from keychain/store and registers if possible.
    pub async fn auto_register(
        fleet_service: Arc<FleetService>,
        store: &crate::services::Store,
        app_handle: tauri::AppHandle,
    ) {
        let user_id = match store.active_user_id() {
            Ok(uid) => uid,
            Err(_) => {
                log::debug!("Fleet auto-register: no active user, skipping");
                return;
            }
        };

        // Resolve device token: keychain first, then JSON config fallback
        let device_token = match super::keychain::get_device_token(&user_id) {
            Ok(Some(token)) => token,
            _ => {
                match store.get_device_token_enc(&user_id) {
                    Ok(Some(enc)) => match super::store::deobfuscate(&enc) {
                        Some(token) => token,
                        None => {
                            log::debug!("Fleet auto-register: no device token found");
                            return;
                        }
                    },
                    _ => {
                        log::debug!("Fleet auto-register: no device token found");
                        return;
                    }
                }
            }
        };

        // Collect agent IDs
        let agent_ids: Vec<String> = store
            .get_agents(&user_id)
            .unwrap_or_default()
            .iter()
            .map(|a| a.agent_id.clone())
            .collect();

        if agent_ids.is_empty() {
            log::debug!("Fleet auto-register: no agents, skipping");
            return;
        }

        // Gather device info
        let device_info = FleetDeviceInfo {
            hostname: get_hostname().unwrap_or_else(|| "unknown".to_string()),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        };

        match fleet_service
            .register(device_token, device_info, agent_ids.clone(), app_handle.clone())
            .await
        {
            Ok(status) => {
                log::info!(
                    "Fleet auto-registered: fleet_id={:?}",
                    status.fleet_id
                );

                // Immediately report status for all agents so other devices see them right away.
                // NOTE: These are placeholder times (now + agent interval). The coordinator
                // will re-report with accurate queue-position-aware timing when it starts.
                let agents_from_store = store.get_agents(&user_id).unwrap_or_default();
                let total_agents = agents_from_store.len();

                let payloads: Vec<AgentStatusPayload> = agents_from_store
                    .iter()
                    .enumerate()
                    .map(|(position, a)| {
                        let interval_hours = a.interval_ms
                            .map(|ms| ms as f64 / 3_600_000.0)
                            .unwrap_or(1.0);

                        // Use a default orchestration gap of 10 minutes (600_000ms) for initial report.
                        // The coordinator will override with the real min_gap_ms when it starts.
                        let default_gap_ms: i64 = 600_000;
                        let next = Utc::now() + chrono::Duration::milliseconds(default_gap_ms * (position as i64 + 1));

                        AgentStatusPayload {
                            agent_name: a.name.clone(),
                            status: "running".to_string(),
                            provider: Some(a.provider.clone()),
                            model: Some(a.model.clone()),
                            heartbeat_interval_hours: Some(interval_hours),
                            last_heartbeat: Some(Utc::now().to_rfc3339()),
                            next_heartbeat: Some(next.to_rfc3339()),
                            current_activity: Some(format!("queued ({} of {})", position + 1, total_agents)),
                            last_action: None,
                            total_heartbeats: Some(0),
                            total_actions: None,
                            config: Some(serde_json::json!({
                                "orchestration": true,
                                "queue_position": position + 1,
                                "total_agents": total_agents,
                                "min_gap_ms": default_gap_ms,
                                "mode": "orchestration"
                            })),
                        }
                    })
                    .collect();

                if !payloads.is_empty() {
                    log::info!("Fleet: reporting initial status for {} agents", payloads.len());
                    fleet_service.report_status(payloads);
                }
            }
            Err(e) => {
                log::warn!("Fleet auto-register failed (non-fatal): {}", e);
            }
        }
    }

    /// Disconnect from the fleet.
    pub async fn disconnect(&self) -> Result<(), String> {
        // Stop polling first
        self.stop_polling().await;
        // Stop heartbeat loop
        self.stop_heartbeat_loop().await;

        let (fleet_id, device_token) = {
            let inner = self.inner.lock().await;
            (inner.fleet_id.clone(), inner.device_token.clone())
        };

        if let (Some(fid), Some(dt)) = (fleet_id, device_token) {
            let body = DisconnectRequest {
                fleet_id: fid,
                device_token: dt.clone(),
            };

            let _ = self
                .http
                .post(format!("{}/disconnect", FLEET_BASE_URL))
                .header("x-api-key", &dt)
                .json(&body)
                .send()
                .await;
            // Don't fail on disconnect errors — just clean up locally
        }

        let mut inner = self.inner.lock().await;
        inner.is_registered = false;
        inner.fleet_id = None;
        inner.device_token = None;

        Ok(())
    }

    /// Get fleet status.
    pub async fn status_snapshot(&self, is_heartbeat_running: bool) -> FleetStatus {
        let inner = self.inner.lock().await;
        let is_polling = {
            let ct = self.poll_cancel.lock().await;
            ct.is_some()
        };
        FleetStatus {
            is_registered: inner.is_registered,
            fleet_id: inner.fleet_id.clone(),
            device_token: inner.device_token.clone(),
            is_heartbeat_running,
            is_polling,
        }
    }

    // ── Heartbeat loop (keeps device "online") ─────────────────────────────

    /// Start a background heartbeat loop that pings the server every 10 seconds.
    async fn start_heartbeat_loop(&self, fleet_id: String, device_token: String) {
        self.stop_heartbeat_loop().await;

        let cancel_token = CancellationToken::new();
        {
            let mut ct = self.heartbeat_cancel.lock().await;
            *ct = Some(cancel_token.clone());
        }

        let http = self.http.clone();

        tokio::spawn(async move {
            log::info!(
                "Fleet heartbeat loop started for fleet_id={}",
                fleet_id
            );

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("Fleet heartbeat loop cancelled");
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS)) => {
                        let body = HeartbeatRequest {
                            fleet_id: fleet_id.clone(),
                        };
                        match http
                            .post(format!("{}/heartbeat", FLEET_BASE_URL))
                            .header("x-api-key", &device_token)
                            .json(&body)
                            .send()
                            .await
                        {
                            Ok(resp) => {
                                if !resp.status().is_success() {
                                    log::warn!(
                                        "Fleet heartbeat returned {}",
                                        resp.status().as_u16()
                                    );
                                }
                            }
                            Err(e) => {
                                log::warn!("Fleet heartbeat failed: {}", e);
                            }
                        }
                    }
                }
            }
        });
    }

    /// Stop the background heartbeat loop.
    async fn stop_heartbeat_loop(&self) {
        let mut ct = self.heartbeat_cancel.lock().await;
        if let Some(token) = ct.take() {
            token.cancel();
        }
    }

    // ── Status reporting (fire-and-forget) ──────────────────────────────────

    /// Report agent status to the fleet server. Non-blocking — spawns a task.
    /// Does nothing if not registered.
    pub fn report_status(&self, agents: Vec<AgentStatusPayload>) {
        let inner = self.inner.clone();
        let http = self.http.clone();

        tokio::spawn(async move {
            let (fleet_id, device_token) = {
                let guard = inner.lock().await;
                match (&guard.fleet_id, &guard.device_token) {
                    (Some(fid), Some(dt)) => (fid.clone(), dt.clone()),
                    _ => return, // Not registered, skip silently
                }
            };

            let body = StatusReportRequest {
                fleet_id,
                agents,
            };

            match http
                .post(format!("{}/status", FLEET_BASE_URL))
                .header("x-api-key", &device_token)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        log::warn!(
                            "Fleet status report returned {}",
                            resp.status().as_u16()
                        );
                    }
                }
                Err(e) => {
                    log::warn!("Fleet status report failed: {}", e);
                }
            }
        });
    }

    // ── Orchestration state reporting (fire-and-forget) ────────────────────

    /// Report full orchestration state to the server.
    /// Called on every coordinator state transition.
    /// Fire-and-forget — errors logged but never block the coordinator.
    pub fn report_orchestration_state(&self, state: OrchestrationStatePayload) {
        let inner = self.inner.clone();
        let http = self.http.clone();
        tokio::spawn(async move {
            let (fleet_id, token) = {
                let guard = inner.lock().await;
                match (&guard.fleet_id, &guard.device_token) {
                    (Some(f), Some(t)) => (f.clone(), t.clone()),
                    _ => return, // Not registered, skip silently
                }
            };

            let body = serde_json::json!({
                "fleet_id": fleet_id,
                "state": state
            });

            let res = http
                .post(format!("{}/orchestration-state", FLEET_BASE_URL))
                .header("x-api-key", &token)
                .json(&body)
                .send()
                .await;

            if let Err(e) = res {
                log::warn!("Fleet orchestration state report failed: {}", e);
            }
        });
    }

    /// Broadcast a thought event to all connected devices.
    /// Fire-and-forget HTTP POST to /api/fleet/thoughts/broadcast.
    pub fn broadcast_thought(&self, thought: ThoughtBroadcastPayload) {
        let inner = self.inner.clone();
        let http = self.http.clone();
        tokio::spawn(async move {
            let (fleet_id, token) = {
                let guard = inner.lock().await;
                match (&guard.fleet_id, &guard.device_token) {
                    (Some(f), Some(t)) => (f.clone(), t.clone()),
                    _ => return,
                }
            };

            let body = serde_json::json!({
                "fleet_id": fleet_id,
                "thought": thought
            });

            let _ = http
                .post(format!("{}/thoughts/broadcast", FLEET_BASE_URL))
                .header("x-api-key", &token)
                .json(&body)
                .send()
                .await;
        });
    }

    // ── Command polling ─────────────────────────────────────────────────────

    /// Start background polling for fleet commands.
    async fn start_polling(
        &self,
        fleet_id: String,
        device_token: String,
        app_handle: tauri::AppHandle,
    ) {
        self.stop_polling().await;

        let cancel_token = CancellationToken::new();
        {
            let mut ct = self.poll_cancel.lock().await;
            *ct = Some(cancel_token.clone());
        }

        let http = self.http.clone();

        tokio::spawn(async move {
            log::info!("Fleet command polling started for fleet_id={}", fleet_id);

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("Fleet command polling cancelled");
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)) => {
                        match Self::poll_commands_once(&http, &fleet_id, &device_token).await {
                            Ok(commands) => {
                                for cmd in commands {
                                    log::info!("Fleet command received: {:?}", cmd.command);
                                    let _ = app_handle.emit(
                                        "fleet:command-received",
                                        FleetCommandEvent {
                                            command: cmd.clone(),
                                            received_at: Utc::now().to_rfc3339(),
                                        },
                                    );

                                    // Execute command locally
                                    let state = app_handle.state::<crate::state::AppState>();
                                    Self::execute_command(&cmd, &state.coordinator_service, &app_handle).await;

                                    // Acknowledge command on the server
                                    if let Some(ref cmd_id) = cmd.id {
                                        let ack_body = serde_json::json!({
                                            "command_id": cmd_id,
                                            "status": "completed"
                                        });
                                        let _ = http
                                            .post(format!("{}/commands", FLEET_BASE_URL))
                                            .header("x-api-key", &device_token)
                                            .json(&ack_body)
                                            .send()
                                            .await;
                                    }
                                }
                            }
                            Err(e) => {
                                log::warn!("Fleet command poll failed: {}", e);
                            }
                        }
                    }
                }
            }
        });
    }

    /// Stop background polling.
    async fn stop_polling(&self) {
        let mut ct = self.poll_cancel.lock().await;
        if let Some(token) = ct.take() {
            token.cancel();
        }
    }

    /// Poll for commands once.
    async fn poll_commands_once(
        http: &reqwest::Client,
        fleet_id: &str,
        device_token: &str,
    ) -> Result<Vec<FleetCommand>, String> {
        let resp = http
            .get(format!("{}/commands", FLEET_BASE_URL))
            .header("x-api-key", device_token)
            .query(&[("fleet_id", fleet_id)])
            .send()
            .await
            .map_err(|e| format!("Fleet commands request failed: {}", e))?;

        if !resp.status().is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("Fleet commands returned error: {}", err_text));
        }

        let commands_resp: CommandsResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse fleet commands response: {}", e))?;

        Ok(commands_resp.commands.unwrap_or_default())
    }

    /// Execute a fleet command by delegating to the coordinator.
    /// Called from the polling loop when commands are received.
    pub async fn execute_command(
        command: &FleetCommand,
        coordinator: &CoordinatorService,
        app_handle: &tauri::AppHandle,
    ) {
        match command.command.as_str() {
            "trigger_heartbeat" => {
                log::info!("Fleet: trigger_heartbeat command");
                // This starts the coordinator if not already running
                // The caller should handle starting with the heartbeat service
            }
            "pause_agent" => {
                if let Some(agent_id) = &command.agent_id {
                    log::info!("Fleet: pause_agent {}", agent_id);
                    coordinator.pause_agent(agent_id).await;
                    let status = coordinator.status().await;
                    let _ = app_handle.emit("coordinator:status-updated", status);
                }
            }
            "resume_agent" => {
                if let Some(agent_id) = &command.agent_id {
                    log::info!("Fleet: resume_agent {}", agent_id);
                    coordinator.resume_agent(agent_id).await;
                    let status = coordinator.status().await;
                    let _ = app_handle.emit("coordinator:status-updated", status);
                }
            }
            "stop_agent" => {
                if let Some(agent_id) = &command.agent_id {
                    log::info!("Fleet: stop_agent {}", agent_id);
                    coordinator.pause_agent(agent_id).await;
                    let status = coordinator.status().await;
                    let _ = app_handle.emit("coordinator:status-updated", status);
                }
            }
            "stop" | "stop_orchestration" => {
                log::info!("Fleet: stop coordinator command ({})", command.command);
                let _ = coordinator.stop().await;
                let status = coordinator.status().await;
                let _ = app_handle.emit("coordinator:status-updated", status);
            }
            other => {
                log::warn!("Fleet: unknown command '{}'", other);
            }
        }
    }
}

/// Get the system hostname.
pub fn get_hostname() -> Option<String> {
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
