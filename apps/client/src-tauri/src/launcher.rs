use std::{env, process::Stdio};

use crate::{desktop_shell, shared_cli};

const CLI_FLAG: &str = "--cli";
const UI_FLAG: &str = "--ui";
const QUICK_FLAG: &str = "--quick";
const CWD_FLAG: &str = "--cwd";

pub(crate) enum LaunchAction {
    Cli(Vec<String>),
    Ui(desktop_shell::LaunchContext),
}

pub(crate) fn resolve_launch_action() -> Result<LaunchAction, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let has_cli_flag = contains_exact_flag(&args, CLI_FLAG);
    let has_ui_flag = contains_exact_flag(&args, UI_FLAG);

    if has_cli_flag && has_ui_flag {
        return Err("Use either --cli or --ui, not both.".to_string());
    }

    let forwarded_args = strip_launcher_mode_flags(&args);
    let has_quick_flag = contains_exact_flag(&forwarded_args, QUICK_FLAG);

    if has_ui_flag {
        if has_quick_flag {
            return Err("--ui cannot be combined with --quick.".to_string());
        }

        if has_non_ui_startup_args(&forwarded_args) {
            return Err(
                "--ui starts the desktop shell and cannot be combined with CLI task arguments. Use --cli or --quick for terminal execution."
                    .to_string(),
            );
        }

        ensure_ui_supported()?;
        return Ok(LaunchAction::Ui(desktop_shell::resolve_launch_context()));
    }

    if has_cli_flag || has_quick_flag || has_non_ui_startup_args(&forwarded_args) {
        return Ok(LaunchAction::Cli(args_with_current_working_directory(
            forwarded_args,
        )?));
    }

    if is_ui_supported() {
        return Ok(LaunchAction::Ui(desktop_shell::resolve_launch_context()));
    }

    Ok(LaunchAction::Cli(args_with_current_working_directory(
        forwarded_args,
    )?))
}

pub(crate) fn run_cli(args: &[String]) -> Result<i32, String> {
    let mut cli_command = shared_cli::create_shared_cli_command(args)?;

    cli_command
        .command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let status = cli_command.command.status().map_err(|error| {
        format!(
            "Failed to launch the shared CLI. {} {error}",
            shared_cli::cli_runtime_error_hint()
        )
    })?;

    Ok(status.code().unwrap_or(1))
}

fn strip_launcher_mode_flags(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| {
            !matches!(
                arg.as_str(),
                CLI_FLAG | UI_FLAG | desktop_shell::ADMIN_RELAUNCH_ARG
            )
        })
        .cloned()
        .collect()
}

fn args_with_current_working_directory(args: Vec<String>) -> Result<Vec<String>, String> {
    if args
        .iter()
        .any(|arg| arg == CWD_FLAG || arg.starts_with("--cwd="))
    {
        return Ok(args);
    }

    let current_dir = env::current_dir()
        .map_err(|error| format!("Unable to resolve the current working directory: {error}"))?;
    let mut resolved_args = Vec::with_capacity(args.len() + 2);

    resolved_args.push("--cwd".to_string());
    resolved_args.push(current_dir.display().to_string());
    resolved_args.extend(args);

    Ok(resolved_args)
}

fn has_non_ui_startup_args(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg.as_str() != desktop_shell::AUTOSTART_LAUNCH_ARG)
}

fn contains_exact_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

fn ensure_ui_supported() -> Result<(), String> {
    if is_ui_supported() {
        return Ok(());
    }

    Err(format!(
        "The desktop UI is not supported in this environment. {} Use --cli or --quick for terminal execution.",
        ui_unsupported_reason()
    ))
}

fn is_ui_supported() -> bool {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        env_var_has_value("DISPLAY") || env_var_has_value("WAYLAND_DISPLAY")
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        true
    }

    #[cfg(not(any(unix, target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

fn ui_unsupported_reason() -> &'static str {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "No graphical Linux session was detected because neither DISPLAY nor WAYLAND_DISPLAY is set."
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        "The platform did not expose a supported desktop session."
    }

    #[cfg(not(any(unix, target_os = "windows", target_os = "macos")))]
    {
        "This platform is not supported by the desktop UI."
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn env_var_has_value(name: &str) -> bool {
    env::var(name)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}
