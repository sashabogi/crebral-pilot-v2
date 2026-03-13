use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const GATEWAY_CYCLE_URL: &str = "https://gateway.crebral.ai/api/v1/agent/cycle";

/// Truncate a string to `max_chars` characters, appending "..." if truncated.
/// Preserves whole words when possible.
fn truncate_str(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    if trimmed.len() <= max_chars {
        return trimmed.to_string();
    }
    let truncated = &trimmed[..max_chars];
    // Try to break at the last space to avoid cutting mid-word
    if let Some(last_space) = truncated.rfind(' ') {
        if last_space > max_chars / 2 {
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
/// All fields always serialized (gateway validates presence, not just value).
#[derive(Debug, Serialize)]
struct GatewayCycleRequest {
    agent_id: String,
    api_key: String,
    provider: Option<String>,
    model: Option<String>,
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
    pub async fn run_cycle(
        http: &reqwest::Client,
        agent_id: &str,
        api_key: &str,
        config: &HeartbeatConfig,
        app_handle: &tauri::AppHandle,
    ) -> Result<HeartbeatResult, String> {
        let start = std::time::Instant::now();

        // Emit thought: starting cycle
        let model_info = match (&config.provider, &config.model) {
            (Some(p), Some(m)) => format!(" [{}/{}]", p, m),
            (Some(p), None) => format!(" [{}]", p),
            _ => String::new(),
        };
        let _ = app_handle.emit(
            "heartbeat:thought",
            serde_json::json!({
                "agentId": agent_id,
                "type": "info",
                "message": format!("Starting heartbeat cycle...{}", model_info),
                "timestamp": Utc::now().to_rfc3339(),
            }),
        );

        // Normalize provider name to what the gateway expects
        let gateway_provider = config.provider.as_deref().map(|p| {
            match p.to_lowercase().as_str() {
                "kimi" | "moonshot" => "moonshotai".to_string(),
                other => other.to_string(),
            }
        });

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

        let resp = http
            .post(GATEWAY_CYCLE_URL)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        let status_code = resp.status();
        if !status_code.is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Gateway returned {}: {}",
                status_code.as_u16(),
                err_text
            ));
        }

        // Gateway wraps response in { "data": { ... } } — unwrap like @crebral/core does
        let envelope: GatewayEnvelope = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse gateway response: {}", e))?;

        let gateway_resp = envelope
            .data
            .ok_or_else(|| "Gateway returned null data".to_string())?;

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
                // Support both camelCase (API) and snake_case field names
                let action_type = action_val
                    .get("actionType")
                    .or_else(|| action_val.get("action_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

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

                // Emit reasoning as a separate "decision" thought if present
                if !reasoning.is_empty() && action_type != "skip" {
                    let reasoning_preview = truncate_str(reasoning, 100);
                    let _ = app_handle.emit(
                        "heartbeat:thought",
                        serde_json::json!({
                            "agentId": agent_id,
                            "type": "decision",
                            "message": format!("Reasoning: {}", reasoning_preview),
                            "timestamp": Utc::now().to_rfc3339(),
                        }),
                    );
                }
            }
        }

        // Emit thought: cycle complete
        let _ = app_handle.emit(
            "heartbeat:thought",
            serde_json::json!({
                "agentId": agent_id,
                "type": "info",
                "message": format!(
                    "Cycle complete — {} actions, {} input / {} output tokens",
                    actions_taken, token_usage.input, token_usage.output
                ),
                "timestamp": Utc::now().to_rfc3339(),
            }),
        );

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

        // Emit initial status
        {
            let s = status.lock().await;
            let _ = app_handle.emit("heartbeat:status-updated", s.clone());
        }

        tokio::spawn(async move {
            loop {
                // Run one cycle
                let result =
                    Self::run_cycle(&http, &agent_id, &api_key, &config, &app_handle).await;

                {
                    let mut s = status.lock().await;
                    s.last_run = Some(Utc::now().to_rfc3339());

                    match &result {
                        Ok(_) => {
                            s.cycle_count += 1;
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
                        }
                    }

                    let next: DateTime<Utc> = Utc::now()
                        + chrono::Duration::milliseconds(interval_ms as i64);
                    s.next_run = Some(next.to_rfc3339());

                    let _ = app_handle.emit("heartbeat:status-updated", s.clone());
                }

                // Wait for interval or cancellation
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("Heartbeat cancelled for {}", agent_id);
                        let mut s = status.lock().await;
                        s.running = false;
                        s.next_run = None;
                        let _ = app_handle.emit("heartbeat:status-updated", s.clone());
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
