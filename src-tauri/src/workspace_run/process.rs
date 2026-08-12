use std::{ffi::OsString, process::Command};

pub fn create_run_command(command: &str) -> Command {
    let (program, arguments) = shell_program_and_arguments(command);
    let mut process = Command::new(program);
    process.args(arguments);
    process
}

fn shell_program_and_arguments(command: &str) -> (OsString, Vec<OsString>) {
    #[cfg(target_os = "windows")]
    {
        (
            OsString::from("cmd.exe"),
            vec![
                OsString::from("/D"),
                OsString::from("/S"),
                OsString::from("/C"),
                OsString::from(command),
            ],
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        (
            OsString::from("/bin/sh"),
            vec![OsString::from("-c"), OsString::from(command)],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_platform_shell_without_changing_the_command() {
        let command = "printf 'hello world'";
        let (program, arguments) = shell_program_and_arguments(command);

        #[cfg(target_os = "windows")]
        {
            assert_eq!(program, OsString::from("cmd.exe"));
            assert_eq!(arguments.last(), Some(&OsString::from(command)));
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(program, OsString::from("/bin/sh"));
            assert_eq!(
                arguments,
                vec![OsString::from("-c"), OsString::from(command)]
            );
        }
    }
}
