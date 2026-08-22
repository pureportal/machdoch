use std::sync::{Arc, Mutex};

trait SleepInhibitionLease: Send {}

impl<T: Send> SleepInhibitionLease for T {}

trait SleepInhibitionBackend: Send + Sync {
    fn acquire(&self) -> Result<Box<dyn SleepInhibitionLease>, String>;
}

struct SleepInhibitionState {
    active_count: usize,
    platform_lease: Option<Box<dyn SleepInhibitionLease>>,
    shutting_down: bool,
}

struct SleepInhibitionCore {
    backend: Box<dyn SleepInhibitionBackend>,
    state: Mutex<SleepInhibitionState>,
}

impl SleepInhibitionCore {
    fn acquire(self: &Arc<Self>) -> Result<SystemSleepInhibitionGuard, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if state.shutting_down {
            return Err("Machdoch is shutting down and cannot start new work.".to_string());
        }

        if state.active_count == 0 {
            state.platform_lease = Some(self.backend.acquire()?);
        }
        state.active_count += 1;

        Ok(SystemSleepInhibitionGuard {
            core: Arc::clone(self),
        })
    }

    fn release(&self) {
        let platform_lease = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if state.shutting_down || state.active_count == 0 {
                return;
            }

            state.active_count -= 1;
            if state.active_count == 0 {
                state.platform_lease.take()
            } else {
                None
            }
        };

        drop(platform_lease);
    }

    fn shutdown(&self) {
        let platform_lease = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.shutting_down = true;
            state.active_count = 0;
            state.platform_lease.take()
        };

        drop(platform_lease);
    }
}

pub(crate) struct SystemSleepInhibitor {
    core: Arc<SleepInhibitionCore>,
}

impl SystemSleepInhibitor {
    fn new(backend: Box<dyn SleepInhibitionBackend>) -> Self {
        Self {
            core: Arc::new(SleepInhibitionCore {
                backend,
                state: Mutex::new(SleepInhibitionState {
                    active_count: 0,
                    platform_lease: None,
                    shutting_down: false,
                }),
            }),
        }
    }

    pub(crate) fn acquire(&self) -> Result<SystemSleepInhibitionGuard, String> {
        self.core.acquire()
    }

    pub(crate) fn shutdown(&self) {
        self.core.shutdown();
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.core
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active_count
    }
}

impl Default for SystemSleepInhibitor {
    fn default() -> Self {
        Self::new(Box::new(platform::Backend))
    }
}

impl Drop for SystemSleepInhibitor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) struct SystemSleepInhibitionGuard {
    core: Arc<SleepInhibitionCore>,
}

