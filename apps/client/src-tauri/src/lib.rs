mod atomic_file;
mod child_process;
mod cooperative_file_lock;
mod desktop_shell;
mod desktop_task;
#[cfg(test)]
#[path = "../embedded_runtime_inputs.rs"]
mod embedded_runtime_inputs;
mod fleet;
mod fleet_control;
mod launcher;
mod media;
mod runtime_contract_generated;
mod runtime_snapshot;
mod settings_transfer;
mod shared_cli;
mod shell_state;
mod sleep_inhibition;
mod ui_control;
mod ui_operation;
mod voice;
mod workspace_git;
mod workspace_run;
mod workspace_tools;

use tauri::Manager as _;
#[cfg(desktop)]
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags as WindowStateFlags};

const DEVELOPMENT_APP_IDENTIFIER_SUFFIX: &str = ".dev";
const PRODUCTION_APP_TITLE: &str = "machdoch";
const DEVELOPMENT_APP_TITLE: &str = "machdoch Developer";

fn app_identifier(identifier: &str, is_development: bool) -> String {
    if is_development && !identifier.ends_with(DEVELOPMENT_APP_IDENTIFIER_SUFFIX) {
        format!("{identifier}{DEVELOPMENT_APP_IDENTIFIER_SUFFIX}")
    } else {
        identifier.to_string()
    }
}

