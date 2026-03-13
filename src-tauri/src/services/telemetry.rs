/// Error telemetry — listens for `heartbeat:thought` events with `type: "error"`,
/// extracts structured error info, and POSTs to the Crebral telemetry endpoint.
///
/// Fire-and-forget: errors in the POST itself are logged at debug level and ignored.
/// Debounced: same agent+error_code pair is sent at most once per 5 minutes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::Mutex;

use crate::state::AppState;

const TELEMETRY_URL: &str = "https://gateway.crebral.ai/api/v1/telemetry/errors";
const DEBOUNCE_SECS: u64 = 300; // 5 minutes
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Telemetry payload sent to the backend.
#[derive(Debug, Serialize)]
struct ErrorTelemetry {
    agent_id: String,
    error_code: String,
    error_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    severity: String,
    category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggestion: Option<String>,
    app_version: String,
    timestamp: String,
}

/// Parsed Gateway error structure extracted from the JSON embedded in the error message.
struct ParsedGatewayError {
    code: String,
    message: String,
    category: String,
    severity: String,
    provider: Option<String>,
    model: Option<String>,
    suggestion: Option<String>,
}

/// Try to parse structured error JSON from a Gateway error message.
/// Expected format: "Gateway returned NNN: {\"data\":null,\"error\":{...}}"
fn parse_gateway_error(message: &str) -> Option<ParsedGatewayError> {
    // Find the JSON body after "Gateway returned NNN: "
    let json_start = message.find(": {")?;
    let json_str = &message[json_start + 2..];

    let parsed: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let error_obj = parsed.get("error")?;

    let code = error_obj
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN")
        .to_string();

    let msg = error_obj
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let category = error_obj
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let severity = error_obj
        .get("severity")
        .and_then(|v| v.as_str())
        .unwrap_or("medium")
        .to_string();

    let provider = error_obj
        .get("provider")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let model = error_obj
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let suggestion = error_obj
        .get("suggestion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(ParsedGatewayError {
        code,
        message: msg,
        category,
        severity,
        provider,
        model,
        suggestion,
    })
}

/// Classify an unstructured error message into a category and severity.
fn classify_raw_error(message: &str) -> (&'static str, &'static str, &'static str) {
    let lower = message.to_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        ("TIMEOUT", "timeout", "medium")
    } else if lower.contains("401") || lower.contains("unauthorized") || lower.contains("auth") {
        ("AUTH_ERROR", "auth", "high")
    } else if lower.contains("429") || lower.contains("rate limit") {
        ("RATE_LIMIT", "rate_limit", "medium")
    } else if lower.contains("500") || lower.contains("502") || lower.contains("503") {
        ("SERVER_ERROR", "server", "high")
    } else if lower.contains("network") || lower.contains("dns") || lower.contains("connect") {
        ("NETWORK_ERROR", "network", "medium")
    } else if lower.contains("parse") || lower.contains("json") {
        ("PARSE_ERROR", "parse", "low")
    } else {
        ("UNKNOWN_ERROR", "unknown", "medium")
    }
}

/// Register the telemetry event listener on the app handle.
/// Call this once during app setup.
pub fn setup(app_handle: &AppHandle) {
    let handle = app_handle.clone();
    let debounce_map: Arc<Mutex<HashMap<String, Instant>>> =
        Arc::new(Mutex::new(HashMap::new()));

    app_handle.listen("heartbeat:thought", move |event| {
        let payload_str = event.payload();

        // Parse the event payload
        let payload: serde_json::Value = match serde_json::from_str(payload_str) {
            Ok(v) => v,
            Err(_) => return,
        };

        // Only process error events
        if payload.get("type").and_then(|v| v.as_str()) != Some("error") {
            return;
        }

        let agent_id = match payload.get("agentId").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => return,
        };

        let message = match payload.get("message").and_then(|v| v.as_str()) {
            Some(m) => m.to_string(),
            None => return,
        };

        let timestamp = payload
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let handle = handle.clone();
        let debounce_map = debounce_map.clone();

        tauri::async_runtime::spawn(async move {
            // Build the telemetry payload — try structured parse first, fall back to classification
            let telemetry = if let Some(parsed) = parse_gateway_error(&message) {
                ErrorTelemetry {
                    agent_id: agent_id.clone(),
                    error_code: parsed.code.clone(),
                    error_message: parsed.message,
                    provider: parsed.provider,
                    model: parsed.model,
                    severity: parsed.severity,
                    category: parsed.category,
                    suggestion: parsed.suggestion,
                    app_version: APP_VERSION.to_string(),
                    timestamp: timestamp.clone(),
                }
            } else {
                let (code, category, severity) = classify_raw_error(&message);
                ErrorTelemetry {
                    agent_id: agent_id.clone(),
                    error_code: code.to_string(),
                    error_message: message.clone(),
                    provider: None,
                    model: None,
                    severity: severity.to_string(),
                    category: category.to_string(),
                    suggestion: None,
                    app_version: APP_VERSION.to_string(),
                    timestamp: timestamp.clone(),
                }
            };

            // Debounce: skip if we sent the same agent+error_code within 5 minutes
            let debounce_key = format!("{}:{}", telemetry.agent_id, telemetry.error_code);
            {
                let mut map = debounce_map.lock().await;
                let now = Instant::now();
                if let Some(last_sent) = map.get(&debounce_key) {
                    if now.duration_since(*last_sent).as_secs() < DEBOUNCE_SECS {
                        log::debug!(
                            "[telemetry] Debounced error {} for agent {}",
                            telemetry.error_code,
                            telemetry.agent_id
                        );
                        return;
                    }
                }
                map.insert(debounce_key, now);
            }

            // Fire-and-forget POST — use the shared HTTP client from AppState
            let state = handle.state::<AppState>();
            let http = &state.http;

            log::debug!(
                "[telemetry] Sending error report: code={}, agent={}",
                telemetry.error_code,
                telemetry.agent_id
            );

            match http.post(TELEMETRY_URL).json(&telemetry).send().await {
                Ok(resp) => {
                    log::debug!(
                        "[telemetry] POST completed with status {}",
                        resp.status()
                    );
                }
                Err(e) => {
                    log::debug!("[telemetry] POST failed (non-fatal): {}", e);
                }
            }
        });
    });
}
