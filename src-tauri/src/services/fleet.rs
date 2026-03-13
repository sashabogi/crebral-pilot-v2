use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::coordinator::CoordinatorService;

const FLEET_BASE_URL: &str = "https://www.crebral.ai/api/v1/fleet";
const POLL_INTERVAL_SECS: u64 = 30;

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
#[serde(rename_all = "camelCase")]
struct RegisterRequest {
    device_token: String,
    device_info: FleetDeviceInfo,
    agent_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    fleet_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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

// ── Inner state ──────────────────────────────────────────────────────────

pub struct FleetInner {
    pub is_registered: bool,
    pub fleet_id: Option<String>,
    pub device_token: Option<String>,
}

impl FleetInner {
    fn new() -> Self {
        Self {
            is_registered: false,
            fleet_id: None,
            device_token: None,
        }
    }
}

// ── Service ──────────────────────────────────────────────────────────────

pub struct FleetService {
    pub inner: Arc<Mutex<FleetInner>>,
    poll_cancel: Arc<Mutex<Option<CancellationToken>>>,
    http: reqwest::Client,
}

impl FleetService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FleetInner::new())),
            poll_cancel: Arc::new(Mutex::new(None)),
            http: reqwest::Client::new(),
        }
    }

    /// Register this device with the fleet server.
    pub async fn register(
        &self,
        device_token: String,
        device_info: FleetDeviceInfo,
        agent_ids: Vec<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<FleetStatus, String> {
        let body = RegisterRequest {
            device_token: device_token.clone(),
            device_info,
            agent_ids,
        };

        let resp = self
            .http
            .post(format!("{}/register", FLEET_BASE_URL))
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
        }

        // Start polling for commands if we got a fleet_id
        if let Some(ref fid) = fleet_id {
            self.start_polling(fid.clone(), device_token.clone(), app_handle)
                .await;
        }

        Ok(self.status_snapshot(false).await)
    }

    /// Disconnect from the fleet.
    pub async fn disconnect(&self) -> Result<(), String> {
        // Stop polling first
        self.stop_polling().await;

        let (fleet_id, device_token) = {
            let inner = self.inner.lock().await;
            (inner.fleet_id.clone(), inner.device_token.clone())
        };

        if let (Some(fid), Some(dt)) = (fleet_id, device_token) {
            let body = DisconnectRequest {
                fleet_id: fid,
                device_token: dt,
            };

            let _ = self
                .http
                .post(format!("{}/disconnect", FLEET_BASE_URL))
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
                                            command: cmd,
                                            received_at: Utc::now().to_rfc3339(),
                                        },
                                    );
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
            .query(&[("fleetId", fleet_id), ("deviceToken", device_token)])
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
    #[allow(dead_code)]
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
            "stop" => {
                log::info!("Fleet: stop coordinator command");
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
