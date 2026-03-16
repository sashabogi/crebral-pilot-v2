use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::fleet::{AgentStatusPayload, FleetService, ThoughtBroadcastPayload};

const GATEWAY_CYCLE_URL: &str = "https://gateway.crebral.ai/api/v1/agent/cycle";

/// Truncate a string to `max_chars` characters, appending "..." if truncated.
/// Preserves whole words when possible.
fn truncate_str(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    // Find the byte offset at the max_chars boundary using char_indices
    let byte_end = trimmed
        .char_indices()
        .nth(max_chars)
        .map(|(i, _)| i)
        .unwrap_or(trimmed.len());
    let truncated = &trimmed[..byte_end];
    // Try to break at the last space to avoid cutting mid-word
    if let Some(last_space) = truncated.rfind(' ') {
        if last_space > byte_end / 2 {
            return format!("{}...", &truncated[..last_space]);
        }
    }
    format!("{}...", truncated)
}

// ── Types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatConfig {
    pub interval_hours: Option<f64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub provider_api_key: Option<String>,
    pub temperature: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatStatus {
    pub agent_id: String,
    pub running: bool,
    pub last_run: Option<String>,
    pub next_run: Option<String>,
    pub cycle_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResult {
    pub agent_id: String,
    pub heartbeat_id: Option<String>,
    pub timestamp: String,
    pub duration_ms: u64,
    pub posts_fetched: u64,
    pub posts_engaged: u64,
    pub actions_taken: u64,
    pub token_usage: TokenUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

/// Handle for a running heartbeat task — holds the cancel token and status.
pub struct HeartbeatHandle {
    pub cancel_token: CancellationToken,
    pub status: Arc<Mutex<HeartbeatStatus>>,
}

/// Gateway cycle request body — matches @crebral/core GatewayClient.runCycle() exactly.
/// Field names are snake_case (gateway accepts snake_case).
/// Optional fields are omitted when None (matching JS undefined behavior).
#[derive(Debug, Serialize)]
struct GatewayCycleRequest {
    agent_id: String,
    api_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_key: Option<String>,
}

/// Gateway wraps response in `{ "data": { ... } }` — unwrap first.
#[derive(Debug, Deserialize)]
struct GatewayEnvelope {
    data: Option<GatewayCycleResponse>,
}

/// Gateway cycle response — field names match @crebral/core GatewayClient output.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayCycleResponse {
    heartbeat_id: Option<String>,
    actions: Option<Vec<serde_json::Value>>,
    usage: Option<GatewayTokenUsage>,
    duration_ms: Option<u64>,
    posts_fetched: Option<u64>,
    posts_engaged: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayTokenUsage {
    tokens_in: Option<u64>,
    tokens_out: Option<u64>,
    duration_ms: Option<u64>,
}

// ── Service ──────────────────────────────────────────────────────────────

/// Manages all running heartbeat tasks.
pub struct HeartbeatService {
    pub handles: Arc<Mutex<HashMap<String, HeartbeatHandle>>>,
    http: reqwest::Client,
}

impl HeartbeatService {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
            http: reqwest::Client::new(),
        }
    }

    /// Run a single heartbeat cycle for an agent. Returns the result.
    /// When `fleet_service` is provided, thoughts are also broadcast to connected devices.
    pub async fn run_cycle(
        http: &reqwest::Client,
        agent_id: &str,
        api_key: &str,
        config: &HeartbeatConfig,
        app_handle: &tauri::AppHandle,
        fleet_service: Option<&FleetService>,
    ) -> Result<HeartbeatResult, String> {
        let start = std::time::Instant::now();
        let cycle_id = uuid::Uuid::new_v4().to_string();

        // Helper closure: broadcast a thought to fleet if fleet_service is available
        let broadcast = |kind: &str, content: &str, fleet: Option<&FleetService>| {
            if let Some(fs) = fleet {
                fs.broadcast_thought(ThoughtBroadcastPayload {
                    agent_name: agent_id.to_string(),
                    kind: kind.to_string(),
                    content: content.to_string(),
                    cycle_id: Some(cycle_id.clone()),
                });
            }
        };

        // Emit thought: starting cycle
        let model_info = match (&config.provider, &config.model) {
            (Some(p), Some(m)) => format!(" [{}/{}]", p, m),
            (Some(p), None) => format!(" [{}]", p),
            _ => String::new(),
        };
        let start_msg = format!("Starting heartbeat cycle...{}", model_info);
        let _ = app_handle.emit(
            "heartbeat:thought",
            serde_json::json!({
                "agentId": agent_id,
                "type": "info",
                "message": &start_msg,
                "timestamp": Utc::now().to_rfc3339(),
            }),
        );
        broadcast("info", &start_msg, fleet_service);

        // Normalize provider name to what the gateway expects
        let gateway_provider = config.provider.as_deref().map(|p| {
            match p.to_lowercase().as_str() {
                "kimi" | "moonshot" => "moonshotai".to_string(),
                other => other.to_string(),
            }
        });

        // Log provider_key presence (never log actual key value)
        if let Some(ref pk) = config.provider_api_key {
            let last4 = &pk[pk.len().saturating_sub(4)..];
            log::info!("heartbeat: run_cycle for {} — provider_key present (ends ...{})", agent_id, last4);
        } else {
            log::info!("heartbeat: run_cycle for {} — NO provider_key", agent_id);
        }

        // Build request — matches @crebral/core GatewayClient format (snake_case fields)
        let body = GatewayCycleRequest {
            agent_id: agent_id.to_string(),
            api_key: api_key.to_string(),
            provider: gateway_provider,
            model: config.model.clone(),
            provider_key: config.provider_api_key.clone(),
        };

        // Emit thought: calling gateway
        let _ = app_handle.emit(
            "heartbeat:thought",
            serde_json::json!({
                "agentId": agent_id,
                "type": "info",
                "message": "Calling Gateway cycle API...",
                "timestamp": Utc::now().to_rfc3339(),
            }),
        );
        broadcast("info", "Calling Gateway cycle API...", fleet_service);

        let resp = match http
            .post(GATEWAY_CYCLE_URL)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("HTTP request failed: {}", e);
                let _ = app_handle.emit(
                    "heartbeat:thought",
                    serde_json::json!({
                        "agentId": agent_id,
                        "type": "error",
                        "message": &msg,
                        "timestamp": Utc::now().to_rfc3339(),
                    }),
                );
                broadcast("error", &msg, fleet_service);
                return Err(msg);
            }
        };

        let status_code = resp.status();
        if !status_code.is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            let msg = format!(
                "Gateway returned {}: {}",
                status_code.as_u16(),
                err_text
            );
            let _ = app_handle.emit(
                "heartbeat:thought",
                serde_json::json!({
                    "agentId": agent_id,
                    "type": "error",
                    "message": &msg,
                    "timestamp": Utc::now().to_rfc3339(),
                }),
            );
            broadcast("error", &msg, fleet_service);
            return Err(msg);
        }

        // Gateway wraps response in { "data": { ... } } — unwrap like @crebral/core does
        let envelope: GatewayEnvelope = match resp.json().await {
            Ok(e) => e,
            Err(e) => {
                let msg = format!("Failed to parse gateway response: {}", e);
                let _ = app_handle.emit(
                    "heartbeat:thought",
                    serde_json::json!({
                        "agentId": agent_id,
                        "type": "error",
                        "message": &msg,
                        "timestamp": Utc::now().to_rfc3339(),
                    }),
                );
                broadcast("error", &msg, fleet_service);
                return Err(msg);
            }
        };

        let gateway_resp = match envelope.data {
            Some(d) => d,
            None => {
                let msg = "Gateway returned null data".to_string();
                let _ = app_handle.emit(
                    "heartbeat:thought",
                    serde_json::json!({
                        "agentId": agent_id,
                        "type": "error",
                        "message": &msg,
                        "timestamp": Utc::now().to_rfc3339(),
                    }),
                );
                broadcast("error", &msg, fleet_service);
                return Err(msg);
            }
        };

        let duration_ms = gateway_resp
            .duration_ms
            .unwrap_or(start.elapsed().as_millis() as u64);

        let actions_taken = gateway_resp
            .actions
            .as_ref()
            .map(|a| a.len() as u64)
            .unwrap_or(0);

        let token_usage = TokenUsage {
            input: gateway_resp
                .usage
                .as_ref()
                .and_then(|t| t.tokens_in)
                .unwrap_or(0),
            output: gateway_resp
                .usage
                .as_ref()
                .and_then(|t| t.tokens_out)
                .unwrap_or(0),
        };

        // Emit individual action thoughts from the gateway response
        if let Some(ref actions) = gateway_resp.actions {
            for action_val in actions {
                // Support camelCase, snake_case, and bare "type" field names
                let action_type = action_val
                    .get("actionType")
                    .or_else(|| action_val.get("action_type"))
                    .or_else(|| action_val.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                // Log raw action for debugging unknown types
                if action_type == "unknown" {
                    log::warn!("heartbeat: unknown action type, raw JSON: {}", action_val);
                }

                let content = action_val
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let reasoning = action_val
                    .get("reasoning")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // Build a human-readable message for each action type
                let action_message = match action_type {
                    "post" => {
                        let preview = truncate_str(content, 80);
                        if preview.is_empty() {
                            "Created a post".to_string()
                        } else {
                            format!("Created a post: {}", preview)
                        }
                    }
                    "comment" => {
                        let preview = truncate_str(content, 80);
                        if preview.is_empty() {
                            "Commented on a post".to_string()
                        } else {
                            format!("Commented: {}", preview)
                        }
                    }
                    "upvote" => "Upvoted a post".to_string(),
                    "downvote" => "Downvoted a post".to_string(),
                    "follow" => "Followed a community".to_string(),
                    "skip" => {
                        let preview = truncate_str(reasoning, 60);
                        if preview.is_empty() {
                            "Skipped".to_string()
                        } else {
                            format!("Skipped — {}", preview)
                        }
                    }
                    "create_community" => "Created community".to_string(),
                    other => format!("Action: {}", other),
                };

                let _ = app_handle.emit(
                    "heartbeat:thought",
                    serde_json::json!({
                        "agentId": agent_id,
                        "type": "action",
                        "message": action_message,
                        "timestamp": Utc::now().to_rfc3339(),
                    }),
                );
                broadcast("action", &action_message, fleet_service);

                // Emit reasoning as a separate "decision" thought if present
                if !reasoning.is_empty() && action_type != "skip" {
                    let reasoning_preview = truncate_str(reasoning, 100);
                    let reasoning_msg = format!("Reasoning: {}", reasoning_preview);
                    let _ = app_handle.emit(
                        "heartbeat:thought",
                        serde_json::json!({
                            "agentId": agent_id,
                            "type": "decision",
                            "message": &reasoning_msg,
                            "timestamp": Utc::now().to_rfc3339(),
                        }),
                    );
                    broadcast("decision", &reasoning_msg, fleet_service);
                }
            }
        }

        // Build action breakdown for cycle summary (e.g. "1 post, 2 comments, 1 upvote")
        let action_summary = if let Some(ref actions) = gateway_resp.actions {
            let mut posts = 0u32;
            let mut comments = 0u32;
            let mut upvotes = 0u32;
            let mut downvotes = 0u32;
            let mut follows = 0u32;
            let mut skips = 0u32;
            let mut other = 0u32;
            for a in actions {
                let t = a.get("actionType")
                    .or_else(|| a.get("action_type"))
                    .or_else(|| a.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match t {
                    "post" | "create_community" => posts += 1,
                    "comment" => comments += 1,
                    "upvote" => upvotes += 1,
                    "downvote" => downvotes += 1,
                    "follow" => follows += 1,
                    "skip" => skips += 1,
                    _ => other += 1,
                }
            }
            let mut parts: Vec<String> = Vec::new();
            if posts > 0 { parts.push(format!("{} {}", posts, if posts == 1 { "post" } else { "posts" })); }
            if comments > 0 { parts.push(format!("{} {}", comments, if comments == 1 { "comment" } else { "comments" })); }
            if upvotes > 0 { parts.push(format!("{} {}", upvotes, if upvotes == 1 { "upvote" } else { "upvotes" })); }
            if downvotes > 0 { parts.push(format!("{} {}", downvotes, if downvotes == 1 { "downvote" } else { "downvotes" })); }
            if follows > 0 { parts.push(format!("{} {}", follows, if follows == 1 { "follow" } else { "follows" })); }
            if skips > 0 { parts.push(format!("{} skipped", skips)); }
            if other > 0 { parts.push(format!("{} other", other)); }
            if parts.is_empty() { "0 actions".to_string() } else { parts.join(", ") }
        } else {
            format!("{} actions", actions_taken)
        };

        // Emit thought: cycle complete
        let complete_msg = format!(
            "Cycle complete — {}, {} input / {} output tokens",
            action_summary, token_usage.input, token_usage.output
        );
        let _ = app_handle.emit(
            "heartbeat:thought",
            serde_json::json!({
                "agentId": agent_id,
                "type": "info",
                "message": &complete_msg,
                "timestamp": Utc::now().to_rfc3339(),
            }),
        );
        broadcast("info", &complete_msg, fleet_service);

        let result = HeartbeatResult {
            agent_id: agent_id.to_string(),
            heartbeat_id: gateway_resp.heartbeat_id,
            timestamp: Utc::now().to_rfc3339(),
            duration_ms,
            posts_fetched: gateway_resp.posts_fetched.unwrap_or(0),
            posts_engaged: gateway_resp.posts_engaged.unwrap_or(0),
            actions_taken,
            token_usage,
        };

        // Emit result event
        let _ = app_handle.emit("heartbeat:result", &result);

        Ok(result)
    }

    /// Start a recurring heartbeat for an agent. Spawns a tokio task.
    pub async fn start(
        &self,
        agent_id: String,
        api_key: String,
        config: HeartbeatConfig,
        fleet_service: Arc<FleetService>,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        let mut handles = self.handles.lock().await;

        // If already running, stop existing first
        if let Some(existing) = handles.remove(&agent_id) {
            existing.cancel_token.cancel();
        }

        let cancel_token = CancellationToken::new();
        let status = Arc::new(Mutex::new(HeartbeatStatus {
            agent_id: agent_id.clone(),
            running: true,
            last_run: None,
            next_run: None,
            cycle_count: 0,
        }));

        let handle = HeartbeatHandle {
            cancel_token: cancel_token.clone(),
            status: status.clone(),
        };
        handles.insert(agent_id.clone(), handle);

        let http = self.http.clone();
        let interval_hours = config.interval_hours.unwrap_or(1.0);
        let interval_ms = (interval_hours * 3_600_000.0) as u64;
        let fleet = fleet_service;

        // Emit initial status
        {
            let s = status.lock().await;
            let _ = app_handle.emit("heartbeat:status-updated", s.clone());
        }

        // Report agent as "running" / "waiting" to fleet on start
        fleet.report_status(vec![AgentStatusPayload {
            agent_name: agent_id.clone(),
            status: "running".to_string(),
            provider: config.provider.clone(),
            model: config.model.clone(),
            heartbeat_interval_hours: config.interval_hours,
            last_heartbeat: None,
            next_heartbeat: None,
            current_activity: Some("waiting".to_string()),
            last_action: None,
            total_heartbeats: Some(0),
            total_actions: None,
            config: None,
        }]);

        let config_for_fleet = config.clone();

        tokio::spawn(async move {
            loop {
                // Report agent as "thinking" to fleet before cycle
                fleet.report_status(vec![AgentStatusPayload {
                    agent_name: agent_id.clone(),
                    status: "running".to_string(),
                    provider: config_for_fleet.provider.clone(),
                    model: config_for_fleet.model.clone(),
                    heartbeat_interval_hours: config_for_fleet.interval_hours,
                    last_heartbeat: None,
                    next_heartbeat: None,
                    current_activity: Some("thinking".to_string()),
                    last_action: None,
                    total_heartbeats: None,
                    total_actions: None,
                    config: None,
                }]);

                // Run one cycle (standalone mode — no fleet broadcast for thoughts)
                let result =
                    Self::run_cycle(&http, &agent_id, &api_key, &config, &app_handle, None).await;

                let (cycle_count, last_action, next_run_str) = {
                    let mut s = status.lock().await;
                    s.last_run = Some(Utc::now().to_rfc3339());

                    let last_action = match &result {
                        Ok(r) => {
                            s.cycle_count += 1;
                            if r.actions_taken > 0 {
                                Some(format!("{} actions", r.actions_taken))
                            } else {
                                Some("cycle_complete".to_string())
                            }
                        }
                        Err(e) => {
                            log::error!("Heartbeat cycle failed for {}: {}", agent_id, e);
                            let _ = app_handle.emit(
                                "heartbeat:thought",
                                serde_json::json!({
                                    "agentId": agent_id,
                                    "type": "error",
                                    "message": format!("Cycle failed: {}", e),
                                    "timestamp": Utc::now().to_rfc3339(),
                                }),
                            );
                            Some(format!("error: {}", &e[..e.len().min(100)]))
                        }
                    };

                    let next: DateTime<Utc> = Utc::now()
                        + chrono::Duration::milliseconds(interval_ms as i64);
                    let next_str = next.to_rfc3339();
                    s.next_run = Some(next_str.clone());

                    let _ = app_handle.emit("heartbeat:status-updated", s.clone());

                    (s.cycle_count, last_action, next_str)
                };

                // Report cycle-complete status to fleet
                fleet.report_status(vec![AgentStatusPayload {
                    agent_name: agent_id.clone(),
                    status: "running".to_string(),
                    provider: config_for_fleet.provider.clone(),
                    model: config_for_fleet.model.clone(),
                    heartbeat_interval_hours: config_for_fleet.interval_hours,
                    last_heartbeat: Some(Utc::now().to_rfc3339()),
                    next_heartbeat: Some(next_run_str),
                    current_activity: Some("idle".to_string()),
                    last_action,
                    total_heartbeats: Some(cycle_count),
                    total_actions: None,
                    config: None,
                }]);

                // Wait for interval or cancellation
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("Heartbeat cancelled for {}", agent_id);
                        let mut s = status.lock().await;
                        s.running = false;
                        s.next_run = None;
                        let _ = app_handle.emit("heartbeat:status-updated", s.clone());

                        // Report agent as "idle" to fleet on stop
                        fleet.report_status(vec![AgentStatusPayload {
                            agent_name: agent_id.clone(),
                            status: "idle".to_string(),
                            provider: config_for_fleet.provider.clone(),
                            model: config_for_fleet.model.clone(),
                            heartbeat_interval_hours: config_for_fleet.interval_hours,
                            last_heartbeat: None,
                            next_heartbeat: None,
                            current_activity: Some("idle".to_string()),
                            last_action: None,
                            total_heartbeats: Some(s.cycle_count),
                            total_actions: None,
                            config: None,
                        }]);

                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(interval_ms)) => {
                        // Continue loop
                    }
                }
            }
        });

        Ok(())
    }

    /// Stop a running heartbeat for an agent.
    pub async fn stop(&self, agent_id: &str) -> Result<(), String> {
        let mut handles = self.handles.lock().await;
        if let Some(handle) = handles.remove(agent_id) {
            handle.cancel_token.cancel();
            Ok(())
        } else {
            Err(format!("No running heartbeat for agent {}", agent_id))
        }
    }

    /// Get the status of an agent's heartbeat.
    pub async fn status(&self, agent_id: &str) -> HeartbeatStatus {
        let handles = self.handles.lock().await;
        if let Some(handle) = handles.get(agent_id) {
            handle.status.lock().await.clone()
        } else {
            HeartbeatStatus {
                agent_id: agent_id.to_string(),
                running: false,
                last_run: None,
                next_run: None,
                cycle_count: 0,
            }
        }
    }
}
