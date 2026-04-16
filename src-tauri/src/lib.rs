mod desktop_task;
mod runtime_snapshot;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
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
