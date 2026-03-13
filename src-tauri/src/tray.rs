//! System tray (menu bar) helper for Crebral Pilot v2.
//!
//! Provides a macOS menu-bar icon with orchestration status,
//! recent thoughts, and quick controls.

use std::collections::VecDeque;
use std::sync::Arc;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager,
};
use tokio::sync::Mutex;

/// Maximum number of recent thoughts kept in the circular buffer.
const MAX_THOUGHTS: usize = 5;
/// Maximum display characters per thought line in the tray menu.
const THOUGHT_DISPLAY_LEN: usize = 50;
/// Tray icon dimensions (22x22).
const TRAY_ICON_SIZE: u32 = 22;

/// Pre-decoded RGBA bytes for tray icons (avoids needing image-png feature).
const ICON_IDLE_RGBA: &[u8] = include_bytes!("../icons/tray-idle.rgba");
const ICON_ACTIVE_RGBA: &[u8] = include_bytes!("../icons/tray-active.rgba");

// ── Tray state ──────────────────────────────────────────────────────────

/// Shared mutable state for the tray — updated from event listeners.
pub struct TrayState {
    pub is_running: bool,
    pub agent_count: usize,
    pub next_agent_name: Option<String>,
    pub next_in_secs: Option<i64>,
    pub recent_thoughts: VecDeque<String>,
}

impl TrayState {
    fn new() -> Self {
        Self {
            is_running: false,
            agent_count: 0,
            next_agent_name: None,
            next_in_secs: None,
            recent_thoughts: VecDeque::with_capacity(MAX_THOUGHTS + 1),
        }
    }

    fn push_thought(&mut self, thought: String) {
        self.recent_thoughts.push_front(thought);
        if self.recent_thoughts.len() > MAX_THOUGHTS {
            self.recent_thoughts.pop_back();
        }
    }
}

// ── Menu IDs ────────────────────────────────────────────────────────────

const ID_STATUS: &str = "tray_status";
const ID_NEXT_SYNAPSE: &str = "tray_next_synapse";
const ID_TOGGLE: &str = "tray_toggle";
const ID_SHOW: &str = "tray_show";
const ID_QUIT: &str = "tray_quit";

// ── Public setup ────────────────────────────────────────────────────────

/// Call this from the Tauri `.setup()` closure to install the system tray.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let tray_state = Arc::new(Mutex::new(TrayState::new()));

    // Build the initial menu and tray icon.
    let menu = build_menu(app, &TrayState::new())?;

    let idle_icon = Image::new(ICON_IDLE_RGBA, TRAY_ICON_SIZE, TRAY_ICON_SIZE);

    let tray = TrayIconBuilder::with_id("crebral-tray")
        .icon(idle_icon)
        .icon_as_template(true) // macOS template image — auto dark/light
        .menu(&menu)
        .tooltip("Crebral Pilot")
        .on_menu_event({
            let app_handle = app.clone();
            move |_app, event| {
                handle_menu_event(&app_handle, event.id().as_ref());
            }
        })
        .on_tray_icon_event({
            let app_handle = app.clone();
            move |_tray, event| {
                // Double-click on the tray icon shows the main window.
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(&app_handle);
                }
            }
        })
        .build(app)?;

    // ── Event listeners ─────────────────────────────────────────────────

    // Listen for coordinator status updates.
    let state_for_coord = tray_state.clone();
    let app_for_coord = app.clone();
    let tray_id = tray.id().clone();
    app.listen("coordinator:status-updated", move |event| {
        let state_arc = state_for_coord.clone();
        let app_h = app_for_coord.clone();
        let tid = tray_id.clone();
        // Parse the coordinator status payload.
        if let Ok(status) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            tauri::async_runtime::spawn(async move {
                {
                    let mut ts = state_arc.lock().await;
                    ts.is_running = status
                        .get("isRunning")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    ts.agent_count = status
                        .get("queue")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);

                    // Parse next agent info.
                    ts.next_agent_name = status
                        .get("nextAgentId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    // Compute seconds until next scheduled fire.
                    ts.next_in_secs = status
                        .get("nextScheduledAt")
                        .and_then(|v| v.as_str())
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| {
                            let now = chrono::Utc::now();
                            let diff = dt.signed_duration_since(now);
                            diff.num_seconds().max(0)
                        });
                }

                // Update icon and menu.
                let ts = state_arc.lock().await;
                update_tray(&app_h, &tid, &ts);
            });
        }
    });

    // Listen for heartbeat thought events.
    let state_for_thought = tray_state.clone();
    let app_for_thought = app.clone();
    let tray_id_for_thought = tray.id().clone();
    app.listen("heartbeat:thought", move |event| {
        let state_arc = state_for_thought.clone();
        let app_h = app_for_thought.clone();
        let tid = tray_id_for_thought.clone();
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            tauri::async_runtime::spawn(async move {
                let agent_id = payload
                    .get("agentId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("agent");
                let message = payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if message.is_empty() {
                    return;
                }

                // Build display string: "[agent_short] message"
                // Use last segment of agent_id or first 12 chars as short name.
                let agent_short = if agent_id.len() > 12 {
                    &agent_id[..12]
                } else {
                    agent_id
                };

                let full = format!("[{}] {}", agent_short, message);
                let display = if full.len() > THOUGHT_DISPLAY_LEN {
                    format!("{}...", &full[..THOUGHT_DISPLAY_LEN])
                } else {
                    full
                };

                {
                    let mut ts = state_arc.lock().await;
                    ts.push_thought(display);
                }

                let ts = state_arc.lock().await;
                update_tray(&app_h, &tid, &ts);
            });
        }
    });

    Ok(())
}

