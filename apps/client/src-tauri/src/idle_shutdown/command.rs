use std::time::Duration;
use tokio::process::Command;

pub(super) async fn run(mut command: Command, timeout: Duration) -> Result<(), String> {
    command.kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| "PC shutdown failed: the shutdown command timed out.".to_string())?
        .map_err(|error| format!("PC shutdown failed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let details = [
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    ]
    .iter()
    .map(|text| text.trim())
    .filter(|text| !text.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    Err(format!("PC shutdown failed ({}): {details}", output.status))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(case: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "idle_shutdown::command::tests::shutdown_command_fixture",
                "--nocapture",
            ])
            .env("MACHDOCH_SHUTDOWN_TEST_CASE", case);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
    }

    #[test]
    fn shutdown_command_fixture() {
        match std::env::var("MACHDOCH_SHUTDOWN_TEST_CASE").as_deref() {
            Ok("failure") => {
                println!("stdout diagnostic");
                eprintln!("stderr diagnostic");
                std::process::exit(7);
            }
            Ok("timeout") => std::thread::sleep(Duration::from_secs(60)),
            _ => {}
        }
    }

    #[tokio::test]
    async fn accepts_a_successful_command() {
        run(fixture("success"), Duration::from_secs(10))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn reports_exit_status_and_both_output_streams() {
        let error = run(fixture("failure"), Duration::from_secs(10))
            .await
            .unwrap_err();
        assert!(error.contains("7"));
        assert!(error.contains("stdout diagnostic"));
        assert!(error.contains("stderr diagnostic"));
    }

    #[tokio::test]
    async fn reports_spawn_failures() {
        let command = Command::new("machdoch-shutdown-test-executable-that-does-not-exist");
        assert!(run(command, Duration::from_secs(10))
            .await
            .unwrap_err()
            .starts_with("PC shutdown failed:"));
    }

    #[tokio::test]
    async fn terminates_a_hung_command_within_the_deadline() {
        let started = std::time::Instant::now();
        let error = run(fixture("timeout"), Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
