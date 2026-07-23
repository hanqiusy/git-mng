mod commands;
mod error;
mod github;
mod gitops;
mod http;
mod oauth;
mod proxy;
mod state;
mod store;
mod util;

use state::{resolve_data_dir, AppState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            let app_state = AppState::new(data_dir)?;
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth_device_start,
            commands::auth_device_poll,
            commands::auth_login,
            commands::auth_logout,
            commands::auth_clear_credentials,
            commands::auth_list_accounts,
            commands::auth_quick_login,
            commands::auth_switch_account,
            commands::auth_remove_account,
            commands::auth_me,
            commands::list_repos,
            commands::search_repos,
            commands::list_branches,
            commands::list_tags,
            commands::create_repo,
            commands::delete_repo,
            commands::star_repo,
            commands::unstar_repo,
            commands::list_clones,
            commands::clone_repo,
            commands::link_clone,
            commands::delete_clone,
            commands::reclone,
            commands::push_repo,
            commands::pull_repo,
            commands::open_dir,
            commands::get_settings,
            commands::update_settings,
            commands::get_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