// ── Menu construction ───────────────────────────────────────────────────

fn build_menu(
    app: &AppHandle,
    state: &TrayState,
) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let menu = Menu::new(app)?;

    // 1. Status line (disabled label).
    let status_text = if state.is_running {
        format!("Orchestration Active \u{2014} {} agents", state.agent_count)
    } else {
        "Orchestration Idle".to_string()
    };
    let status_item = MenuItem::with_id(app, ID_STATUS, &status_text, false, None::<&str>)?;
    menu.append(&status_item)?;

    // 2. Next synapse (only when active).
    if state.is_running {
        if let Some(ref next_name) = state.next_agent_name {
            let time_str = match state.next_in_secs {
                Some(secs) if secs > 0 => {
                    let mins = secs / 60;
                    let s = secs % 60;
                    format!("{:02}:{:02}", mins, s)
                }
                _ => "soon".to_string(),
            };
            let next_text = format!("Next: {} in {}", next_name, time_str);
            let next_item =
                MenuItem::with_id(app, ID_NEXT_SYNAPSE, &next_text, false, None::<&str>)?;
            menu.append(&next_item)?;
        }
    }

    // Separator
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // 3. Start / Stop toggle.
    let toggle_text = if state.is_running {
        "Stop Orchestration"
    } else {
        "Start Orchestration"
    };
    let toggle_item = MenuItem::with_id(app, ID_TOGGLE, toggle_text, true, None::<&str>)?;
    menu.append(&toggle_item)?;

    // Separator
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // 4. Recent thoughts (last 3 displayed, disabled labels).
    let thoughts: Vec<&String> = state.recent_thoughts.iter().take(3).collect();
    if !thoughts.is_empty() {
        for (i, thought) in thoughts.iter().enumerate() {
            let item_id = format!("tray_thought_{}", i);
            let thought_item = MenuItem::with_id(app, &item_id, thought.as_str(), false, None::<&str>)?;
            menu.append(&thought_item)?;
        }
        // Separator after thoughts
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    // 5. Show Crebral Pilot.
    let show_item = MenuItem::with_id(app, ID_SHOW, "Show Crebral Pilot", true, None::<&str>)?;
    menu.append(&show_item)?;

    // 6. Quit.
    let quit_item = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;
    menu.append(&quit_item)?;

    Ok(menu)
}

// ── Menu event handler ──────────────────────────────────────────────────

