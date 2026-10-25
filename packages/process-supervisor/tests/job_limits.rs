#![cfg(windows)]

use machdoch_process::SupervisedChild;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use windows::Win32::System::{
    JobObjects::{
        JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
        JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    Threading::{GetActiveProcessorCount, ALL_PROCESSOR_GROUPS, CREATE_NO_WINDOW},
};

const MODE: &str = "MACHDOCH_VERIFY_JOB_LIMITS";
const TEST: &str = "job_limits_are_applied_before_execution";

fn command(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", TEST, "--nocapture", "--test-threads=1"])
        .env(MODE, mode)
        .env("RUST_BACKTRACE", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW.0);
    command
}

#[test]
fn job_limits_are_applied_before_execution() {
    match std::env::var(MODE).as_deref() {
        Ok("hold") => {
            println!("MACHDOCH_JOB_READY");
            std::io::stdout().flush().unwrap();
            loop {
                thread::park();
            }
        }
        Ok("probe") => {
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    None,
                    JobObjectExtendedLimitInformation,
                    (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                    None,
                )
                .unwrap();
                QueryInformationJobObject(
                    None,
                    JobObjectCpuRateControlInformation,
                    (&mut cpu as *mut JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
                    std::mem::size_of_val(&cpu) as u32,
                    None,
                )
                .unwrap();
                assert_eq!(
                    cpu.Anonymous.CpuRate,
                    10000 / GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)
                );
            }
            assert_eq!(limits.JobMemoryLimit, 128 * 1024 * 1024);
            assert_eq!(limits.BasicLimitInformation.ActiveProcessLimit, 4);
            assert_ne!(
                limits.BasicLimitInformation.LimitFlags.0 & JOB_OBJECT_LIMIT_ACTIVE_PROCESS.0,
                0
            );
            assert_ne!(
                limits.BasicLimitInformation.LimitFlags.0 & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0,
                0
            );
            assert_eq!(
                cpu.ControlFlags,
                JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
            );
            let mut children = Vec::new();
            for _ in 0..3 {
                let mut child = command("hold").stderr(Stdio::null()).spawn().unwrap();
                let mut output = BufReader::new(child.stdout.take().unwrap());
                loop {
                    let mut line = String::new();
                    assert!(
                        output.read_line(&mut line).unwrap() > 0,
                        "Child exited before becoming ready"
                    );
                    if line.contains("MACHDOCH_JOB_READY") {
                        break;
                    }
                }
                children.push(child);
            }
            let extra = command("hold")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            assert!(
                extra.is_err(),
                "The process limit did not reject an additional child"
            );
            for mut child in children {
                child.kill().unwrap();
                child.wait().unwrap();
            }
            println!("MACHDOCH_JOB_LIMITS_VERIFIED");
        }
        _ => {
            let mut child = SupervisedChild::spawn_with_job_limits(
                &mut command("probe"),
                128 * 1024 * 1024,
                4,
                1,
            )
            .unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let output = thread::spawn(move || {
                let mut value = String::new();
                stdout.read_to_string(&mut value).unwrap();
                value
            });
            let errors = thread::spawn(move || {
                let mut value = String::new();
                stderr.read_to_string(&mut value).unwrap();
                value
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if Instant::now() >= deadline {
                    let _ = child.terminate_and_reap();
                    panic!("The resource probe did not finish");
                }
                thread::sleep(Duration::from_millis(10));
            };
            let output = output.join().unwrap();
            let errors = errors.join().unwrap();
            child.confirm_isolation_stopped().unwrap();
            assert!(status.success(), "{output}\n{errors}");
            assert!(output.contains("MACHDOCH_JOB_LIMITS_VERIFIED"));
        }
    }
}