impl Drop for SystemSleepInhibitionGuard {
    fn drop(&mut self) {
        self.core.release();
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::{
                Power::{
                    PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired,
                    PowerSetRequest,
                },
                Threading::{
                    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
                },
            },
        },
    };

    pub(super) struct Backend;

    struct WindowsSleepInhibition {
        handle: HANDLE,
    }

    unsafe impl Send for WindowsSleepInhibition {}

    impl super::SleepInhibitionBackend for Backend {
        fn acquire(&self) -> Result<Box<dyn super::SleepInhibitionLease>, String> {
            let mut reason = "Machdoch has active work"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let context = REASON_CONTEXT {
                Version: 0,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: PWSTR(reason.as_mut_ptr()),
                },
            };
            let handle = unsafe { PowerCreateRequest(&context) }
                .map_err(|error| format!("Failed to create a Windows sleep request: {error}"))?;

            if let Err(error) = unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } {
                let _ = unsafe { CloseHandle(handle) };
                return Err(format!("Failed to prevent Windows system sleep: {error}"));
            }

            Ok(Box::new(WindowsSleepInhibition { handle }))
        }
    }

    impl Drop for WindowsSleepInhibition {
        fn drop(&mut self) {
            let _ = unsafe { PowerClearRequest(self.handle, PowerRequestSystemRequired) };
            let _ = unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        io::{Read, Write},
        process::{Child, ChildStdin, Command, Stdio},
        sync::mpsc,
        thread,
        time::Duration,
    };

    const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(2);
    const RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(10);
    const RELEASE_POLL_ATTEMPTS: usize = 25;

    pub(super) struct Backend;

    struct LinuxSleepInhibition {
        child: Child,
        stdin: Option<ChildStdin>,
    }

    impl super::SleepInhibitionBackend for Backend {
        fn acquire(&self) -> Result<Box<dyn super::SleepInhibitionLease>, String> {
            let mut child = Command::new("systemd-inhibit")
                .args([
                    "--what=sleep",
                    "--who=machdoch",
                    "--why=Machdoch has active work",
                    "--mode=block",
                    "tee",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| {
                    format!("Failed to start the Linux system sleep inhibitor: {error}")
                })?;
            let mut stdin = match child.stdin.take() {
                Some(stdin) => stdin,
                None => {
                    stop_child(&mut child);
                    return Err(
                        "The Linux system sleep inhibitor did not expose a control stream."
                            .to_string(),
                    );
                }
            };
            let mut stdout = match child.stdout.take() {
                Some(stdout) => stdout,
                None => {
                    drop(stdin);
                    stop_child(&mut child);
                    return Err(
                        "The Linux system sleep inhibitor did not expose a readiness stream."
                            .to_string(),
                    );
                }
            };
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let ready_worker = thread::spawn(move || {
                let mut marker = [0_u8; 1];
                let result = stdout.read_exact(&mut marker);
                let _ = ready_tx.send(result);
            });

            let readiness = stdin
                .write_all(&[0])
                .and_then(|_| stdin.flush())
                .map_err(|error| format!("Failed to contact the Linux sleep inhibitor: {error}"))
                .and_then(|_| {
                    ready_rx.recv_timeout(ACQUIRE_TIMEOUT).map_err(|error| {
                        format!("Timed out while acquiring the Linux system sleep inhibitor: {error}")
                    })?
                    .map_err(|error| {
                        format!("The Linux system sleep inhibitor exited before it was ready: {error}")
                    })
                });

            if let Err(error) = readiness {
                drop(stdin);
                stop_child(&mut child);
                let _ = ready_worker.join();
                let diagnostic = child
                    .stderr
                    .take()
                    .and_then(|mut stderr| {
                        let mut output = String::new();
                        stderr.read_to_string(&mut output).ok()?;
                        let output = output.trim();
                        (!output.is_empty()).then(|| output.to_string())
                    })
                    .map(|output| format!(" {output}"))
                    .unwrap_or_default();
                return Err(format!("{error}.{diagnostic}"));
            }

            let _ = ready_worker.join();
            Ok(Box::new(LinuxSleepInhibition {
                child,
                stdin: Some(stdin),
            }))
        }
    }

    impl Drop for LinuxSleepInhibition {
        fn drop(&mut self) {
            self.stdin.take();

            for _ in 0..RELEASE_POLL_ATTEMPTS {
                if self.child.try_wait().ok().flatten().is_some() {
                    return;
                }
                thread::sleep(RELEASE_POLL_INTERVAL);
            }

            stop_child(&mut self.child);
        }
    }

    fn stop_child(child: &mut Child) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
mod platform {
    pub(super) struct Backend;

    impl super::SleepInhibitionBackend for Backend {
        fn acquire(&self) -> Result<Box<dyn super::SleepInhibitionLease>, String> {
            Ok(Box::new(()))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    use super::*;

    #[derive(Default)]
    struct TestBackendState {
        acquisitions: AtomicUsize,
        releases: AtomicUsize,
        fail_acquisition: AtomicBool,
    }

    struct TestBackend(Arc<TestBackendState>);

    struct TestLease(Arc<TestBackendState>);

    impl SleepInhibitionBackend for TestBackend {
        fn acquire(&self) -> Result<Box<dyn SleepInhibitionLease>, String> {
            self.0.acquisitions.fetch_add(1, Ordering::SeqCst);
            if self.0.fail_acquisition.load(Ordering::SeqCst) {
                return Err("test acquisition failed".to_string());
            }
            Ok(Box::new(TestLease(Arc::clone(&self.0))))
        }
    }

    impl Drop for TestLease {
        fn drop(&mut self) {
            self.0.releases.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn test_inhibitor(state: &Arc<TestBackendState>) -> SystemSleepInhibitor {
        SystemSleepInhibitor::new(Box::new(TestBackend(Arc::clone(state))))
    }

    #[test]
    fn inactive_state_does_not_acquire_platform_inhibition() {
        let state = Arc::new(TestBackendState::default());
        let inhibitor = test_inhibitor(&state);

        assert_eq!(inhibitor.active_count(), 0);
        assert_eq!(state.acquisitions.load(Ordering::SeqCst), 0);
        assert_eq!(state.releases.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_single_activity_acquires_and_releases_platform_inhibition() {
        let state = Arc::new(TestBackendState::default());
        let inhibitor = test_inhibitor(&state);
        let guard = inhibitor.acquire().unwrap();

        assert_eq!(inhibitor.active_count(), 1);
        assert_eq!(state.acquisitions.load(Ordering::SeqCst), 1);
        assert_eq!(state.releases.load(Ordering::SeqCst), 0);

        drop(guard);

        assert_eq!(inhibitor.active_count(), 0);
        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn overlapping_activities_share_inhibition_until_the_last_finishes() {
        let state = Arc::new(TestBackendState::default());
        let inhibitor = test_inhibitor(&state);
        let first = inhibitor.acquire().unwrap();
        let second = inhibitor.acquire().unwrap();

        assert_eq!(inhibitor.active_count(), 2);
        assert_eq!(state.acquisitions.load(Ordering::SeqCst), 1);

        drop(first);

        assert_eq!(inhibitor.active_count(), 1);
        assert_eq!(state.releases.load(Ordering::SeqCst), 0);

        drop(second);

        assert_eq!(inhibitor.active_count(), 0);
        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn completion_cancellation_and_errors_all_release_their_guard() {
        let state = Arc::new(TestBackendState::default());
        let inhibitor = test_inhibitor(&state);

        for _ in 0..3 {
            let guard = inhibitor.acquire().unwrap();
            drop(guard);
        }

        assert_eq!(inhibitor.active_count(), 0);
        assert_eq!(state.acquisitions.load(Ordering::SeqCst), 3);
        assert_eq!(state.releases.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn failed_platform_acquisition_does_not_mark_activity_active() {
        let state = Arc::new(TestBackendState::default());
        state.fail_acquisition.store(true, Ordering::SeqCst);
        let inhibitor = test_inhibitor(&state);

        assert!(inhibitor.acquire().is_err());
        assert_eq!(inhibitor.active_count(), 0);
        assert_eq!(state.releases.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn shutdown_releases_once_and_invalidates_outstanding_guards() {
        let state = Arc::new(TestBackendState::default());
        let inhibitor = test_inhibitor(&state);
        let first = inhibitor.acquire().unwrap();
        let second = inhibitor.acquire().unwrap();

        inhibitor.shutdown();
        inhibitor.shutdown();

        assert_eq!(inhibitor.active_count(), 0);
        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
        assert!(inhibitor.acquire().is_err());

        drop(first);
        drop(second);
        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_the_owner_releases_inhibition_during_process_cleanup() {
        let state = Arc::new(TestBackendState::default());
        let inhibitor = test_inhibitor(&state);
        let guard = inhibitor.acquire().unwrap();

        drop(inhibitor);

        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
        drop(guard);
        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
    }
}
