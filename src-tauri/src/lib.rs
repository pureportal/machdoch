use tauri::Manager;

mod desktop_shell;
mod desktop_task;
mod launcher;
mod runtime_snapshot;
mod shared_cli;
mod ui_control;
mod voice;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    desktop_shell::hide_console_window_for_admin_relaunch();

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

    let launch_context = match launcher::resolve_launch_action() {
        Ok(launcher::LaunchAction::Ui(launch_context)) => launch_context,
        Ok(launcher::LaunchAction::Cli(args)) => match launcher::run_cli(&args) {
            Ok(exit_code) => std::process::exit(exit_code),
            Err(error) => {
                eprintln!("machdoch: {error}");
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!("machdoch: {error}");
            std::process::exit(1);
        }
    };

    match desktop_shell::relaunch_as_administrator_if_configured() {
        Ok(true) => {
            return;
        }
        Ok(false) => {}
        Err(error) => {
            eprintln!("Failed to restart machdoch as administrator: {error}");
        }
    }

    tauri::Builder::default()
        .on_window_event(|window, event| {
            desktop_shell::handle_window_event(window, event);
        })
        .setup(move |app| {
            app.manage(desktop_task::DesktopTaskCancelMap::default());
            app.manage(desktop_shell::DesktopLaunchId(
                desktop_shell::create_desktop_launch_id(),
            ));
            app.manage(desktop_shell::QuickVoiceShortcutState::default());

            if let Err(error) = desktop_shell::create_tray(app.handle()) {
                eprintln!("Failed to create tray icon: {error}");
            }

            if let Err(error) = desktop_shell::sync_quick_voice_shortcut(app.handle()) {
                eprintln!("Failed to initialize the Quick Voice shortcut: {error}");
            }

            desktop_shell::apply_startup_mode(app.handle(), launch_context);

            if let Err(error) = desktop_shell::sync_assistant_bubble_window(app.handle()) {
                eprintln!("Failed to initialize the assistant bubble window: {error}");
            }

            Ok(())
        })
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(desktop_shell::AUTOSTART_LAUNCH_ARG)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            desktop_shell::detect_fullscreen_window_on_monitor,
            desktop_shell::get_desktop_launch_id,
            desktop_shell::reveal_main_window,
            desktop_task::cancel_desktop_task,
            desktop_task::get_active_desktop_task_ids,
            desktop_task::open_workspace_path,
            desktop_task::resolve_dropped_paths,
            desktop_task::run_desktop_task,
            runtime_snapshot::get_user_desktop_settings,
            runtime_snapshot::get_user_agent_limits_settings,
            runtime_snapshot::get_global_provider_availability,
            runtime_snapshot::get_user_memory_settings,
            runtime_snapshot::get_user_provider_api_keys,
            runtime_snapshot::get_user_speech_to_text_settings,
            runtime_snapshot::get_user_voice_settings,
            runtime_snapshot::get_user_web_search_settings,
            runtime_snapshot::get_runtime_snapshot,
            runtime_snapshot::save_user_desktop_settings,
            runtime_snapshot::save_user_agent_limits_settings,
            runtime_snapshot::save_user_global_memory_enabled,
            runtime_snapshot::save_user_provider_api_key,
            runtime_snapshot::save_user_speech_to_text_active_provider,
            runtime_snapshot::save_user_speech_to_text_input_device,
            runtime_snapshot::save_user_voice_active_provider,
            runtime_snapshot::save_user_web_search_active_provider,
            runtime_snapshot::save_user_web_search_api_key,
            voice::synthesize_user_voice_audio,
            voice::transcribe_user_speech_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running machdoch desktop shell");
}
