use tauri::Manager;

mod desktop_task;
mod runtime_snapshot;
mod ui_control;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    match ui_control::try_run_ui_control_bridge_from_args() {
        Ok(true) => {
            return;
        }
        Ok(false) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            app.manage(desktop_task::DesktopTaskCancelMap(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            )));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            desktop_task::cancel_desktop_task,
            desktop_task::open_workspace_path,
            desktop_task::run_desktop_task,
            runtime_snapshot::get_global_provider_availability,
            runtime_snapshot::get_user_memory_settings,
            runtime_snapshot::get_user_provider_api_keys,
            runtime_snapshot::get_user_web_search_settings,
            runtime_snapshot::get_runtime_snapshot,
            runtime_snapshot::save_user_global_memory_enabled,
            runtime_snapshot::save_user_provider_api_key,
            runtime_snapshot::save_user_web_search_active_provider,
            runtime_snapshot::save_user_web_search_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running machdoch desktop shell");
}
