/// Models command handlers — static LLM provider/model catalog + API key validation.
///
/// Provides three commands:
///   - models_get_all_providers: full provider list with metadata
///   - models_get_for_provider: static model list for a given provider
///   - models_fetch_with_key: validate a provider API key and fetch available models

use serde_json::json;
use tauri::State;

use crate::state::AppState;

// ── Static provider catalog ─────────────────────────────────────────────────

/// Provider metadata — synced with @crebral/core PROVIDER_CONFIGS.
fn all_providers() -> serde_json::Value {
    json!([
        {
            "id": "anthropic",
            "name": "Anthropic",
            "baseUrl": "https://api.anthropic.com",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "anthropic"
        },
        {
            "id": "openai",
            "name": "OpenAI",
            "baseUrl": "https://api.openai.com/v1",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "openai"
        },
        {
            "id": "google",
            "name": "Google",
            "baseUrl": "https://generativelanguage.googleapis.com",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "google"
        },
        {
            "id": "deepseek",
            "name": "DeepSeek",
            "baseUrl": "https://api.deepseek.com/v1",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "deepseek"
        },
        {
            "id": "xai",
            "name": "xAI",
            "baseUrl": "https://api.x.ai/v1",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "xai"
        },
        {
            "id": "perplexity",
            "name": "Perplexity",
            "baseUrl": "https://api.perplexity.ai",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "perplexity"
        },
        {
            "id": "mistral",
            "name": "Mistral",
            "baseUrl": "https://api.mistral.ai/v1",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "mistral"
        },
        {
            "id": "manus",
            "name": "Manus",
            "baseUrl": "https://api.manus.im",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "manus"
        },
        {
            "id": "openrouter",
            "name": "OpenRouter",
            "baseUrl": "https://openrouter.ai/api/v1",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "openrouter"
        },
        {
            "id": "groq",
            "name": "Groq",
            "baseUrl": "https://api.groq.com/openai/v1",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "groq"
        },
        {
            "id": "ollama",
            "name": "Ollama (Local)",
            "baseUrl": "http://localhost:11434",
            "isDirect": true,
            "requiresApiKey": false,
            "icon": "ollama"
        },
        {
            "id": "kimi",
            "name": "Moonshot AI",
            "baseUrl": "https://api.moonshot.ai/v1",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "kimi"
        },
        {
            "id": "cohere",
            "name": "Cohere",
            "baseUrl": "https://api.cohere.com/v2",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "cohere"
        },
        {
            "id": "azure",
            "name": "Azure OpenAI",
            "baseUrl": "",
            "isDirect": true,
            "requiresApiKey": true,
            "icon": "azure"
        }
    ])
}

