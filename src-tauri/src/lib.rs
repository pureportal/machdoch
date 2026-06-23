mod desktop_shell;
mod desktop_task;
mod launcher;
mod remote_control;
mod runtime_contract_generated;
mod runtime_snapshot;
mod shared_cli;
mod ui_control;
mod voice;

#[cfg(desktop)]
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags as WindowStateFlags};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    desktop_shell::hide_console_window_for_background_ui_launch();

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

    let builder = tauri::Builder::default();

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    #[cfg(desktop)]
    let builder = builder.plugin(
        WindowStateBuilder::default()
            .with_filter(|label| label == desktop_shell::MAIN_WINDOW_LABEL)
            .with_state_flags(
                WindowStateFlags::POSITION
                    | WindowStateFlags::SIZE
                    | WindowStateFlags::MAXIMIZED
                    | WindowStateFlags::FULLSCREEN,
            )
            .build(),
    );

    builder
        .manage(desktop_task::AttachmentPathGrantMap::default())
        .manage(desktop_task::DesktopTaskCancelMap::default())
        .manage(desktop_shell::DesktopLaunchId(
            desktop_shell::create_desktop_launch_id(),
        ))
        .manage(desktop_shell::QuickVoiceShortcutState::default())
        .manage(remote_control::RemoteControlState::default())
        .on_window_event(|window, event| {
            desktop_shell::handle_window_event(window, event);
        })
        .setup(move |app| {
            if let Err(error) = desktop_shell::create_tray(app.handle()) {
                eprintln!("Failed to create tray icon: {error}");
            }

            if let Err(error) = desktop_shell::sync_quick_voice_shortcut(app.handle()) {
                eprintln!("Failed to initialize the Quick Voice shortcut: {error}");
            }

            if let Err(error) = remote_control::sync_remote_control_startup(app.handle()) {
                eprintln!("Failed to initialize Mission Control: {error}");
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
            desktop_shell::hide_main_window_to_tray,
            desktop_shell::quit_machdoch,
            desktop_shell::reveal_main_window,
            desktop_task::cancel_desktop_task,
            desktop_task::get_active_desktop_task_ids,
            desktop_task::get_active_desktop_tasks,
            desktop_task::open_attached_path,
            desktop_task::open_workspace_path,
            desktop_task::resolve_dropped_paths,
            desktop_task::run_instruction_command,
            desktop_task::run_mcp_command,
            desktop_task::run_ralph_command,
            desktop_task::run_scheduler_command,
            desktop_task::run_desktop_task,
            desktop_task::save_clipboard_image_attachment,
            remote_control::disable_remote_control_server,
            remote_control::enable_remote_control_server,
            remote_control::forget_remote_control_pairings,
            remote_control::get_remote_control_status,
            remote_control::open_remote_control_url,
            remote_control::set_remote_control_port,
            remote_control::update_remote_control_shell_snapshot,
            runtime_snapshot::get_user_desktop_settings,
            runtime_snapshot::get_user_agent_limits_settings,
            runtime_snapshot::get_global_provider_availability,
            runtime_snapshot::get_provider_model_catalog,
            runtime_snapshot::get_user_memory_settings,
            runtime_snapshot::get_user_mcp_config_document,
            runtime_snapshot::get_user_provider_api_keys,
            runtime_snapshot::get_user_review_model_settings,
            runtime_snapshot::get_user_speech_to_text_settings,
            runtime_snapshot::get_user_voice_settings,
            runtime_snapshot::get_user_web_search_settings,
            runtime_snapshot::get_workspace_mcp_config_document,
            runtime_snapshot::get_runtime_snapshot,
            runtime_snapshot::save_user_desktop_settings,
            runtime_snapshot::save_user_agent_limits_settings,
            runtime_snapshot::save_user_global_memory_enabled,
            runtime_snapshot::save_user_mcp_config_document,
            runtime_snapshot::save_user_provider_api_key,
            runtime_snapshot::save_user_review_model_settings,
            runtime_snapshot::save_user_speech_to_text_active_provider,
            runtime_snapshot::save_user_speech_to_text_input_device,
            runtime_snapshot::save_user_voice_active_provider,
            runtime_snapshot::save_user_web_search_active_provider,
            runtime_snapshot::save_user_web_search_api_key,
            runtime_snapshot::save_workspace_default_mode,
            runtime_snapshot::save_workspace_reasoning_mode,
            runtime_snapshot::save_workspace_mcp_config_document,
            voice::synthesize_user_voice_audio,
            voice::transcribe_user_speech_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running machdoch desktop shell");
}
