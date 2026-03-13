use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::heartbeat::{HeartbeatConfig, HeartbeatService};

// ── Types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorStatus {
    pub is_running: bool,
    pub current_agent_id: Option<String>,
    pub next_agent_id: Option<String>,
    pub next_scheduled_at: Option<String>,
    pub queue: Vec<String>,
    pub paused_agent_ids: Vec<String>,
    pub min_gap_ms: u64,
    pub total_cycles: u64,
    pub agent_cycle_counts: HashMap<String, u64>,
    pub last_completed_times: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartEvent {
    pub agent_id: String,
    pub position: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompleteEvent {
    pub agent_id: String,
    pub result: serde_json::Value,
    pub next_agent: Option<String>,
}

/// Agent entry in the coordinator queue — holds config + API key.
#[derive(Debug, Clone)]
pub struct CoordinatorAgent {
    pub agent_id: String,
    pub api_key: String,
    pub config: HeartbeatConfig,
}

// ── Inner mutable state ──────────────────────────────────────────────────

pub struct CoordinatorInner {
    pub queue: Vec<CoordinatorAgent>,
    pub paused_agent_ids: Vec<String>,
    pub min_gap_ms: u64,
    pub current_index: usize,
    pub current_agent_id: Option<String>,
    pub next_scheduled_at: Option<String>,
    pub total_cycles: u64,
    pub agent_cycle_counts: HashMap<String, u64>,
    pub last_completed_times: HashMap<String, String>,
    pub is_running: bool,
}

impl CoordinatorInner {
    fn new() -> Self {
        Self {
            queue: Vec::new(),
            paused_agent_ids: Vec::new(),
            min_gap_ms: 300_000, // 5 minutes default
            current_index: 0,
            current_agent_id: None,
            next_scheduled_at: None,
            total_cycles: 0,
            agent_cycle_counts: HashMap::new(),
            last_completed_times: HashMap::new(),
            is_running: false,
        }
    }

    fn to_status(&self) -> CoordinatorStatus {
        let queue_ids: Vec<String> = self.queue.iter().map(|a| a.agent_id.clone()).collect();
        let next_agent_id = self.next_active_agent_id();
        CoordinatorStatus {
            is_running: self.is_running,
            current_agent_id: self.current_agent_id.clone(),
            next_agent_id,
            next_scheduled_at: self.next_scheduled_at.clone(),
            queue: queue_ids,
            paused_agent_ids: self.paused_agent_ids.clone(),
            min_gap_ms: self.min_gap_ms,
            total_cycles: self.total_cycles,
            agent_cycle_counts: self.agent_cycle_counts.clone(),
            last_completed_times: self.last_completed_times.clone(),
        }
    }

    /// Find the next non-paused agent starting from current_index.
    /// Wraps around if needed. Returns None if all paused or queue empty.
    fn next_active_agent(&self) -> Option<(usize, CoordinatorAgent)> {
        if self.queue.is_empty() {
            return None;
        }
        let len = self.queue.len();
        for offset in 0..len {
            let idx = (self.current_index + offset) % len;
            let agent = &self.queue[idx];
            if !self.paused_agent_ids.contains(&agent.agent_id) {
                return Some((idx, agent.clone()));
            }
        }
        None // All agents paused
    }

    fn next_active_agent_id(&self) -> Option<String> {
        self.next_active_agent().map(|(_, a)| a.agent_id)
    }
}

// ── Service ──────────────────────────────────────────────────────────────

pub struct CoordinatorService {
    pub inner: Arc<Mutex<CoordinatorInner>>,
    cancel_token: Arc<Mutex<Option<CancellationToken>>>,
}

impl CoordinatorService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CoordinatorInner::new())),
            cancel_token: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the agent queue. Called before start or to update the queue dynamically.
    pub async fn set_queue(&self, agents: Vec<CoordinatorAgent>) {
        let mut inner = self.inner.lock().await;
        inner.queue = agents;
        inner.current_index = 0;
    }

    /// Start the round-robin coordinator loop.
    pub async fn start(
        &self,
        _heartbeat_service: Arc<HeartbeatService>,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        let mut ct_guard = self.cancel_token.lock().await;

        // Cancel previous loop if any
        if let Some(old_ct) = ct_guard.take() {
            old_ct.cancel();
        }

        {
            let mut inner = self.inner.lock().await;
            if inner.queue.is_empty() {
                return Err("Cannot start coordinator — agent queue is empty".to_string());
            }
            inner.is_running = true;
            inner.current_index = 0;
        }

        let cancel_token = CancellationToken::new();
        *ct_guard = Some(cancel_token.clone());

        let inner = self.inner.clone();
        let http = reqwest::Client::new();

        // Emit initial status
        {
            let state = inner.lock().await;
            let _ = app_handle.emit("coordinator:status-updated", state.to_status());
        }

        tokio::spawn(async move {
            loop {
                // Get next agent
                let (idx, agent, min_gap_ms, total_active) = {
                    let state = inner.lock().await;
                    if !state.is_running {
                        break;
                    }
                    let total_active = state
                        .queue
                        .iter()
                        .filter(|a| !state.paused_agent_ids.contains(&a.agent_id))
                        .count();
                    match state.next_active_agent() {
                        Some((i, a)) => (i, a, state.min_gap_ms, total_active),
                        None => {
                            log::warn!("Coordinator: no active agents in queue, waiting...");
                            drop(state);
                            // Wait a bit and retry
                            tokio::select! {
                                _ = cancel_token.cancelled() => break,
                                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => continue,
                            }
                        }
                    }
                };

                // Update current agent
                {
                    let mut state = inner.lock().await;
                    state.current_agent_id = Some(agent.agent_id.clone());
                    state.next_scheduled_at = None; // Currently running, no "next" yet
                }

                // Emit agent-start event
                let _ = app_handle.emit(
                    "coordinator:agent-start",
                    AgentStartEvent {
                        agent_id: agent.agent_id.clone(),
                        position: idx + 1,
                        total: total_active,
                    },
                );

                // Run one heartbeat cycle
                let cycle_result = HeartbeatService::run_cycle(
                    &http,
                    &agent.agent_id,
                    &agent.api_key,
                    &agent.config,
                    &app_handle,
                )
                .await;

                // Determine next agent for the event
                let next_agent_id = {
                    let mut state = inner.lock().await;

                    // Only count successful cycles
                    if cycle_result.is_ok() {
                        state.total_cycles += 1;
                        *state
                            .agent_cycle_counts
                            .entry(agent.agent_id.clone())
                            .or_insert(0) += 1;
                        state
                            .last_completed_times
                            .insert(agent.agent_id.clone(), Utc::now().to_rfc3339());
                    }

                    // Always advance to next agent
                    state.current_index = (idx + 1) % state.queue.len().max(1);
                    state.current_agent_id = None;
                    state.next_active_agent_id()
                };

                // Emit agent-complete event
                let result_json = match &cycle_result {
                    Ok(r) => serde_json::to_value(r).unwrap_or(serde_json::json!(null)),
                    Err(e) => serde_json::json!({ "error": e }),
                };

                let _ = app_handle.emit(
                    "coordinator:agent-complete",
                    AgentCompleteEvent {
                        agent_id: agent.agent_id.clone(),
                        result: result_json,
                        next_agent: next_agent_id.clone(),
                    },
                );

                if let Err(e) = &cycle_result {
                    log::error!(
                        "Coordinator: cycle failed for agent {}: {}",
                        agent.agent_id,
                        e
                    );
                    // Continue to next agent — don't stop the loop
                }

                // In orchestration mode the coordinator controls pacing via min_gap.
                // Per-agent interval_hours is only relevant for single-agent mode
                // (HeartbeatService). Using the per-agent interval here would block
                // the entire round-robin queue when one agent has a long interval.
                let wait_ms = min_gap_ms;

                // Compute next fire time and emit updated coordinator status
                {
                    let mut state = inner.lock().await;
                    let next_at = Utc::now() + chrono::Duration::milliseconds(wait_ms as i64);
                    state.next_scheduled_at = Some(next_at.to_rfc3339());
                    let _ = app_handle.emit("coordinator:status-updated", state.to_status());
                }

                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("Coordinator loop cancelled");
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(wait_ms)) => {
                        // Continue to next agent
                    }
                }
            }

            // Cleanup
            let mut state = inner.lock().await;
            state.is_running = false;
            state.current_agent_id = None;
            state.next_scheduled_at = None;
            let _ = app_handle.emit("coordinator:status-updated", state.to_status());
            log::info!("Coordinator loop exited");
        });

        Ok(())
    }

    /// Stop the coordinator loop.
    pub async fn stop(&self) -> Result<(), String> {
        let mut ct_guard = self.cancel_token.lock().await;
        if let Some(ct) = ct_guard.take() {
            ct.cancel();
        }
        let mut inner = self.inner.lock().await;
        inner.is_running = false;
        inner.current_agent_id = None;
        inner.next_scheduled_at = None;
        Ok(())
    }

    /// Get current coordinator status.
    pub async fn status(&self) -> CoordinatorStatus {
        let inner = self.inner.lock().await;
        inner.to_status()
    }

    /// Set minimum gap between agent cycles.
    pub async fn set_min_gap(&self, ms: u64) {
        let mut inner = self.inner.lock().await;
        inner.min_gap_ms = ms;
    }

    /// Reorder the agent queue.
    pub async fn reorder(&self, agent_ids: Vec<String>) {
        let mut inner = self.inner.lock().await;
        let mut new_queue = Vec::new();
        for id in &agent_ids {
            if let Some(agent) = inner.queue.iter().find(|a| &a.agent_id == id) {
                new_queue.push(agent.clone());
            }
        }
        // Append any agents not in the new order (safety — don't lose agents)
        for agent in &inner.queue {
            if !agent_ids.contains(&agent.agent_id) {
                new_queue.push(agent.clone());
            }
        }
        inner.queue = new_queue;
        inner.current_index = 0;
    }

    /// Pause an agent — skip it during rotation.
    pub async fn pause_agent(&self, agent_id: &str) {
        let mut inner = self.inner.lock().await;
        if !inner.paused_agent_ids.contains(&agent_id.to_string()) {
            inner.paused_agent_ids.push(agent_id.to_string());
        }
    }

    /// Resume a paused agent.
    pub async fn resume_agent(&self, agent_id: &str) {
        let mut inner = self.inner.lock().await;
        inner.paused_agent_ids.retain(|id| id != agent_id);
    }
}
