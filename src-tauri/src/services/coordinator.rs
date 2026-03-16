use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::fleet::{AgentStatusPayload, FleetService, OrchestrationStatePayload, get_hostname};
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

    /// Build fleet status payloads for all agents in the queue.
    /// Calculates REAL next_heartbeat per agent based on queue position relative to current_index,
    /// not the naive `now + interval` which is wrong for orchestration mode.
    fn build_agent_status_payloads(
        &self,
        override_status: Option<&str>,
        override_activity: Option<&str>,
        active_agent_id: Option<&str>,
        active_activity: Option<&str>,
    ) -> Vec<AgentStatusPayload> {
        let total_agents = self.queue.len();
        let gap_ms = self.min_gap_ms as i64;
        // Base time: either the next_scheduled_at (if waiting between agents) or now
        let base_time = self
            .next_scheduled_at
            .as_ref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);

        self.queue
            .iter()
            .enumerate()
            .map(|(queue_pos, agent)| {
                let is_active = active_agent_id.map_or(false, |id| id == agent.agent_id);
                let is_paused = self.paused_agent_ids.contains(&agent.agent_id);

                let status = if is_paused {
                    "idle".to_string()
                } else {
                    override_status.unwrap_or("running").to_string()
                };

                let activity = if is_active {
                    active_activity
                        .unwrap_or("thinking")
                        .to_string()
                } else if is_paused {
                    "paused".to_string()
                } else {
                    format!("queued ({} of {})", queue_pos + 1, total_agents)
                };

                let cycle_count = self
                    .agent_cycle_counts
                    .get(&agent.agent_id)
                    .copied()
                    .unwrap_or(0);

                let last_completed = self
                    .last_completed_times
                    .get(&agent.agent_id)
                    .cloned();

                // Calculate real next_heartbeat based on queue distance from current_index.
                // If agent is at or ahead of current_index, it runs in (distance * gap_ms).
                // If agent is behind (already ran this round), it runs after a full cycle wraps.
                let next_heartbeat = if is_active {
                    // Currently running — no "next" time
                    None
                } else if is_paused {
                    None
                } else if total_agents > 0 {
                    let distance = if queue_pos >= self.current_index {
                        queue_pos - self.current_index
                    } else {
                        // Already passed in this round — full cycle + remaining
                        total_agents - self.current_index + queue_pos
                    };
                    let next = base_time + chrono::Duration::milliseconds(gap_ms * distance as i64);
                    Some(next.to_rfc3339())
                } else {
                    None
                };

                AgentStatusPayload {
                    agent_name: agent.agent_id.clone(),
                    status,
                    provider: agent.config.provider.clone(),
                    model: agent.config.model.clone(),
                    heartbeat_interval_hours: agent.config.interval_hours,
                    last_heartbeat: last_completed,
                    next_heartbeat,
                    current_activity: Some(activity),
                    last_action: None,
                    total_heartbeats: Some(cycle_count),
                    total_actions: None,
                    config: Some(serde_json::json!({
                        "orchestration": true,
                        "queue_position": queue_pos + 1,
                        "total_agents": total_agents,
                        "min_gap_ms": self.min_gap_ms,
                        "mode": "orchestration"
                    })),
                }
            })
            .collect()
    }

    /// Build an OrchestrationStatePayload from the current coordinator state.
    /// Used for fire-and-forget reporting to the fleet server on every transition.
    ///
    /// Note: `agent_id` in the coordinator IS the agent name (same value used
    /// as `agent_name` in `AgentStatusPayload` throughout the codebase).
    fn build_orch_state(
        &self,
        device_id: &str,
        device_name: &str,
        device_platform: &str,
        cycle_started_at: Option<String>,
    ) -> OrchestrationStatePayload {
        let queue_names: Vec<String> = self.queue.iter().map(|a| a.agent_id.clone()).collect();

        let current_agent_name = self.current_agent_id.clone();

        let next_agent_name = self.next_active_agent().map(|(_, a)| a.agent_id.clone());

        OrchestrationStatePayload {
            is_running: self.is_running,
            current_agent_name,
            next_agent_name,
            next_scheduled_at: self.next_scheduled_at.clone(),
            queue_order: queue_names,
            paused_agents: self.paused_agent_ids.clone(),
            min_gap_ms: self.min_gap_ms,
            total_cycles: self.total_cycles,
            agent_cycle_counts: self.agent_cycle_counts.clone(),
            last_completed_times: self.last_completed_times.clone(),
            orchestrating_device_id: device_id.to_string(),
            orchestrating_device_name: device_name.to_string(),
            orchestrating_platform: device_platform.to_string(),
            cycle_started_at,
        }
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
        fleet_service: Arc<FleetService>,
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
        let fleet = fleet_service.clone();

        // Resolve device identity once for orchestration state reporting
        let device_id = FleetService::get_or_create_machine_id();
        let device_name = get_hostname().unwrap_or_else(|| "unknown".to_string());
        let device_platform = std::env::consts::OS.to_string();

        // Emit initial status and report to fleet
        {
            let state = inner.lock().await;
            let _ = app_handle.emit("coordinator:status-updated", state.to_status());
            // Report all agents as "running" / "waiting" on coordinator start
            let payloads =
                state.build_agent_status_payloads(Some("running"), Some("waiting"), None, None);
            fleet.report_status(payloads);

            // Report orchestration state: coordinator started
            fleet.report_orchestration_state(
                state.build_orch_state(&device_id, &device_name, &device_platform, None),
            );
        }

        // Clone device info for the spawned task
        let dev_id = device_id.clone();
        let dev_name = device_name.clone();
        let dev_platform = device_platform.clone();

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
                let cycle_started_at = Utc::now().to_rfc3339();
                {
                    let mut state = inner.lock().await;
                    state.current_agent_id = Some(agent.agent_id.clone());
                    state.next_scheduled_at = None; // Currently running, no "next" yet

                    // Report orchestration state: agent cycle begins
                    fleet.report_orchestration_state(
                        state.build_orch_state(&dev_id, &dev_name, &dev_platform, Some(cycle_started_at.clone())),
                    );
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

                // Report agent as "thinking" to fleet (fire-and-forget)
                {
                    let state = inner.lock().await;
                    let payloads = state.build_agent_status_payloads(
                        Some("running"),
                        Some("waiting"),
                        Some(&agent.agent_id),
                        Some("thinking"),
                    );
                    fleet.report_status(payloads);
                }

                // Run one heartbeat cycle (with fleet broadcast for thoughts)
                let cycle_result = HeartbeatService::run_cycle(
                    &http,
                    &agent.agent_id,
                    &agent.api_key,
                    &agent.config,
                    &app_handle,
                    Some(&fleet),
                )
                .await;

                // Determine last_action from cycle result
                let last_action = match &cycle_result {
                    Ok(r) => {
                        if r.actions_taken > 0 {
                            Some(format!("{} actions", r.actions_taken))
                        } else {
                            Some("cycle_complete".to_string())
                        }
                    }
                    Err(e) => Some(format!("error: {}", &e[..e.len().min(100)])),
                };

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

                    // Report cycle-complete status to fleet with last_action and next_heartbeat
                    let mut payloads = state.build_agent_status_payloads(
                        Some("running"),
                        Some("idle"),
                        None,
                        None,
                    );
                    // Patch the agent that just completed with its last_action
                    for p in &mut payloads {
                        if p.agent_name == agent.agent_id {
                            p.last_action = last_action.clone();
                            p.current_activity = Some("idle".to_string());
                        }
                    }
                    fleet.report_status(payloads);

                    // Report orchestration state: agent cycle complete
                    fleet.report_orchestration_state(
                        state.build_orch_state(&dev_id, &dev_name, &dev_platform, None),
                    );
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

            // Cleanup — report all agents as idle on stop
            let mut state = inner.lock().await;
            state.is_running = false;
            state.current_agent_id = None;
            state.next_scheduled_at = None;
            let _ = app_handle.emit("coordinator:status-updated", state.to_status());

            // Report all agents as "idle" to fleet
            let payloads =
                state.build_agent_status_payloads(Some("idle"), Some("idle"), None, None);
            fleet.report_status(payloads);

            // Report orchestration state: coordinator stopped
            fleet.report_orchestration_state(
                state.build_orch_state(&dev_id, &dev_name, &dev_platform, None),
            );

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
