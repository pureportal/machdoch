use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::CloseHandle,
    System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

use super::{configure_child_process_group, ChildCleanupKind, SupervisedChild};

const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_CHILD_PROCESS_TEST_MODE";
const TEST_DESCENDANT_PID_PATH_ENV: &str = "MACHDOCH_CHILD_PROCESS_TEST_PID_PATH";
static NEXT_TEST_PATH_ID: AtomicU64 = AtomicU64::new(0);

struct TestPath(PathBuf);

impl TestPath {
    fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_TEST_PATH_ID.fetch_add(1, Ordering::Relaxed);
        Self(env::temp_dir().join(format!(
            "machdoch-child-process-test-{}-{timestamp}-{sequence}.pid",
            std::process::id()
        )))
    }
}

impl Drop for TestPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn test_child_command(mode: &str) -> Command {
    let mut command = Command::new(env::current_exe().expect("test executable should resolve"));
    command
        .arg("--exact")
        .arg("tests::child_process_supervision_test_entrypoint")
        .arg("--nocapture")
        .env(TEST_CHILD_MODE_ENV, mode);
    command
}

#[test]
fn child_process_supervision_test_entrypoint() {
    match env::var(TEST_CHILD_MODE_ENV).as_deref() {
        Ok("exit") => {}
        Ok("short") => thread::sleep(Duration::from_millis(75)),
        Ok("hold") => thread::sleep(Duration::from_secs(60)),
        Ok("ignore-term") => {
            #[cfg(unix)]
            unsafe {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
            }
            let ready_path = env::var_os("MACHDOCH_TEST_CHILD_READY_PATH")
                .map(PathBuf::from)
                .expect("child readiness path should be provided");
            fs::write(ready_path, std::process::id().to_string())
                .expect("child readiness should be recorded");
            thread::sleep(Duration::from_secs(60));
        }
        Ok("spawn-descendant") | Ok("spawn-descendant-and-exit") => {
            let pid_path = env::var_os(TEST_DESCENDANT_PID_PATH_ENV)
                .map(PathBuf::from)
                .expect("descendant pid path should be provided");
            let mut descendant = test_child_command("hold");
            descendant
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let descendant = descendant
                .spawn()
                .expect("descendant test process should start");
            fs::write(pid_path, descendant.id().to_string())
                .expect("descendant pid should be recorded");
            drop(descendant);

            if env::var(TEST_CHILD_MODE_ENV).as_deref() == Ok("spawn-descendant") {
                thread::sleep(Duration::from_secs(60));
            }
        }
        _ => {}
    }
}

#[cfg(target_os = "windows")]
#[test]
fn direct_process_group_configuration_does_not_suspend_child() {
    let mut command = test_child_command("exit");
    configure_child_process_group(&mut command);
    let mut child = command.spawn().expect("direct test child should start");
    let deadline = Instant::now() + Duration::from_secs(3);

    loop {
        match child
            .try_wait()
            .expect("direct child should remain observable")
        {
            Some(status) => {
                assert!(status.success());
                break;
            }
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            None => {
                super::terminate_child_process_tree(&mut child);
                let _ = child.wait();
                panic!("direct process-group child remained suspended");
            }
        }
    }
}

fn wait_for_recorded_test_pid(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(pid) = fs::read_to_string(path) {
            if let Ok(pid) = pid.trim().parse::<u32>() {
                return pid;
            }
        }
        assert!(
            Instant::now() < deadline,
            "test process pid was not recorded before the test deadline"
        );
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(target_os = "windows")]
fn process_is_alive(pid: u32) -> bool {
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let mut exit_code = 0_u32;
                let alive = GetExitCodeProcess(handle, &mut exit_code).is_ok() && exit_code == 259;
                let _ = CloseHandle(handle);
                alive
            }
            Err(_) => false,
        }
    }
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn assert_process_stops(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while process_is_alive(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(!process_is_alive(pid), "descendant process {pid} survived");
}

fn stop_test_process(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        super::terminate_child_process_tree_by_id(pid);
    }

    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

struct TestProcessGuard(Option<u32>);

impl TestProcessGuard {
    fn stop(mut self) {
        let pid = self.0.take().expect("test process should be available");
        stop_test_process(pid);
        assert_process_stops(pid);
    }
}

impl Drop for TestProcessGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            stop_test_process(pid);
        }
    }
}

