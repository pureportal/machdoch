mod runtime_snapshot;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            runtime_snapshot::get_runtime_snapshot,
            runtime_snapshot::get_global_provider_availability,
            runtime_snapshot::set_user_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running machdoch desktop shell");
}
