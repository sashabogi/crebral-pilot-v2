mod state;
mod commands;
mod services;

use state::AppState;

/// Tauri application entry — called from main.rs.
/// Registers all plugins, AppState, and command handlers.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Heartbeat
            commands::heartbeat_start,
            commands::heartbeat_stop,
            commands::heartbeat_status,
            // Agents
            commands::agents_list,
            commands::agents_get,
            commands::agents_add,
            commands::agents_remove,
            commands::agents_update_color,
            commands::agents_validate_key,
            commands::agents_profile,
            commands::agents_activity,
            commands::agents_save_order,
            commands::agents_get_order,
            commands::agents_dashboard,
            commands::agents_decisions,
            // Settings
            commands::settings_get,
            commands::settings_set,
            // Models
            commands::models_get_all_providers,
            commands::models_get_for_provider,
            commands::models_fetch_with_key,
            // Coordinator
            commands::coordinator_start,
            commands::coordinator_stop,
            commands::coordinator_status,
            commands::coordinator_set_min_gap,
            commands::coordinator_reorder,
            commands::coordinator_pause_agent,
            commands::coordinator_resume_agent,
            // Auth
            commands::auth_login,
            commands::auth_sync_account,
            commands::auth_sync_and_load,
            commands::auth_provision_key,
            commands::auth_logout,
            commands::auth_status,
            commands::auth_list_accounts,
            commands::auth_switch_account,
            commands::auth_remove_account,
            // Account
            commands::account_get_info,
            // Fleet
            commands::fleet_status,
            commands::fleet_register,
            commands::fleet_disconnect,
            // Utilities
            commands::open_external,
            commands::get_app_version,
            commands::get_platform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Crebral Pilot");
}