#[test]
fn supervised_child_preserves_natural_exit_status() {
    let mut child = SupervisedChild::spawn(&mut test_child_command("exit"))
        .expect("supervised test child should start");
    let status = loop {
        if let Some(status) = child.try_wait().expect("child should remain observable") {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };

    assert!(status.success());
    let cleanup = child
        .terminate_and_reap()
        .expect("already-exited cleanup should succeed");
    assert_eq!(cleanup.kind, ChildCleanupKind::AlreadyExited);
    assert_eq!(cleanup.status.code(), status.code());
}

#[test]
fn supervised_child_forcibly_terminates_and_reaps() {
    let mut child = SupervisedChild::spawn(&mut test_child_command("hold"))
        .expect("supervised test child should start");
    let cleanup = child
        .terminate_and_reap()
        .expect("running child should be terminated and reaped");

    assert_ne!(cleanup.kind, ChildCleanupKind::AlreadyExited);
    assert!(!cleanup.status.success());
}

#[cfg(unix)]
#[test]
fn supervised_child_escalates_when_graceful_termination_is_ignored() {
    let ready_path = TestPath::new();
    let mut command = test_child_command("ignore-term");
    command.env("MACHDOCH_TEST_CHILD_READY_PATH", &ready_path.0);
    let mut child =
        SupervisedChild::spawn(&mut command).expect("supervised test child should start");
    assert_eq!(wait_for_recorded_test_pid(&ready_path.0), child.child.id());
    let cleanup = child
        .terminate_and_reap()
        .expect("uncooperative child should be forcibly terminated");

    assert_eq!(cleanup.kind, ChildCleanupKind::ForceTerminated);
}

#[test]
fn supervised_child_termination_stops_descendants() {
    let pid_path = TestPath::new();
    let mut command = test_child_command("spawn-descendant");
    command.env(TEST_DESCENDANT_PID_PATH_ENV, &pid_path.0);
    let mut child = SupervisedChild::spawn_with_required_isolation(&mut command)
        .expect("supervised descendant parent should start");
    let descendant_pid = wait_for_recorded_test_pid(&pid_path.0);

    child
        .terminate_and_reap()
        .expect("process tree should be terminated and reaped");
    assert_process_stops(descendant_pid);
}

#[test]
fn natural_parent_exit_stops_residual_descendants() {
    let pid_path = TestPath::new();
    let mut command = test_child_command("spawn-descendant-and-exit");
    command.env(TEST_DESCENDANT_PID_PATH_ENV, &pid_path.0);
    let mut child = SupervisedChild::spawn_with_required_isolation(&mut command)
        .expect("supervised descendant parent should start");
    let descendant_pid = wait_for_recorded_test_pid(&pid_path.0);
    let status = loop {
        if let Some(status) = child.try_wait().expect("parent should remain observable") {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };

    assert!(status.success());
    assert_process_stops(descendant_pid);
}

#[test]
fn persistent_descendant_mode_preserves_descendants_after_parent_exit() {
    let pid_path = TestPath::new();
    let mut command = test_child_command("spawn-descendant-and-exit");
    command.env(TEST_DESCENDANT_PID_PATH_ENV, &pid_path.0);
    let mut child = SupervisedChild::spawn_preserving_descendants_after_exit(&mut command)
        .expect("persistent-descendant parent should start");
    let descendant_pid = wait_for_recorded_test_pid(&pid_path.0);
    let guard = TestProcessGuard(Some(descendant_pid));
    let status = loop {
        if let Some(status) = child.try_wait().expect("parent should remain observable") {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };

    assert!(status.success());
    assert!(process_is_alive(descendant_pid));
    guard.stop();
}

#[test]
fn supervised_child_cleanup_is_repeatable() {
    let mut child = SupervisedChild::spawn(&mut test_child_command("hold"))
        .expect("supervised test child should start");
    child
        .terminate_and_reap()
        .expect("initial cleanup should succeed");
    assert_eq!(child.tree_termination_attempts, 1);
    let repeated = child
        .terminate_and_reap()
        .expect("repeated cleanup should be idempotent");

    assert_eq!(repeated.kind, ChildCleanupKind::AlreadyExited);
    assert_eq!(child.tree_termination_attempts, 1);
}

#[test]
fn cancellation_race_with_natural_exit_is_idempotent() {
    let mut child = SupervisedChild::spawn(&mut test_child_command("short"))
        .expect("supervised test child should start");
    thread::sleep(Duration::from_millis(50));

    child
        .terminate_and_reap()
        .expect("racing cleanup should succeed");
    assert_eq!(
        child
            .terminate_and_reap()
            .expect("post-race cleanup should remain idempotent")
            .kind,
        ChildCleanupKind::AlreadyExited
    );
}
