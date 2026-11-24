use std::{env, ffi::OsString, path::PathBuf, process::Command, sync::OnceLock};

const LOCAL_SUBCOMMANDS: [&str; 22] = [
    "add",
    "apply",
    "blame",
    "cat-file",
    "check-ref-format",
    "config",
    "diff",
    "diff-tree",
    "for-each-ref",
    "log",
    "ls-files",
    "merge-base",
    "reflog",
    "restore",
    "rev-list",
    "rev-parse",
    "rm",
    "show",
    "status",
    "symbolic-ref",
    "update-index",
    "version",
];

const CONSOLE_FREE_SUBCOMMANDS: [&str; 12] = [
    "cat-file",
    "check-ref-format",
    "config",
    "diff-tree",
    "for-each-ref",
    "log",
    "merge-base",
    "reflog",
    "rev-list",
    "rev-parse",
    "symbolic-ref",
    "version",
];

struct DirectGit {
    program: PathBuf,
    search_path: OsString,
}

static DIRECT_GIT: OnceLock<Option<DirectGit>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn resolve_direct_git() -> Option<DirectGit> {
    use std::os::windows::process::CommandExt;

    let output = Command::new("git")
        .arg("--exec-path")
        .creation_flags(super::CREATE_NO_WINDOW)
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let exec_path = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    let toolchain = exec_path.parent()?.parent()?;
    let program = toolchain.join("bin").join("git.exe");
    if !program.is_file() {
        return None;
    }
    let installation = toolchain.parent()?;
    let mut directories = vec![toolchain.join("bin"), installation.join("usr").join("bin")];
    directories.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
    Some(DirectGit {
        program,
        search_path: env::join_paths(directories).ok()?,
    })
}

#[cfg(not(target_os = "windows"))]
fn resolve_direct_git() -> Option<DirectGit> {
    None
}

fn subcommand<'a>(arguments: &[&'a str]) -> Option<&'a str> {
    let mut remaining = arguments.iter();
    while let Some(argument) = remaining.next() {
        if *argument == "-c" {
            remaining.next();
        } else if !argument.starts_with('-') {
            return Some(argument);
        }
    }
    None
}

pub(super) fn runs_without_console(program: &str, arguments: &[&str]) -> bool {
    program == "git"
        && subcommand(arguments).is_some_and(|name| CONSOLE_FREE_SUBCOMMANDS.contains(&name))
}

pub(super) fn command(program: &str, arguments: &[&str]) -> Command {
    let local = program == "git"
        && subcommand(arguments).is_some_and(|name| LOCAL_SUBCOMMANDS.contains(&name));
    match DIRECT_GIT.get_or_init(resolve_direct_git) {
        Some(direct) if local => {
            let mut command = Command::new(&direct.program);
            command.env("PATH", &direct.search_path);
            command
        }
        _ => Command::new(program),
    }
}

#[cfg(test)]
mod tests {
    use super::{runs_without_console, subcommand};

    #[test]
    fn only_plumbing_that_starts_no_helpers_runs_without_a_console() {
        assert!(runs_without_console(
            "git",
            &["-c", "core.quotepath=false", "diff-tree", "-r", "HEAD"]
        ));
        assert!(runs_without_console(
            "git",
            &["rev-parse", "--show-toplevel"]
        ));
        assert!(!runs_without_console("git", &["status", "--porcelain=v2"]));
        assert!(!runs_without_console("git", &["add", "--", "file.txt"]));
        assert!(!runs_without_console("git", &["fetch", "origin"]));
        assert!(!runs_without_console("gh", &["pr", "list"]));
    }

    #[test]
    fn finds_the_subcommand_after_global_options() {
        assert_eq!(
            subcommand(&["-c", "core.fsmonitor=true", "status", "--porcelain=v2"]),
            Some("status")
        );
        assert_eq!(
            subcommand(&["--no-literal-pathspecs", "stash", "push"]),
            Some("stash")
        );
        assert_eq!(subcommand(&["--exec-path"]), None);
    }
}
