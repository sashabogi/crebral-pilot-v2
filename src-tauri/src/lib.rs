mod commands;
mod services;
mod state;

use state::AppState;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Register the updater plugin (desktop only).
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            // Resolve the app data directory and create AppState with a persistent store.
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");
            app.manage(AppState::new(app_data_dir));

            // Register the crebral:// URL scheme for deep linking.
            // On macOS, scheme registration is handled via Info.plist (from tauri.conf.json config),
            // so register() returns UnsupportedPlatform — that's expected and safe to ignore.
            // On Windows/Linux, register() sets up the OS-level scheme handler.
            #[cfg(desktop)]
            if let Err(e) = app.deep_link().register("crebral") {
                log::debug!("[deep_link] register() returned: {e} (expected on macOS)");
            }

            // Listen for deep link URL events and route auth callbacks
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                for url in urls {
                    let url_str = url.as_str();
                    log::info!("[deep_link] Received URL: {}", url_str);
                    if url_str.starts_with("crebral://auth/") {
                        let h = handle.clone();
                        let u = url_str.to_string();
                        tauri::async_runtime::spawn(async move {
                            let state = h.state::<AppState>();
                            if let Err(e) =
                                commands::auth::handle_auth_deep_link(&u, state.inner(), &h).await
                            {
                                log::error!("[deep_link] Error handling auth callback: {e}");
                            }
                        });
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Heartbeat
            commands::heartbeat::heartbeat_start,
            commands::heartbeat::heartbeat_stop,
            commands::heartbeat::heartbeat_status,
            // Agents
            commands::agents::agents_list,
            commands::agents::agents_get,
            commands::agents::agents_add,
            commands::agents::agents_remove,
            commands::agents::agents_update_color,
            commands::agents::agents_validate_key,
            commands::agents::agents_profile,
            commands::agents::agents_activity,
            commands::agents::agents_save_order,
            commands::agents::agents_get_order,
            commands::agents::agents_dashboard,
            commands::agents::agents_decisions,
            // Settings
            commands::settings::settings_get,
            commands::settings::settings_set,
            // Models
            commands::models::models_get_all_providers,
            commands::models::models_get_for_provider,
            commands::models::models_fetch_with_key,
            commands::models::models_fetch_for_agent,
            // Coordinator
            commands::coordinator::coordinator_start,
            commands::coordinator::coordinator_stop,
            commands::coordinator::coordinator_status,
            commands::coordinator::coordinator_set_min_gap,
            commands::coordinator::coordinator_reorder,
            commands::coordinator::coordinator_pause_agent,
            commands::coordinator::coordinator_resume_agent,
            // Auth
            commands::auth::auth_login,
            commands::auth::auth_sync_account,
            commands::auth::auth_sync_and_load,
            commands::auth::auth_provision_key,
            commands::auth::auth_logout,
            commands::auth::auth_status,
            commands::auth::auth_list_accounts,
            commands::auth::auth_switch_account,
            commands::auth::auth_remove_account,
            // Account
            commands::account_get_info,
            // Fleet
            commands::fleet::fleet_status,
            commands::fleet::fleet_register,
            commands::fleet::fleet_disconnect,
            // Utilities
            commands::open_external,
            commands::get_app_version,
            commands::get_platform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Crebral Pilot");
}