fn handle_menu_event(app: &AppHandle, item_id: &str) {
    match item_id {
        ID_TOGGLE => {
            let app_h = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_h.state::<crate::state::AppState>();
                let is_running = {
                    let inner = state.coordinator_service.inner.lock().await;
                    inner.is_running
                };

                if is_running {
                    // Stop orchestration
                    if let Err(e) = state.coordinator_service.stop().await {
                        log::error!("Tray: failed to stop coordinator: {}", e);
                    }
                    let status = state.coordinator_service.status().await;
                    let _ = app_h.emit("coordinator:status-updated", &status);
                } else {
                    // Start orchestration — invoke the same logic as the command.
                    // We re-use coordinator_start's logic by emitting a custom event
                    // that the frontend can listen for, OR we call the service directly.
                    // For simplicity, we replicate the essential start logic here.
                    if let Err(e) = start_coordinator_from_tray(&app_h, &state).await {
                        log::error!("Tray: failed to start coordinator: {}", e);
                        // Emit an error thought so it shows in the tray
                        let _ = app_h.emit(
                            "heartbeat:thought",
                            serde_json::json!({
                                "agentId": "system",
                                "type": "error",
                                "message": format!("Failed to start: {}", e),
                                "timestamp": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                    }
                }
            });
        }
        ID_SHOW => {
            show_main_window(app);
        }
        ID_QUIT => {
            // Actually quit the application.
            app.exit(0);
        }
        _ => {}
    }
}

/// Replicate the coordinator start logic for the tray menu toggle.
/// This mirrors `commands::coordinator::coordinator_start` without needing
/// a `State<'_, AppState>` (uses `AppHandle::state()` instead).
async fn start_coordinator_from_tray(
    app: &AppHandle,
    state: &crate::state::AppState,
) -> Result<(), String> {
    use crate::services::coordinator::CoordinatorAgent;
    use crate::services::heartbeat::HeartbeatConfig;
    use crate::services::keychain;
    use std::sync::Arc;

    let user_id = state.store.active_user_id()?;
    let agents = state.store.get_agents(&user_id)?;

    if agents.is_empty() {
        return Err("No agents configured".to_string());
    }

    let settings = state.store.get_settings(&user_id)?;

    let mut queue: Vec<CoordinatorAgent> = Vec::new();
    for agent in &agents {
        let agent_id = &agent.agent_id;

        let api_key = match keychain::get_agent_api_key(agent_id) {
            Ok(Some(key)) => key,
            _ => match agent
                .api_key_enc
                .as_ref()
                .and_then(|enc| crate::services::store::deobfuscate(enc))
            {
                Some(key) => {
                    let _ = keychain::store_agent_api_key(agent_id, &key);
                    key
                }
                None => continue,
            },
        };

        let provider_api_key = keychain::get_provider_key(agent_id)
            .ok()
            .flatten()
            .or_else(|| {
                agent.provider_key_enc.as_ref().and_then(|enc| {
                    let key = crate::services::store::deobfuscate(enc)?;
                    let _ = keychain::store_provider_key(agent_id, &key);
                    Some(key)
                })
            });

        let interval_hours = agent.interval_ms.map(|ms| ms as f64 / 3_600_000.0);

        let config = HeartbeatConfig {
            interval_hours,
            provider: if agent.provider.is_empty() {
                None
            } else {
                Some(agent.provider.clone())
            },
            model: if agent.model.is_empty() {
                None
            } else {
                Some(agent.model.clone())
            },
            provider_api_key,
            temperature: None,
        };

        queue.push(CoordinatorAgent {
            agent_id: agent_id.clone(),
            api_key,
            config,
        });
    }

    if queue.is_empty() {
        return Err("No agents with valid API keys".to_string());
    }

    // Sort by saved order
    let saved_order = state.store.get_agent_order(&user_id).unwrap_or_default();
    if !saved_order.is_empty() {
        queue.sort_by_key(|agent| {
            saved_order
                .iter()
                .position(|id| id == &agent.agent_id)
                .unwrap_or(usize::MAX)
        });
    }

    state.coordinator_service.set_min_gap(settings.min_gap_ms).await;
    state.coordinator_service.set_queue(queue).await;

    let heartbeat_service = Arc::new(crate::services::heartbeat::HeartbeatService::new());
    state
        .coordinator_service
        .start(heartbeat_service, app.clone())
        .await
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Rebuild the tray menu and swap the icon based on current state.
fn update_tray(app: &AppHandle, tray_id: &tauri::tray::TrayIconId, state: &TrayState) {
    if let Some(tray) = app.tray_by_id(tray_id) {
        // Update menu
        if let Ok(new_menu) = build_menu(app, state) {
            let _ = tray.set_menu(Some(new_menu));
        }

        // Update icon
        let icon_rgba = if state.is_running {
            ICON_ACTIVE_RGBA
        } else {
            ICON_IDLE_RGBA
        };
        let icon = Image::new(icon_rgba, TRAY_ICON_SIZE, TRAY_ICON_SIZE);
        let _ = tray.set_icon(Some(icon));

        // Update tooltip
        let tooltip = if state.is_running {
            format!("Crebral Pilot \u{2014} {} agents active", state.agent_count)
        } else {
            "Crebral Pilot \u{2014} Idle".to_string()
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

/// Show and focus the main window.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