fn app_title(is_development: bool) -> &'static str {
    if is_development {
        DEVELOPMENT_APP_TITLE
    } else {
        PRODUCTION_APP_TITLE
    }
}

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

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if let Err(error) = desktop_shell::handle_secondary_instance(app, args) {
            eprintln!("Failed to handle file-manager invocation: {error}");
        }
    }));

    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

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

    let mut context = tauri::generate_context!();

    {
        let is_development = cfg!(debug_assertions);
        let config = context.config_mut();

        // Tauri's single-instance plugin keys its process lock from this identifier.
        // Keep debug and installed release builds independent so both can run at once.
        let identifier = config.identifier.clone();
        config.identifier = app_identifier(&identifier, is_development);

        if let Some(main_window) = config
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == desktop_shell::MAIN_WINDOW_LABEL)
        {
            main_window.title = app_title(is_development).to_string();
            // Materialize the configured WebView2 window before setup applies
            // the user's launch policy. An initially invisible configured
            // window can otherwise remain a non-operational placeholder on
            // Windows: get_webview_window() finds it, but show(), sizing, and
            // IPC fail because no webview was created. Setup still hides the
            // window before the event loop paints when start-in-tray is active.
            main_window.visible = true;
        }
    }

    builder
        .manage(desktop_task::AttachmentPathGrantMap::default())
        .manage(desktop_task::DesktopTaskCancelMap::default())
        .manage(desktop_shell::FileManagerInvocationState::with_initial(
            launch_context.file_manager_invocation.clone(),
        ))
        .manage(desktop_shell::DesktopLaunchId(
            desktop_shell::create_desktop_launch_id(),
        ))
        .manage(desktop_shell::QuickVoiceShortcutState::default())
        .manage(fleet::FleetConnectionState::default())
        .manage(fleet_control::FleetControlState::default())
        .manage(media::MediaRuntimeState::default())
        .manage(shell_state::ShellStateStoreLock::default())
        .manage(sleep_inhibition::SystemSleepInhibitor::default())
        .manage(settings_transfer::SettingsFileTransferState::default())
        .manage(settings_transfer::SettingsTransferState::default())
        .manage(ui_operation::CrossWindowOperationState::default())
        .manage(runtime_snapshot::McpConfigWriteLock::default())
        .manage(workspace_run::WorkspaceRunState::default())
        .manage(workspace_tools::WorkspaceTerminalState::default())
        .on_window_event(|window, event| {
            desktop_shell::handle_window_event(window, event);
        })
        .setup(move |app| {
            settings_transfer::initialize(app.handle()).map_err(std::io::Error::other)?;
            desktop_task::cleanup_stale_task_context_files();

            if let Err(error) = desktop_shell::create_tray(app.handle()) {
                eprintln!("Failed to create tray icon: {error}");
            }

            if let Err(error) = desktop_shell::sync_quick_voice_shortcut(app.handle()) {
                eprintln!("Failed to initialize the Quick Voice shortcut: {error}");
            }

            if let Err(error) = fleet_control::initialize(app.handle()) {
                eprintln!("Failed to initialize Fleet Manager control state: {error}");
            }

            if let Err(error) = fleet::initialize(app.handle()) {
                eprintln!("Failed to initialize Fleet Manager connection: {error}");
            }

            if let Err(error) = media::initialize_runtime(app.handle()) {
                eprintln!("Failed to initialize Media Studio: {error}");
            }

            if let Err(error) = app
                .state::<workspace_run::WorkspaceRunState>()
                .initialize(app.handle())
            {
                eprintln!("Failed to initialize workspace run control: {error}");
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
            desktop_shell::clear_webview_cache,
            desktop_shell::ensure_assistant_window,
            desktop_shell::get_desktop_launch_id,
            desktop_shell::hide_main_window_to_tray,
            desktop_shell::quit_machdoch,
            desktop_shell::reveal_main_window,
            desktop_shell::file_manager::resolve_file_manager_invocation,
            desktop_shell::sync_chat_completion_indicator,
            desktop_shell::file_manager::take_file_manager_invocations,
            desktop_task::cancel_desktop_task,
            desktop_task::acknowledge_recent_desktop_task_results,
            desktop_task::get_active_desktop_task_ids,
            desktop_task::get_active_desktop_tasks,
            desktop_task::get_recent_desktop_task_results,
            desktop_task::get_task_file_change_files,
            desktop_task::get_task_file_change_hunks,
            desktop_task::open_attached_path,
            desktop_task::open_ralph_flow_in_explorer,
            desktop_task::open_workspace_path,
            desktop_task::read_attached_file_preview,
            desktop_task::read_workspace_file_preview,
            desktop_task::resolve_attached_file_preview_path,
            desktop_task::resolve_attached_image_preview_path,
            desktop_task::resolve_workspace_file_preview_path,
            desktop_task::resolve_dropped_paths,
            desktop_task::run_instruction_command,
            desktop_task::run_mcp_command,
            desktop_task::run_provider_sync_command,
            desktop_task::run_ralph_command,
            desktop_task::run_scheduler_command,
            desktop_task::start_scheduler_service,
            desktop_task::run_task_interview_command,
            desktop_task::run_desktop_task,
            desktop_task::save_clipboard_image_attachment,
            workspace_git::discover_workspace_git_repositories,
            workspace_git::get_workspace_git_overview,
            workspace_git::get_workspace_git_diff,
            workspace_git::get_workspace_pull_requests,
            workspace_git::run_workspace_git_action,
            workspace_run::get_workspace_run_configuration_document,
            workspace_run::get_workspace_run_snapshot,
            workspace_run::precheck_workspace_run_configuration_json,
            workspace_run::restart_workspace_run_configuration,
            workspace_run::save_workspace_run_configuration_document,
            workspace_run::start_workspace_run_configuration,
            workspace_run::stop_workspace_run_configuration,
            workspace_tools::files::create_workspace_entry,
            workspace_tools::files::delete_workspace_entry,
            workspace_tools::files::list_workspace_directory,
            workspace_tools::files::read_workspace_file,
            workspace_tools::files::rename_workspace_entry,
            workspace_tools::files::save_workspace_file,
            workspace_tools::terminal::acknowledge_workspace_terminal_output,
            workspace_tools::terminal::discover_workspace_shells,
            workspace_tools::terminal::open_workspace_terminal_host,
            workspace_tools::terminal::resize_workspace_terminal,
            workspace_tools::terminal::start_workspace_terminal,
            workspace_tools::terminal::stop_workspace_terminal,
            workspace_tools::terminal::stop_workspace_terminals,
            workspace_tools::terminal::write_workspace_terminal_binary,
            workspace_tools::terminal::write_workspace_terminal,
            media::media_cancel_run,
            media::media_analyze_image_quality,
            media::media_enqueue_fixture_run,
            media::media_generate_images,
            media::media_generate_video,
            media::media_generate_svg,
            media::media_execute_remote_image_edit_flow,
            media::media_enqueue_mock_remote_run,
            media::media_export_asset,
            media::media_export_flow_revision,
            media::media_get_run_detail,
            media::media_get_model_catalog,
            media::media_discover_workspace_models,
            media::media_get_flow,
            media::media_plan_model_install,
            media::media_start_model_install,
            media::media_get_model_install_job,
            media::media_cancel_model_install,
            media::media_plan_model_removal,
            media::media_remove_model,
            media::media_initialize_runtime,
            media::media_refresh_local_diffusers_runtime,
            media::media_import_image,
            media::media_import_image_url,
            media::media_inspect_hardware,
            media::media_inspect_flow_import,
            media::media_import_flow,
            media::media_inspect_local_model,
            media::media_import_local_model,
            media::media_probe_local_model,
            media::media_inspect_model_addon,
            media::media_inspect_civitai_model_addon,
            media::media_download_civitai_model_addon,
            media::media_import_model_addon,
            media::media_plan_model_addon_removal,
            media::media_remove_model_addon,
            media::media_list_assets,
            media::media_list_asset_page,
            media::media_list_flows,
            media::media_set_asset_tags,
            media::media_auto_tag_asset,
            media::media_plan_asset_deletion,
            media::media_delete_asset,
            media::media_execute_local_image_flow,
            media::media_list_runs,
            media::media_list_run_page,
            media::media_save_flow_revision,
            media::media_read_asset_preview,
            media::media_read_quality_report,
            media::media_retry_fixture_run,
            media::media_resolve_human_review,
            media::media_resolve_provider_review,
            media::media_wake_provider_reconciliation,
            media::media_transform_image,
            fleet::enroll_fleet_manager,
            fleet::get_fleet_connection_status,
            fleet::get_fleet_managed_settings,
            fleet::report_fleet_managed_settings_applied,
            fleet::report_fleet_managed_settings_failure,
            fleet::reset_fleet_manager_connection,
            fleet::synchronize_fleet_managed_prompts,
            fleet_control::get_pending_fleet_control_commands,
            fleet_control::acknowledge_fleet_control_command,
            fleet_control::update_fleet_control_shell_snapshot,
            shell_state::compare_and_swap_shell_state,
            shell_state::compare_and_swap_shell_state_patch,
            shell_state::load_shell_state_revision,
            shell_state::load_shell_state_snapshot,
            settings_transfer::approve_settings_transfer,
            settings_transfer::cancel_encrypted_settings_file_import,
            settings_transfer::commit_encrypted_settings_file_import,
            settings_transfer::confirm_settings_transfer_pairing,
            settings_transfer::connect_settings_transfer,
            settings_transfer::export_encrypted_settings_file,
            settings_transfer::get_settings_transfer_catalog,
            settings_transfer::get_settings_transfer_status,
            settings_transfer::inspect_encrypted_settings_file,
            settings_transfer::start_settings_receive,
            settings_transfer::start_settings_transfer,
            settings_transfer::stop_settings_transfer,
            ui_operation::begin_cross_window_operation,
            ui_operation::complete_cross_window_operation,
            ui_operation::release_cross_window_operation,
            runtime_snapshot::get_user_desktop_settings,
            runtime_snapshot::get_user_agent_limits_settings,
            runtime_snapshot::get_user_workspace_run_settings,
            runtime_snapshot::get_global_provider_availability,
            runtime_snapshot::get_provider_model_catalog,
            runtime_snapshot::get_user_memory_settings,
            runtime_snapshot::get_workspace_memory_entries,
            runtime_snapshot::get_user_mcp_config_document,
            runtime_snapshot::get_user_provider_api_keys,
            runtime_snapshot::delete_user_provider_api_key,
            runtime_snapshot::get_user_internal_task_model_settings,
            runtime_snapshot::get_user_review_model_settings,
            runtime_snapshot::get_user_speech_to_text_settings,
            runtime_snapshot::get_user_voice_settings,
            runtime_snapshot::get_user_web_search_settings,
            runtime_snapshot::get_workspace_mcp_config_document,
            runtime_snapshot::get_runtime_snapshot,
            runtime_snapshot::save_user_desktop_settings,
            runtime_snapshot::save_user_agent_limits_settings,
            runtime_snapshot::save_user_workspace_run_settings,
            runtime_snapshot::save_user_global_memory_enabled,
            runtime_snapshot::forget_user_global_memory_entry,
            runtime_snapshot::forget_workspace_memory,
            runtime_snapshot::save_user_mcp_config_document,
            runtime_snapshot::save_user_provider_api_key,
            runtime_snapshot::save_user_internal_task_model_settings,
            runtime_snapshot::save_user_review_model_settings,
            runtime_snapshot::save_user_speech_to_text_active_provider,
            runtime_snapshot::save_user_speech_to_text_input_device,
            runtime_snapshot::save_user_voice_active_provider,
            runtime_snapshot::save_user_web_search_active_provider,
            runtime_snapshot::save_user_web_search_api_key,
            runtime_snapshot::delete_user_web_search_api_key,
            runtime_snapshot::save_workspace_default_mode,
            runtime_snapshot::save_workspace_reasoning_mode,
            runtime_snapshot::save_workspace_context_window,
            runtime_snapshot::save_workspace_reasoning_execution_mode,
            runtime_snapshot::save_workspace_mcp_config_document,
            voice::synthesize_user_voice_audio,
            voice::transcribe_user_speech_audio
        ])
        .build(context)
        .expect("error while building machdoch desktop shell")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<workspace_run::WorkspaceRunState>().shutdown();
                app.state::<sleep_inhibition::SystemSleepInhibitor>()
                    .shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_identifier_separates_development_builds_only() {
        let production_identifier = "com.machdoch.desktop";
        let development_identifier = app_identifier(production_identifier, true);

        assert_eq!(development_identifier, "com.machdoch.desktop.dev");
        assert_ne!(development_identifier, production_identifier);
        assert_eq!(
            app_identifier(&development_identifier, true),
            development_identifier
        );
        assert_eq!(
            app_identifier(production_identifier, false),
            production_identifier
        );
    }

    #[test]
    fn app_title_marks_development_builds_only() {
        assert_eq!(app_title(true), "machdoch Developer");
        assert_eq!(app_title(false), "machdoch");
    }
}
