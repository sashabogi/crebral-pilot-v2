/// Gateway service — HTTP client for the Crebral API (crebral.ai).
///
/// All authenticated requests use `Authorization: Bearer <device_token>`.
/// Agent-scoped requests use the per-agent API key instead.
///
/// Base URL: https://www.crebral.ai

use reqwest::Client;
use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://www.crebral.ai";
const USER_AGENT: &str = "Crebral-Pilot/2.0 (Tauri)";

// ── Response types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    #[serde(rename = "githubUsername")]
    pub github_username: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    pub tier: String,
    #[serde(rename = "agentLimit")]
    pub agent_limit: i64,
    #[serde(rename = "qualificationStatus", default)]
    pub qualification_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerAgent {
    pub id: String,
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub bio: Option<String>,
    pub status: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "keyAvailable", default)]
    pub key_available: bool,
    #[serde(rename = "llmProvider")]
    pub llm_provider: Option<String>,
    #[serde(rename = "llmModel")]
    pub llm_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountFullResponse {
    pub user: UserInfo,
    pub agents: Vec<ServerAgent>,
}

// ── Error handling ───────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum GatewayError {
    /// HTTP request failed (network error, DNS, timeout)
    Network(String),
    /// Server returned a non-2xx status code
    Http { status: u16, message: String },
    /// Response body couldn't be parsed
    Parse(String),
    /// 401 — token expired or invalid
    Unauthorized(String),
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GatewayError::Network(msg) => write!(f, "Network error: {msg}"),
            GatewayError::Http { status, message } => {
                write!(f, "HTTP {status}: {message}")
            }
            GatewayError::Parse(msg) => write!(f, "Parse error: {msg}"),
            GatewayError::Unauthorized(msg) => write!(f, "Unauthorized: {msg}"),
        }
    }
}

impl From<GatewayError> for String {
    fn from(e: GatewayError) -> String {
        e.to_string()
    }
}

// ── Gateway client ───────────────────────────────────────────────────────────

pub struct Gateway {
    client: Client,
}

impl Gateway {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// GET /api/v1/account/full — fetch user profile + agent list.
    /// Optionally regenerates all agent API keys if `regenerate_keys` is true.
    pub async fn get_full_account(
        &self,
        device_token: &str,
        regenerate_keys: bool,
    ) -> Result<AccountFullResponse, GatewayError> {
        let mut url = format!("{API_BASE}/api/v1/account/full");
        if regenerate_keys {
            url.push_str("?regenerateKeys=true");
        }

        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {device_token}"))
            .header("User-Agent", USER_AGENT)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| GatewayError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        if status == 401 {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"]["message"]
                .as_str()
                .unwrap_or("Authentication expired")
                .to_string();
            return Err(GatewayError::Unauthorized(msg));
        }

        if !resp.status().is_success() {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"]["message"]
                .as_str()
                .unwrap_or("Unknown error")
                .to_string();
            return Err(GatewayError::Http {
                status,
                message: msg,
            });
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| GatewayError::Parse(e.to_string()))?;

        // The server wraps the response in { data: { user, agents } }
        let data = &body["data"];
        let account: AccountFullResponse =
            serde_json::from_value(data.clone()).map_err(|e| GatewayError::Parse(e.to_string()))?;

        Ok(account)
    }

    /// POST /api/v1/account/agents/{agentId}/provision-key — generate a new API key for an agent.
    pub async fn provision_api_key(
        &self,
        device_token: &str,
        agent_id: &str,
    ) -> Result<String, GatewayError> {
        let url = format!("{API_BASE}/api/v1/account/agents/{agent_id}/provision-key");

        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {device_token}"))
            .header("User-Agent", USER_AGENT)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| GatewayError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        if status == 401 {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"]["message"]
                .as_str()
                .unwrap_or("Authentication expired")
                .to_string();
            return Err(GatewayError::Unauthorized(msg));
        }

        if !resp.status().is_success() {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"]["message"]
                .as_str()
                .unwrap_or("Key provisioning failed")
                .to_string();
            return Err(GatewayError::Http {
                status,
                message: msg,
            });
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| GatewayError::Parse(e.to_string()))?;

        // Server returns { data: { api_key: "mp_..." } } or { data: { apiKey: "mp_..." } }
        let key = body["data"]["api_key"]
            .as_str()
            .or_else(|| body["data"]["apiKey"].as_str())
            .ok_or_else(|| GatewayError::Parse("Missing api_key in response".to_string()))?
            .to_string();

        Ok(key)
    }

    /// GET /api/v1/agents/me/dashboard — fetch agent dashboard data.
    pub async fn fetch_agent_dashboard(
        &self,
        api_key: &str,
        agent_id: &str,
    ) -> Result<serde_json::Value, GatewayError> {
        let url = format!("{API_BASE}/api/v1/agents/me/dashboard");

        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("User-Agent", USER_AGENT)
            .header("X-Agent-Id", agent_id)
            .send()
            .await
            .map_err(|e| GatewayError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"]["message"]
                .as_str()
                .unwrap_or("Dashboard fetch failed")
                .to_string();
            return Err(GatewayError::Http {
                status,
                message: msg,
            });
        }

        resp.json()
            .await
            .map_err(|e| GatewayError::Parse(e.to_string()))
    }

    /// GET /api/v1/agents/me/decisions — fetch agent decisions.
    pub async fn fetch_agent_decisions(
        &self,
        api_key: &str,
        agent_id: &str,
        params: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, GatewayError> {
        let mut url = format!("{API_BASE}/api/v1/agents/me/decisions");

        // Append query params from the JSON object if provided
        if let Some(p) = params {
            if let Some(obj) = p.as_object() {
                let mut first = true;
                for (k, v) in obj {
                    let sep = if first { '?' } else { '&' };
                    first = false;
                    let val = match v {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    url.push_str(&format!("{sep}{k}={val}"));
                }
            }
        }

        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("User-Agent", USER_AGENT)
            .header("X-Agent-Id", agent_id)
            .send()
            .await
            .map_err(|e| GatewayError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"]["message"]
                .as_str()
                .unwrap_or("Decisions fetch failed")
                .to_string();
            return Err(GatewayError::Http {
                status,
                message: msg,
            });
        }

        resp.json()
            .await
            .map_err(|e| GatewayError::Parse(e.to_string()))
    }
}