/// Static model lists per provider — synced with @crebral/core PROVIDER_CONFIGS.
/// Used as fallback when dynamic fetch from provider API isn't available.
fn static_models(provider_id: &str) -> serde_json::Value {
    match provider_id {
        "anthropic" => json!({
            "defaultModel": "claude-opus-4-6",
            "models": [
                { "id": "claude-opus-4-6", "name": "Claude Opus 4.6", "contextWindow": 200000 },
                { "id": "claude-sonnet-4-5-20250929", "name": "Claude Sonnet 4.5", "contextWindow": 200000 },
                { "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "contextWindow": 200000 }
            ]
        }),
        "openai" => json!({
            "defaultModel": "gpt-4.1",
            "models": [
                { "id": "gpt-4.1", "name": "GPT-4.1", "contextWindow": 1047576 },
                { "id": "gpt-4.1-mini", "name": "GPT-4.1 Mini", "contextWindow": 1047576 },
                { "id": "o3", "name": "o3", "contextWindow": 200000 },
                { "id": "o4-mini", "name": "o4-mini", "contextWindow": 200000 }
            ]
        }),
        "google" => json!({
            "defaultModel": "gemini-2.5-pro",
            "models": [
                { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "contextWindow": 1048576 },
                { "id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "contextWindow": 1048576 },
                { "id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash", "contextWindow": 1048576 },
                { "id": "gemini-2.0-flash-lite", "name": "Gemini 2.0 Flash Lite", "contextWindow": 1048576 }
            ]
        }),
        "deepseek" => json!({
            "defaultModel": "deepseek-chat",
            "models": [
                { "id": "deepseek-chat", "name": "DeepSeek Chat", "contextWindow": 64000 },
                { "id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "contextWindow": 64000 }
            ]
        }),
        "xai" => json!({
            "defaultModel": "grok-3",
            "models": [
                { "id": "grok-3", "name": "Grok 3", "contextWindow": 131072 },
                { "id": "grok-3-mini", "name": "Grok 3 Mini", "contextWindow": 131072 }
            ]
        }),
        "perplexity" => json!({
            "defaultModel": "sonar-pro",
            "models": [
                { "id": "sonar-pro", "name": "Sonar Pro", "contextWindow": 200000 },
                { "id": "sonar", "name": "Sonar", "contextWindow": 128000 },
                { "id": "sonar-reasoning-pro", "name": "Sonar Reasoning Pro", "contextWindow": 200000 }
            ]
        }),
        "mistral" => json!({
            "defaultModel": "mistral-large-latest",
            "models": [
                { "id": "mistral-large-latest", "name": "Mistral Large", "contextWindow": 128000 },
                { "id": "mistral-small-latest", "name": "Mistral Small", "contextWindow": 128000 },
                { "id": "codestral-latest", "name": "Codestral", "contextWindow": 256000 }
            ]
        }),
        "openrouter" => json!({
            "defaultModel": "anthropic/claude-opus-4-6",
            "models": [
                { "id": "anthropic/claude-opus-4-6", "name": "Claude Opus 4.6 (via OpenRouter)", "contextWindow": 200000 },
                { "id": "openai/gpt-4.1", "name": "GPT-4.1 (via OpenRouter)", "contextWindow": 1047576 },
                { "id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro (via OpenRouter)", "contextWindow": 1048576 }
            ]
        }),
        "groq" => json!({
            "defaultModel": "llama-3.3-70b-versatile",
            "models": [
                { "id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B", "contextWindow": 128000 },
                { "id": "llama-3.1-8b-instant", "name": "Llama 3.1 8B", "contextWindow": 128000 },
                { "id": "gemma2-9b-it", "name": "Gemma 2 9B", "contextWindow": 8192 }
            ]
        }),
        "ollama" => json!({
            "defaultModel": "llama3.1:8b",
            "models": [
                { "id": "llama3.1:8b", "name": "Llama 3.1 8B", "contextWindow": 128000 },
                { "id": "qwen2.5-coder:7b", "name": "Qwen 2.5 Coder 7B", "contextWindow": 32768 }
            ]
        }),
        // "kimi" is the Tauri provider ID; @crebral/core calls it "moonshotai"
        "kimi" | "moonshotai" => json!({
            "defaultModel": "kimi-k2-thinking-turbo",
            "models": [
                { "id": "kimi-k2-thinking-turbo", "name": "Kimi K2 Thinking Turbo", "contextWindow": 131072 }
            ]
        }),
        "manus" => json!({
            "defaultModel": "manus-1.6",
            "models": [
                { "id": "manus-1.6", "name": "Manus 1.6", "contextWindow": 128000 },
                { "id": "manus-1.6-lite", "name": "Manus 1.6 Lite", "contextWindow": 128000 },
                { "id": "manus-1.6-max", "name": "Manus 1.6 Max", "contextWindow": 128000 }
            ]
        }),
        "cohere" => json!({
            "defaultModel": "command-r-plus",
            "models": [
                { "id": "command-r-plus", "name": "Command R+", "contextWindow": 128000 },
                { "id": "command-r", "name": "Command R", "contextWindow": 128000 }
            ]
        }),
        "azure" => json!({
            "defaultModel": "gpt-4.1",
            "models": [
                { "id": "gpt-4.1", "name": "GPT-4.1 (Azure)", "contextWindow": 1047576 }
            ]
        }),
        _ => json!({
            "models": []
        }),
    }
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

/// Provider base URLs — synced with @crebral/core PROVIDER_CONFIGS.
fn provider_base_url(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "anthropic" => Some("https://api.anthropic.com"),
        "openai" => Some("https://api.openai.com"),
        "google" => Some("https://generativelanguage.googleapis.com"),
        "deepseek" => Some("https://api.deepseek.com"),
        "openrouter" => Some("https://openrouter.ai/api"),
        "perplexity" => Some("https://api.perplexity.ai"),
        "xai" => Some("https://api.x.ai"),
        "groq" => Some("https://api.groq.com/openai"),
        "mistral" => Some("https://api.mistral.ai"),
        "manus" => Some("https://api.manus.im"),
        "ollama" => Some("http://localhost:11434"),
        "kimi" | "moonshotai" => Some("https://api.moonshot.ai"),
        "cohere" => Some("https://api.cohere.com"),
        _ => None,
    }
}

/// Fetch models from a provider's API using the given API key.
/// Returns a list of model objects or falls back to the static list on failure.
async fn fetch_models_from_provider(
    client: &reqwest::Client,
    provider_id: &str,
    api_key: &str,
) -> Result<serde_json::Value, String> {
    let base_url = provider_base_url(provider_id)
        .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;

    let result = match provider_id {
        // OpenAI-compatible /v1/models endpoint
        "openai" | "deepseek" | "xai" | "groq" => {
            let url = format!("{base_url}/v1/models");
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            Some(json!({ "id": id, "name": id }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 401 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                Err(format!("Provider returned {status}: {body}"))
            }
        }

        // Perplexity returns models from all routed providers (anthropic/*, openai/*, etc.)
        // Filter to only Perplexity's own models which do NOT contain a `/` in their ID
        "perplexity" => {
            let url = format!("{base_url}/v1/models");
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            // Skip models from other providers (contain `/` like `anthropic/claude-3.5-sonnet`)
                            if id.contains('/') {
                                return None;
                            }
                            Some(json!({ "id": id, "name": id }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 401 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                Err(format!("Provider returned {status}: {body}"))
            }
        }

        // Anthropic uses a different models endpoint
        "anthropic" => {
            let url = format!("{base_url}/v1/models");
            let resp = client
                .get(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            let name = m
                                .get("display_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or(id);
                            Some(json!({ "id": id, "name": name }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 401 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                // Anthropic may not support /v1/models — fall back to static
                let static_data = static_models(provider_id);
                let models = static_data.get("models").cloned().unwrap_or(json!([]));
                Ok(json!({ "ok": true, "valid": true, "models": models, "source": "static" }))
            }
        }

        // Google Gemini — uses a different auth pattern (API key as query param)
        "google" => {
            let url = format!("{base_url}/v1beta/models?key={api_key}");
            let resp = client
                .get(&url)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("models").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let name = m.get("name")?.as_str()?;
                            let display = m
                                .get("displayName")
                                .and_then(|v| v.as_str())
                                .unwrap_or(name);
                            // Model name format: "models/gemini-2.0-flash" — extract the ID
                            let id = name.strip_prefix("models/").unwrap_or(name);
                            Some(json!({ "id": id, "name": display }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 400 || resp.status().as_u16() == 403 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                Err(format!("Google API returned {status}: {body}"))
            }
        }

        // OpenRouter — OpenAI-compatible /v1/models
        "openrouter" => {
            let url = format!("{base_url}/v1/models");
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                            Some(json!({ "id": id, "name": name }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 401 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                Err(format!("OpenRouter returned {status}: {body}"))
            }
        }

        // Ollama — no API key, just check if the server is running
        "ollama" => {
            let url = format!("{base_url}/api/tags");
            let resp = client
                .get(&url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("Ollama not reachable: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("models").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let name = m.get("name")?.as_str()?;
                            Some(json!({ "id": name, "name": name }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else {
                Err("Ollama server not responding".to_string())
            }
        }

        // Mistral — OpenAI-compatible
        "mistral" => {
            let url = format!("{base_url}/v1/models");
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            Some(json!({ "id": id, "name": id }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 401 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                Err(format!("Mistral returned {status}: {body}"))
            }
        }

        // Kimi/Moonshot — OpenAI-compatible
        "kimi" => {
            let url = format!("{base_url}/v1/models");
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            Some(json!({ "id": id, "name": id }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 401 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                let static_data = static_models(provider_id);
                let models = static_data.get("models").cloned().unwrap_or(json!([]));
                Ok(json!({ "ok": true, "valid": true, "models": models, "source": "static" }))
            }
        }

        // Cohere — uses a Bearer token, check models endpoint
        "cohere" => {
            let url = format!("{base_url}/v1/models");
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                if let Some(data) = body.get("models").and_then(|d| d.as_array()) {
                    let models: Vec<serde_json::Value> = data
                        .iter()
                        .filter_map(|m| {
                            let name = m.get("name")?.as_str()?;
                            Some(json!({ "id": name, "name": name }))
                        })
                        .collect();
                    Ok(json!({ "ok": true, "valid": true, "models": models }))
                } else {
                    Ok(json!({ "ok": true, "valid": true, "models": [] }))
                }
            } else if resp.status().as_u16() == 401 {
                Ok(json!({ "ok": true, "valid": false, "error": "Invalid API key" }))
            } else {
                let static_data = static_models(provider_id);
                let models = static_data.get("models").cloned().unwrap_or(json!([]));
                Ok(json!({ "ok": true, "valid": true, "models": models, "source": "static" }))
            }
        }

        // Unknown providers — fall back to static list
        _ => {
            let static_data = static_models(provider_id);
            let models = static_data.get("models").cloned().unwrap_or(json!([]));
            Ok(json!({ "ok": true, "valid": true, "models": models, "source": "static" }))
        }
    };

    // On error, fall back to static model list
    match result {
        Ok(v) => Ok(v),
        Err(msg) => {
            log::warn!("models_fetch_with_key: dynamic fetch failed for {provider_id}: {msg}");
            let static_data = static_models(provider_id);
            let models = static_data.get("models").cloned().unwrap_or(json!([]));
            Ok(json!({
                "ok": true,
                "valid": true,
                "models": models,
                "source": "static",
                "warning": msg
            }))
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Get all LLM providers with metadata.
#[tauri::command]
pub async fn models_get_all_providers(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    Ok(json!({
        "ok": true,
        "providers": all_providers()
    }))
}

/// Get the static model list for a specific provider.
#[tauri::command]
pub async fn models_get_for_provider(
    provider_id: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut result = static_models(&provider_id);
    if let Some(obj) = result.as_object_mut() {
        obj.insert("ok".to_string(), json!(true));
    }
    Ok(result)
}

/// Validate an API key and fetch available models from the provider.
/// Falls back to the static list if dynamic fetching fails.
#[tauri::command]
pub async fn models_fetch_with_key(
    provider_id: String,
    api_key: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("models_fetch_with_key: provider={}", provider_id);
    fetch_models_from_provider(&state.http, &provider_id, &api_key).await
}

/// Fetch models for an agent using its stored provider API key.
/// Resolves the real key from keychain/JSON — never exposes it to the frontend.
#[tauri::command]
pub async fn models_fetch_for_agent(
    agent_id: String,
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("models_fetch_for_agent: agent={}, provider={}", agent_id, provider_id);

    // Resolve provider key: keychain first, then JSON fallback
    let provider_key = crate::services::keychain::get_provider_key(&agent_id)
        .ok()
        .flatten()
        .or_else(|| {
            let uid = state.store.active_user_id().ok()?;
            let agent = state.store.get_agent(&uid, &agent_id).ok().flatten()?;
            agent.provider_key_enc.as_ref()
                .and_then(|enc| crate::services::store::deobfuscate(enc))
        });

    match provider_key {
        Some(key) => fetch_models_from_provider(&state.http, &provider_id, &key).await,
        None => {
            // No stored key — return static list
            let mut result = static_models(&provider_id);
            if let Some(obj) = result.as_object_mut() {
                obj.insert("ok".to_string(), serde_json::json!(true));
            }
            Ok(result)
        }
    }
}
