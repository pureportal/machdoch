use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    process::{Child, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, TryRecvError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{
    child_process::{
        assign_child_process_to_kill_on_close_job, configure_child_process_group,
        terminate_child_process_tree, ChildProcessJob,
    },
    runtime_snapshot::resolve_workspace_root_path,
};

use super::{
    health::check_health,
    model::{
        CompositeStartOrder, RunConfiguration, RunConfigurationDocument, RunConfigurationStatus,
        RunFailure, RunFailureKind, RunHealthCheck, RunHealthState, RunHealthStatus,
        RunLifecycleState, RunLogBatch, RunLogEntry, RunLogStream, RunLogUpdate, RunRestartPolicy,
        RunWorkspaceSnapshot, MAX_FAILURE_ENTRIES, MAX_LOG_ENTRIES,
    },
    persistence::{load_document, resolve_working_directory, save_document},
    process::create_run_command,
};

type EventSink = Arc<dyn Fn(RunWorkspaceSnapshot) + Send + Sync>;
type LogEventSink = Arc<dyn Fn(RunLogBatch) + Send + Sync>;
const MAX_LOG_LINE_BYTES: usize = 4_096;
const LOG_EVENT_DELAY: Duration = Duration::from_millis(150);
const LOG_READER_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_LOG_EVENT_ENTRIES: usize = 200;

struct TaskRuntime {
    state: RunLifecycleState,
    pid: Option<u32>,
    started_at: Option<u64>,
    stopped_at: Option<u64>,
    exit_code: Option<i32>,
    restart_count: u32,
    health: Option<RunHealthStatus>,
    recent_failures: VecDeque<RunFailure>,
    logs: VecDeque<RunLogEntry>,
    cancel: Option<Arc<AtomicBool>>,
    generation: u64,
}

struct LogReaderWorker {
    done: Receiver<()>,
    worker: JoinHandle<()>,
}

struct AttemptMonitorContext<'a> {
    workspace: &'a Path,
    configuration_id: &'a str,
    generation: u64,
    cancel: &'a AtomicBool,
    health_check: Option<&'a RunHealthCheck>,
}

impl LogReaderWorker {
    fn join(self) {
        if self.done.recv_timeout(LOG_READER_JOIN_TIMEOUT).is_ok() {
            let _ = self.worker.join();
        }
    }
}

impl Default for TaskRuntime {
    fn default() -> Self {
        Self {
            state: RunLifecycleState::Stopped,
            pid: None,
            started_at: None,
            stopped_at: None,
            exit_code: None,
            restart_count: 0,
            health: None,
            recent_failures: VecDeque::new(),
            logs: VecDeque::new(),
            cancel: None,
            generation: 0,
        }
    }
}

#[derive(Default)]
struct WorkspaceRuntime {
    tasks: HashMap<String, TaskRuntime>,
    composite_cancellations: HashMap<String, Arc<AtomicBool>>,
    document: Option<RunConfigurationDocument>,
}

#[derive(Default)]
struct ManagerInner {
    workspaces: HashMap<PathBuf, WorkspaceRuntime>,
    next_generation: u64,
    next_log_sequence: u64,
    pending_log_batches: HashMap<PathBuf, VecDeque<RunLogUpdate>>,
    shutdown: bool,
}

pub struct RunManager {
    inner: Mutex<ManagerInner>,
    operation_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    event_sink: Mutex<Option<EventSink>>,
    log_event_sink: Mutex<Option<LogEventSink>>,
}

impl Default for RunManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(ManagerInner::default()),
            operation_locks: Mutex::new(HashMap::new()),
            event_sink: Mutex::new(None),
            log_event_sink: Mutex::new(None),
        }
    }
}

impl RunManager {
    pub fn set_event_sink(&self, event_sink: EventSink) {
        if let Ok(mut sink) = self.event_sink.lock() {
            *sink = Some(event_sink);
        }
    }

    pub fn set_log_event_sink(&self, event_sink: LogEventSink) {
        if let Ok(mut sink) = self.log_event_sink.lock() {
            *sink = Some(event_sink);
        }
    }

    pub fn load_configuration_document(
        &self,
        workspace_root: &str,
    ) -> Result<RunConfigurationDocument, String> {
        let workspace = resolve_workspace_root_path(workspace_root)?;
        let document = load_document(&workspace)?;
        self.remember_document(&workspace, &document);
        Ok(document)
    }

    pub fn save_configuration_document(
        &self,
        workspace_root: &str,
        document: &RunConfigurationDocument,
    ) -> Result<RunWorkspaceSnapshot, String> {
        let workspace = resolve_workspace_root_path(workspace_root)?;
        let operation_lock = self.operation_lock(&workspace)?;
        let _operation = operation_lock
            .lock()
            .map_err(|_| "Workspace run operations are unavailable.".to_string())?;
        if self.workspace_has_active_tasks(&workspace) {
            return Err("Stop workspace run configurations before saving changes.".to_string());
        }
        save_document(&workspace, document)?;
        if let Ok(mut inner) = self.inner.lock() {
            let workspace_runtime = inner.workspaces.entry(workspace.clone()).or_default();
            workspace_runtime.document = Some(document.clone());
            workspace_runtime.tasks.retain(|configuration_id, _| {
                document
                    .configurations
                    .iter()
                    .any(|configuration| configuration.id() == configuration_id)
            });
        }
        let snapshot = self.snapshot_for_path(&workspace, document)?;
        self.emit(snapshot.clone());
        Ok(snapshot)
    }

    pub fn snapshot(&self, workspace_root: &str) -> Result<RunWorkspaceSnapshot, String> {
        let workspace = resolve_workspace_root_path(workspace_root)?;
        let document = self.snapshot_document(&workspace)?;
        self.snapshot_for_path(&workspace, &document)
    }

    pub fn start(
        self: &Arc<Self>,
        workspace_root: &str,
        configuration_id: Option<&str>,
    ) -> Result<RunWorkspaceSnapshot, String> {
        let workspace = resolve_workspace_root_path(workspace_root)?;
        let operation_lock = self.operation_lock(&workspace)?;
        let _operation = operation_lock
            .lock()
            .map_err(|_| "Workspace run operations are unavailable.".to_string())?;
        if let Some(document) = self.active_configuration_document(&workspace, configuration_id) {
            return self.snapshot_for_path(&workspace, &document);
        }
        let document = self.configuration_document_for_start(&workspace)?;
        let configuration = resolve_configuration(&document, configuration_id)?.clone();
        self.start_resolved_configuration(workspace.clone(), document.clone(), configuration)?;
        self.snapshot_for_path(&workspace, &document)
    }

    pub fn stop(
        &self,
        workspace_root: &str,
        configuration_id: Option<&str>,
    ) -> Result<RunWorkspaceSnapshot, String> {
        let workspace = resolve_workspace_root_path(workspace_root)?;
        let operation_lock = self.operation_lock(&workspace)?;
        let _operation = operation_lock
            .lock()
            .map_err(|_| "Workspace run operations are unavailable.".to_string())?;
        let document = self.configuration_document_for_operation(&workspace)?;
        let configuration = resolve_configuration(&document, configuration_id)?;
        self.stop_resolved_configuration(&workspace, configuration);
        let snapshot = self.snapshot_for_path(&workspace, &document)?;
        self.emit(snapshot.clone());
        Ok(snapshot)
    }

    pub fn restart(
        self: &Arc<Self>,
        workspace_root: &str,
        configuration_id: Option<&str>,
    ) -> Result<RunWorkspaceSnapshot, String> {
        let workspace = resolve_workspace_root_path(workspace_root)?;
        let operation_lock = self.operation_lock(&workspace)?;
        let _operation = operation_lock
            .lock()
            .map_err(|_| "Workspace run operations are unavailable.".to_string())?;
        let document = self.configuration_document_for_operation(&workspace)?;
        let configuration = resolve_configuration(&document, configuration_id)?.clone();
        self.stop_resolved_configuration(&workspace, &configuration);
        self.wait_for_configuration_stop(&workspace, &configuration, Duration::from_secs(15))?;
        self.start_resolved_configuration(workspace.clone(), document.clone(), configuration)?;
        self.snapshot_for_path(&workspace, &document)
    }

    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.shutdown = true;
            for workspace in inner.workspaces.values_mut() {
                for cancellation in workspace.composite_cancellations.values() {
                    cancellation.store(true, Ordering::SeqCst);
                }
                for task in workspace.tasks.values_mut() {
                    if let Some(cancel) = &task.cancel {
                        cancel.store(true, Ordering::SeqCst);
                        task.state = RunLifecycleState::Stopping;
                    }
                }
            }
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let active =
                self.inner
                    .lock()
                    .map(|inner| {
                        inner.workspaces.values().any(|workspace| {
                            workspace.tasks.values().any(|task| task.cancel.is_some())
                        })
                    })
                    .unwrap_or(false);
            if !active {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn operation_lock(&self, workspace: &Path) -> Result<Arc<Mutex<()>>, String> {
        let mut locks = self
            .operation_locks
            .lock()
            .map_err(|_| "Run manager operations are unavailable.".to_string())?;
        Ok(locks
            .entry(workspace.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    fn configuration_document_for_operation(
        &self,
        workspace: &Path,
    ) -> Result<RunConfigurationDocument, String> {
        if let Some(document) = self.inner.lock().ok().and_then(|inner| {
            let runtime = inner.workspaces.get(workspace)?;
            workspace_runtime_is_active(runtime)
                .then(|| runtime.document.clone())
                .flatten()
        }) {
            return Ok(document);
        }
        let document = load_document(workspace)?;
        self.remember_document(workspace, &document);
        Ok(document)
    }

    fn active_configuration_document(
        &self,
        workspace: &Path,
        configuration_id: Option<&str>,
    ) -> Option<RunConfigurationDocument> {
        self.inner.lock().ok().and_then(|inner| {
            let runtime = inner.workspaces.get(workspace)?;
            let document = runtime.document.as_ref()?;
            let configuration = resolve_configuration(document, configuration_id).ok()?;
            configuration_is_reusable(configuration, runtime).then(|| document.clone())
        })
    }

    fn configuration_document_for_start(
        &self,
        workspace: &Path,
    ) -> Result<RunConfigurationDocument, String> {
        let document = load_document(workspace)?;
        let cached_active_document = self.inner.lock().ok().and_then(|inner| {
            let runtime = inner.workspaces.get(workspace)?;
            workspace_runtime_is_active(runtime)
                .then(|| runtime.document.clone())
                .flatten()
        });
        if cached_active_document
            .as_ref()
            .is_some_and(|cached| cached != &document)
        {
            return Err(
                "Stop active workspace runs before using the changed configuration.".to_string(),
            );
        }
        self.remember_document(workspace, &document);
        Ok(document)
    }

    fn snapshot_document(&self, workspace: &Path) -> Result<RunConfigurationDocument, String> {
        let (cached, active) = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| {
                let runtime = inner.workspaces.get(workspace)?;
                Some((
                    runtime.document.clone(),
                    workspace_runtime_is_active(runtime),
                ))
            })
            .unwrap_or((None, false));
        if active {
            if let Some(document) = cached.clone() {
                return Ok(document);
            }
        }
        match load_document(workspace) {
            Ok(document) => {
                self.remember_document(workspace, &document);
                Ok(document)
            }
            Err(error) => cached.ok_or(error),
        }
    }

    fn remember_document(&self, workspace: &Path, document: &RunConfigurationDocument) {
        if let Ok(mut inner) = self.inner.lock() {
            let runtime = inner.workspaces.entry(workspace.to_path_buf()).or_default();
            if !workspace_runtime_is_active(runtime) || runtime.document.is_none() {
                runtime.document = Some(document.clone());
            }
        }
    }

    fn start_resolved_configuration(
        self: &Arc<Self>,
        workspace: PathBuf,
        document: RunConfigurationDocument,
        configuration: RunConfiguration,
    ) -> Result<(), String> {
        match configuration {
            task @ RunConfiguration::Task { .. } => self.start_task(workspace, task).map(|_| ()),
            RunConfiguration::Composite {
                id,
                children,
                start_order,
                ..
            } => {
                let by_id = document
                    .configurations
                    .iter()
                    .map(|candidate| (candidate.id(), candidate.clone()))
                    .collect::<HashMap<_, _>>();
                let child_tasks = children
                    .iter()
                    .map(|child_id| {
                        by_id
                            .get(child_id.as_str())
                            .cloned()
                            .ok_or_else(|| format!("Run child `{child_id}` does not exist."))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                for task in &child_tasks {
                    let RunConfiguration::Task {
                        working_directory, ..
                    } = task
                    else {
                        return Err("Composite runs can only contain tasks.".to_string());
                    };
                    resolve_working_directory(&workspace, working_directory)?;
                }
                self.ensure_tasks_are_not_stopping(&workspace, &children)?;

                if start_order == CompositeStartOrder::Parallel {
                    let mut started_tasks = Vec::new();
                    for task in child_tasks {
                        let task_id = task.id().to_string();
                        match self.start_task(workspace.clone(), task) {
                            Ok(true) => started_tasks.push(task_id),
                            Ok(false) => {}
                            Err(error) => {
                                self.cancel_tasks(&workspace, &started_tasks);
                                return Err(error);
                            }
                        }
                    }
                    return Ok(());
                }

                let cancel = Arc::new(AtomicBool::new(false));
                {
                    let mut inner = self
                        .inner
                        .lock()
                        .map_err(|_| "Run manager state is unavailable.".to_string())?;
                    let workspace_runtime = inner.workspaces.entry(workspace.clone()).or_default();
                    if workspace_runtime
                        .composite_cancellations
                        .get(&id)
                        .is_some_and(|existing| !existing.load(Ordering::SeqCst))
                    {
                        return Ok(());
                    }
                    workspace_runtime
                        .composite_cancellations
                        .insert(id.clone(), cancel.clone());
                }
                let manager = Arc::clone(self);
                thread::spawn(move || {
                    let mut started_tasks = Vec::new();
                    for task in child_tasks {
                        if cancel.load(Ordering::SeqCst) {
                            break;
                        }
                        let task_id = task.id().to_string();
                        match manager.start_task(workspace.clone(), task) {
                            Ok(true) => started_tasks.push(task_id.clone()),
                            Ok(false) => {}
                            Err(_) => {
                                manager.cancel_tasks(&workspace, &started_tasks);
                                break;
                            }
                        }
                        if !manager.wait_for_task_ready(
                            &workspace,
                            &task_id,
                            &cancel,
                            Duration::from_secs(120),
                        ) {
                            if !cancel.load(Ordering::SeqCst) {
                                manager.cancel_tasks(&workspace, &started_tasks);
                            }
                            break;
                        }
                    }
                    if let Ok(mut inner) = manager.inner.lock() {
                        if let Some(runtime) = inner.workspaces.get_mut(&workspace) {
                            if runtime
                                .composite_cancellations
                                .get(&id)
                                .is_some_and(|current| Arc::ptr_eq(current, &cancel))
                            {
                                runtime.composite_cancellations.remove(&id);
                            }
                        }
                    }
                    manager.publish_workspace(&workspace);
                });
                Ok(())
            }
        }
    }

    fn start_task(
        self: &Arc<Self>,
        workspace: PathBuf,
        configuration: RunConfiguration,
    ) -> Result<bool, String> {
        let RunConfiguration::Task {
            id,
            working_directory,
            health_check,
            ..
        } = &configuration
        else {
            return Err("Only task configurations can launch a process.".to_string());
        };
        let resolved_working_directory = resolve_working_directory(&workspace, working_directory)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let generation = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Run manager state is unavailable.".to_string())?;
            if inner.shutdown {
                return Err("Machdoch is shutting down.".to_string());
            }
            let existing = inner
                .workspaces
                .get(&workspace)
                .and_then(|runtime| runtime.tasks.get(id));
            if existing.is_some_and(|runtime| runtime.cancel.is_some()) {
                if existing.is_some_and(|runtime| runtime.state == RunLifecycleState::Stopping) {
                    return Err(format!("`{id}` is still stopping."));
                }
                return Ok(false);
            }
            inner.next_generation = inner.next_generation.wrapping_add(1).max(1);
            let generation = inner.next_generation;
            let workspace_runtime = inner.workspaces.entry(workspace.clone()).or_default();
            let runtime = workspace_runtime.tasks.entry(id.clone()).or_default();
            runtime.state = RunLifecycleState::Starting;
            runtime.pid = None;
            runtime.started_at = Some(now_millis());
            runtime.stopped_at = None;
            runtime.exit_code = None;
            runtime.restart_count = 0;
            runtime.health = health_check.as_ref().map(|_| RunHealthStatus {
                state: RunHealthState::Pending,
                checked_at: None,
                consecutive_failures: 0,
                message: None,
            });
            runtime.recent_failures.clear();
            runtime.logs.clear();
            runtime.cancel = Some(cancel.clone());
            runtime.generation = generation;
            generation
        };

        self.publish_workspace(&workspace);
        let manager = Arc::clone(self);
        thread::spawn(move || {
            manager.supervise_task(
                workspace,
                configuration,
                resolved_working_directory,
                cancel,
                generation,
            );
        });
        Ok(true)
    }

    fn supervise_task(
        self: Arc<Self>,
        workspace: PathBuf,
        configuration: RunConfiguration,
        working_directory: PathBuf,
        cancel: Arc<AtomicBool>,
        generation: u64,
    ) {
        let RunConfiguration::Task {
            id,
            name,
            command,
            environment,
            health_check,
            restart_policy,
            ..
        } = configuration
        else {
            return;
        };
        let mut restart_times = VecDeque::new();
        self.append_log(
            &workspace,
            &id,
            generation,
            RunLogStream::System,
            format!("Starting {name} in {}", working_directory.display()),
        );

        loop {
            if cancel.load(Ordering::SeqCst) {
                self.finish_stopped(&workspace, &id, generation, None);
                break;
            }

            let mut child = match spawn_task_process(&command, &working_directory, &environment) {
                Ok(child) => child,
                Err(error) => {
                    self.record_failure(
                        &workspace,
                        &id,
                        generation,
                        RunFailureKind::Launch,
                        error.clone(),
                    );
                    self.append_log(&workspace, &id, generation, RunLogStream::System, error);
                    if !restart_policy.on_crash
                        || !self.prepare_restart(
                            &workspace,
                            &id,
                            generation,
                            &restart_policy,
                            &mut restart_times,
                            &cancel,
                        )
                    {
                        if cancel.load(Ordering::SeqCst) {
                            self.finish_stopped(&workspace, &id, generation, None);
                        } else {
                            self.finish_crashed(&workspace, &id, generation, None);
                        }
                        break;
                    }
                    continue;
                }
            };
            let child_job = match assign_child_process_to_kill_on_close_job(&child) {
                Ok(job) => job,
                Err(error) => {
                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();
                    self.record_failure(&workspace, &id, generation, RunFailureKind::Launch, error);
                    self.finish_crashed(&workspace, &id, generation, None);
                    break;
                }
            };

            let stdout_worker = self.attach_log_reader(
                &workspace,
                &id,
                generation,
                RunLogStream::Stdout,
                child.stdout.take(),
            );
            let stderr_worker = self.attach_log_reader(
                &workspace,
                &id,
                generation,
                RunLogStream::Stderr,
                child.stderr.take(),
            );
            self.mark_spawned(
                &workspace,
                &id,
                generation,
                child.id(),
                health_check.is_some(),
            );

            let outcome = self.monitor_attempt(
                AttemptMonitorContext {
                    workspace: &workspace,
                    configuration_id: &id,
                    generation,
                    cancel: &cancel,
                    health_check: health_check.as_deref(),
                },
                &mut child,
                &child_job,
            );
            drop(child_job);
            if let Some(worker) = stdout_worker {
                worker.join();
            }
            if let Some(worker) = stderr_worker {
                worker.join();
            }

            match outcome {
                AttemptOutcome::Stopped => {
                    self.finish_stopped(&workspace, &id, generation, None);
                    break;
                }
                AttemptOutcome::Exited(status) => {
                    let exit_code = status.code();
                    if status.success() {
                        self.finish_stopped(&workspace, &id, generation, exit_code);
                        break;
                    }
                    let message = format_exit_failure(&name, &status);
                    self.record_failure(
                        &workspace,
                        &id,
                        generation,
                        RunFailureKind::Crash,
                        message.clone(),
                    );
                    self.append_log(&workspace, &id, generation, RunLogStream::System, message);
                    if !restart_policy.on_crash
                        || !self.prepare_restart(
                            &workspace,
                            &id,
                            generation,
                            &restart_policy,
                            &mut restart_times,
                            &cancel,
                        )
                    {
                        if cancel.load(Ordering::SeqCst) {
                            self.finish_stopped(&workspace, &id, generation, exit_code);
                        } else {
                            self.finish_crashed(&workspace, &id, generation, exit_code);
                        }
                        break;
                    }
                }
                AttemptOutcome::Unhealthy(message) => {
                    self.record_failure(
                        &workspace,
                        &id,
                        generation,
                        RunFailureKind::Health,
                        message.clone(),
                    );
                    self.append_log(&workspace, &id, generation, RunLogStream::System, message);
                    if !self.prepare_restart(
                        &workspace,
                        &id,
                        generation,
                        &restart_policy,
                        &mut restart_times,
                        &cancel,
                    ) {
                        if cancel.load(Ordering::SeqCst) {
                            self.finish_stopped(&workspace, &id, generation, None);
                        } else {
                            self.finish_unhealthy(&workspace, &id, generation);
                        }
                        break;
                    }
                }
            }
        }
    }

    fn monitor_attempt(
        &self,
        context: AttemptMonitorContext<'_>,
        child: &mut Child,
        child_job: &ChildProcessJob,
    ) -> AttemptOutcome {
        let AttemptMonitorContext {
            workspace,
            configuration_id,
            generation,
            cancel,
            health_check,
        } = context;
        let mut next_health_check = health_check
            .map(|check| Instant::now() + Duration::from_millis(check.startup_delay_ms));
        let mut pending_health_check: Option<mpsc::Receiver<Result<(), String>>> = None;
        let mut consecutive_failures = 0_u32;

        loop {
            if cancel.load(Ordering::SeqCst) {
                self.set_state(
                    workspace,
                    configuration_id,
                    generation,
                    RunLifecycleState::Stopping,
                );
                terminate_managed_process(child, child_job);
                let _ = child.wait();
                return AttemptOutcome::Stopped;
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    terminate_managed_process(child, child_job);
                    return AttemptOutcome::Exited(status);
                }
                Err(error) => {
                    terminate_managed_process(child, child_job);
                    let _ = child.wait();
                    return AttemptOutcome::Unhealthy(format!(
                        "Failed to monitor the process: {error}"
                    ));
                }
                Ok(None) => {}
            }

            let completed_health_check =
                pending_health_check
                    .as_ref()
                    .and_then(|receiver| match receiver.try_recv() {
                        Ok(result) => Some(result),
                        Err(TryRecvError::Empty) => None,
                        Err(TryRecvError::Disconnected) => {
                            Some(Err("Health check worker stopped unexpectedly.".to_string()))
                        }
                    });
            if let Some(result) = completed_health_check {
                pending_health_check = None;
                let Some(check) = health_check else {
                    terminate_managed_process(child, child_job);
                    let _ = child.wait();
                    return AttemptOutcome::Unhealthy(
                        "Health check configuration became unavailable.".to_string(),
                    );
                };
                match result {
                    Ok(()) => {
                        consecutive_failures = 0;
                        self.update_health(
                            workspace,
                            configuration_id,
                            generation,
                            RunHealthState::Healthy,
                            0,
                            None,
                        );
                        self.set_state(
                            workspace,
                            configuration_id,
                            generation,
                            RunLifecycleState::Running,
                        );
                    }
                    Err(error) => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        self.update_health(
                            workspace,
                            configuration_id,
                            generation,
                            RunHealthState::Failed,
                            consecutive_failures,
                            Some(error.clone()),
                        );
                        if consecutive_failures >= check.failure_threshold {
                            self.set_state(
                                workspace,
                                configuration_id,
                                generation,
                                RunLifecycleState::Unhealthy,
                            );
                            if check.restart_on_failure {
                                terminate_managed_process(child, child_job);
                                let _ = child.wait();
                                return AttemptOutcome::Unhealthy(format!(
                                    "Health check failed {consecutive_failures} consecutive times: {error}"
                                ));
                            }
                        }
                    }
                }
                next_health_check = Some(Instant::now() + Duration::from_millis(check.interval_ms));
            }

            if pending_health_check.is_none() {
                if let (Some(check), Some(next_check)) = (health_check, next_health_check) {
                    if Instant::now() >= next_check {
                        let check = check.clone();
                        let (sender, receiver) = mpsc::channel();
                        thread::spawn(move || {
                            let _ = sender.send(check_health(&check));
                        });
                        pending_health_check = Some(receiver);
                        next_health_check = None;
                    }
                }
            }

            thread::sleep(Duration::from_millis(100));
        }
    }

    fn prepare_restart(
        self: &Arc<Self>,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        policy: &RunRestartPolicy,
        restart_times: &mut VecDeque<Instant>,
        cancel: &AtomicBool,
    ) -> bool {
        let now = Instant::now();
        let window = Duration::from_millis(policy.window_ms);
        while restart_times
            .front()
            .is_some_and(|started| now.duration_since(*started) > window)
        {
            restart_times.pop_front();
        }
        if policy.max_restarts == 0 || restart_times.len() >= policy.max_restarts as usize {
            let message = format!(
                "Restart limit reached: {} restart(s) within {} ms.",
                policy.max_restarts, policy.window_ms
            );
            self.record_failure(
                workspace,
                configuration_id,
                generation,
                RunFailureKind::RestartLimit,
                message.clone(),
            );
            self.append_log(
                workspace,
                configuration_id,
                generation,
                RunLogStream::System,
                message,
            );
            return false;
        }

        restart_times.push_back(now);
        let restart_index = restart_times.len().saturating_sub(1).min(20) as u32;
        let multiplier = 1_u64.checked_shl(restart_index).unwrap_or(u64::MAX);
        let delay_ms = policy
            .backoff_ms
            .saturating_mul(multiplier)
            .min(policy.max_backoff_ms);
        self.increment_restart(workspace, configuration_id, generation);
        self.set_state(
            workspace,
            configuration_id,
            generation,
            RunLifecycleState::Restarting,
        );
        self.append_log(
            workspace,
            configuration_id,
            generation,
            RunLogStream::System,
            format!("Restarting in {delay_ms} ms"),
        );

        let deadline = Instant::now() + Duration::from_millis(delay_ms);
        while Instant::now() < deadline {
            if cancel.load(Ordering::SeqCst) {
                self.finish_stopped(workspace, configuration_id, generation, None);
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
        true
    }

    fn stop_resolved_configuration(&self, workspace: &Path, configuration: &RunConfiguration) {
        if let Ok(mut inner) = self.inner.lock() {
            let runtime = inner.workspaces.entry(workspace.to_path_buf()).or_default();
            if let Some(composite_cancel) = runtime.composite_cancellations.get(configuration.id())
            {
                composite_cancel.store(true, Ordering::SeqCst);
            }
            for id in task_ids(configuration) {
                let task = runtime.tasks.entry(id.to_string()).or_default();
                let supervisor_active = task.cancel.is_some();
                if let Some(cancel) = &task.cancel {
                    cancel.store(true, Ordering::SeqCst);
                }
                if supervisor_active {
                    task.state = RunLifecycleState::Stopping;
                } else {
                    task.state = RunLifecycleState::Stopped;
                    task.stopped_at = Some(now_millis());
                    task.pid = None;
                }
            }
        }
    }

    fn ensure_tasks_are_not_stopping(
        &self,
        workspace: &Path,
        configuration_ids: &[String],
    ) -> Result<(), String> {
        let stopping = self.inner.lock().ok().and_then(|inner| {
            let runtime = inner.workspaces.get(workspace)?;
            configuration_ids.iter().find_map(|configuration_id| {
                runtime
                    .tasks
                    .get(configuration_id)
                    .is_some_and(|task| {
                        task.cancel.is_some() && task.state == RunLifecycleState::Stopping
                    })
                    .then(|| configuration_id.clone())
            })
        });
        if let Some(configuration_id) = stopping {
            return Err(format!("`{configuration_id}` is still stopping."));
        }
        Ok(())
    }

    fn cancel_tasks(&self, workspace: &Path, configuration_ids: &[String]) {
        let mut changed = false;
        if let Ok(mut inner) = self.inner.lock() {
            let Some(runtime) = inner.workspaces.get_mut(workspace) else {
                return;
            };
            for configuration_id in configuration_ids {
                let Some(task) = runtime.tasks.get_mut(configuration_id) else {
                    continue;
                };
                if let Some(cancel) = &task.cancel {
                    cancel.store(true, Ordering::SeqCst);
                    task.state = RunLifecycleState::Stopping;
                    changed = true;
                }
            }
        }
        if changed {
            self.publish_workspace(workspace);
        }
    }

    fn wait_for_configuration_stop(
        &self,
        workspace: &Path,
        configuration: &RunConfiguration,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let all_stopped = self
                .inner
                .lock()
                .map(|inner| {
                    let Some(runtime) = inner.workspaces.get(workspace) else {
                        return true;
                    };
                    task_ids(configuration).iter().all(|id| {
                        runtime
                            .tasks
                            .get(*id)
                            .is_none_or(|task| task.cancel.is_none())
                    })
                })
                .unwrap_or(false);
            if all_stopped {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err(format!(
            "Timed out while stopping `{}`.",
            configuration.name()
        ))
    }

    fn wait_for_task_ready(
        &self,
        workspace: &Path,
        configuration_id: &str,
        cancel: &AtomicBool,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline && !cancel.load(Ordering::SeqCst) {
            let task_status = self.inner.lock().ok().and_then(|inner| {
                inner
                    .workspaces
                    .get(workspace)
                    .and_then(|runtime| runtime.tasks.get(configuration_id))
                    .map(|runtime| (runtime.state, runtime.exit_code))
            });
            match task_status {
                Some((RunLifecycleState::Running, _))
                | Some((RunLifecycleState::Stopped, Some(0))) => return true,
                Some((
                    RunLifecycleState::Stopped
                    | RunLifecycleState::Crashed
                    | RunLifecycleState::Unhealthy,
                    _,
                ))
                | None => return false,
                _ => thread::sleep(Duration::from_millis(100)),
            }
        }
        false
    }

    fn workspace_has_active_tasks(&self, workspace: &Path) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| {
                inner
                    .workspaces
                    .get(workspace)
                    .map(workspace_runtime_is_active)
            })
            .unwrap_or(false)
    }

    fn mark_spawned(
        &self,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        pid: u32,
        waits_for_health: bool,
    ) {
        self.update_task(workspace, configuration_id, generation, |runtime| {
            runtime.pid = Some(pid);
            runtime.exit_code = None;
            runtime.state = if waits_for_health {
                RunLifecycleState::Starting
            } else {
                RunLifecycleState::Running
            };
            if waits_for_health {
                runtime.health = Some(RunHealthStatus {
                    state: RunHealthState::Pending,
                    checked_at: None,
                    consecutive_failures: 0,
                    message: None,
                });
            }
        });
    }

    fn finish_stopped(
        &self,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        exit_code: Option<i32>,
    ) {
        self.update_task(workspace, configuration_id, generation, |runtime| {
            runtime.state = RunLifecycleState::Stopped;
            runtime.pid = None;
            runtime.stopped_at = Some(now_millis());
            runtime.exit_code = exit_code;
            runtime.cancel = None;
        });
    }

    fn finish_crashed(
        &self,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        exit_code: Option<i32>,
    ) {
        self.update_task(workspace, configuration_id, generation, |runtime| {
            runtime.state = RunLifecycleState::Crashed;
            runtime.pid = None;
            runtime.stopped_at = Some(now_millis());
            runtime.exit_code = exit_code;
            runtime.cancel = None;
        });
    }

    fn finish_unhealthy(&self, workspace: &Path, configuration_id: &str, generation: u64) {
        self.update_task(workspace, configuration_id, generation, |runtime| {
            runtime.state = RunLifecycleState::Unhealthy;
            runtime.pid = None;
            runtime.stopped_at = Some(now_millis());
            runtime.cancel = None;
        });
    }

    fn set_state(
        &self,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        state: RunLifecycleState,
    ) {
        self.update_task(workspace, configuration_id, generation, |runtime| {
            runtime.state = state;
        });
    }

    fn increment_restart(&self, workspace: &Path, configuration_id: &str, generation: u64) {
        self.update_task(workspace, configuration_id, generation, |runtime| {
            runtime.restart_count = runtime.restart_count.saturating_add(1);
            runtime.pid = None;
        });
    }

    fn update_health(
        &self,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        state: RunHealthState,
        consecutive_failures: u32,
        message: Option<String>,
    ) {
        self.update_task(workspace, configuration_id, generation, |runtime| {
            runtime.health = Some(RunHealthStatus {
                state,
                checked_at: Some(now_millis()),
                consecutive_failures,
                message,
            });
        });
    }

    fn update_task(
        &self,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        update: impl FnOnce(&mut TaskRuntime),
    ) {
        let changed = self
            .inner
            .lock()
            .ok()
            .and_then(|mut inner| {
                let task = inner
                    .workspaces
                    .get_mut(workspace)?
                    .tasks
                    .get_mut(configuration_id)?;
                if task.generation != generation {
                    return Some(false);
                }
                update(task);
                Some(true)
            })
            .unwrap_or(false);
        if changed {
            self.publish_workspace(workspace);
        }
    }

    fn record_failure(
        &self,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        kind: RunFailureKind,
        message: String,
    ) {
        if let Ok(mut inner) = self.inner.lock() {
            let Some(task) = inner
                .workspaces
                .get_mut(workspace)
                .and_then(|runtime| runtime.tasks.get_mut(configuration_id))
            else {
                return;
            };
            if task.generation != generation {
                return;
            }
            task.recent_failures.push_back(RunFailure {
                at: now_millis(),
                kind,
                message: limit_line(message),
            });
            while task.recent_failures.len() > MAX_FAILURE_ENTRIES {
                task.recent_failures.pop_front();
            }
        }
        self.publish_workspace(workspace);
    }

    fn append_log(
        self: &Arc<Self>,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        stream: RunLogStream,
        line: String,
    ) {
        let should_schedule = if let Ok(mut inner) = self.inner.lock() {
            let is_current_generation = inner
                .workspaces
                .get(workspace)
                .and_then(|runtime| runtime.tasks.get(configuration_id))
                .is_some_and(|task| task.generation == generation);
            if !is_current_generation {
                return;
            }
            inner.next_log_sequence = inner.next_log_sequence.wrapping_add(1).max(1);
            let sequence = inner.next_log_sequence;
            let entry = RunLogEntry {
                sequence,
                at: now_millis(),
                stream,
                line: limit_line(line),
            };
            let Some(task) = inner
                .workspaces
                .get_mut(workspace)
                .and_then(|runtime| runtime.tasks.get_mut(configuration_id))
            else {
                return;
            };
            let Some(started_at) = task.started_at else {
                return;
            };
            task.logs.push_back(entry.clone());
            while task.logs.len() > MAX_LOG_ENTRIES {
                task.logs.pop_front();
            }
            let batch = inner
                .pending_log_batches
                .entry(workspace.to_path_buf())
                .or_default();
            let should_schedule = batch.is_empty();
            batch.push_back(RunLogUpdate {
                configuration_id: configuration_id.to_string(),
                started_at,
                entry,
            });
            while batch.len() > MAX_LOG_EVENT_ENTRIES {
                batch.pop_front();
            }
            should_schedule
        } else {
            false
        };
        if should_schedule {
            let manager = Arc::clone(self);
            let workspace = workspace.to_path_buf();
            thread::spawn(move || {
                thread::sleep(LOG_EVENT_DELAY);
                let entries = manager
                    .inner
                    .lock()
                    .ok()
                    .and_then(|mut inner| inner.pending_log_batches.remove(&workspace));
                if let Some(entries) = entries {
                    manager.emit_logs(RunLogBatch {
                        workspace_root: workspace.display().to_string(),
                        entries: entries.into_iter().collect(),
                    });
                }
            });
        }
    }

    fn attach_log_reader<R: std::io::Read + Send + 'static>(
        self: &Arc<Self>,
        workspace: &Path,
        configuration_id: &str,
        generation: u64,
        stream: RunLogStream,
        reader: Option<R>,
    ) -> Option<LogReaderWorker> {
        let reader = reader?;
        let manager = Arc::clone(self);
        let workspace = workspace.to_path_buf();
        let configuration_id = configuration_id.to_string();
        let (done_sender, done) = mpsc::channel();
        let worker = thread::spawn(move || {
            let result = read_bounded_log_lines(reader, |line| {
                manager.append_log(&workspace, &configuration_id, generation, stream, line);
            });
            if let Err(error) = result {
                manager.append_log(
                    &workspace,
                    &configuration_id,
                    generation,
                    RunLogStream::System,
                    format!("Failed to read process output: {error}"),
                );
            }
            let _ = done_sender.send(());
        });
        Some(LogReaderWorker { done, worker })
    }

    fn snapshot_for_path(
        &self,
        workspace: &Path,
        document: &RunConfigurationDocument,
    ) -> Result<RunWorkspaceSnapshot, String> {
        let statuses = self
            .inner
            .lock()
            .map_err(|_| "Run manager state is unavailable.".to_string())?
            .workspaces
            .get(workspace)
            .map(|runtime| {
                let by_id = document
                    .configurations
                    .iter()
                    .map(|configuration| (configuration.id(), configuration))
                    .collect::<HashMap<_, _>>();
                document
                    .configurations
                    .iter()
                    .map(|configuration| status_for(configuration, runtime, &by_id))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                let runtime = WorkspaceRuntime::default();
                let by_id = document
                    .configurations
                    .iter()
                    .map(|configuration| (configuration.id(), configuration))
                    .collect::<HashMap<_, _>>();
                document
                    .configurations
                    .iter()
                    .map(|configuration| status_for(configuration, &runtime, &by_id))
                    .collect()
            });
        Ok(RunWorkspaceSnapshot {
            workspace_root: workspace.display().to_string(),
            primary_configuration_id: document.primary_configuration_id.clone(),
            configurations: statuses,
        })
    }

    fn publish_workspace(&self, workspace: &Path) {
        let Ok(document) = self.snapshot_document(workspace) else {
            return;
        };
        let Ok(snapshot) = self.snapshot_for_path(workspace, &document) else {
            return;
        };
        self.emit(snapshot);
    }

    fn emit(&self, snapshot: RunWorkspaceSnapshot) {
        let sink = self
            .event_sink
            .lock()
            .ok()
            .and_then(|sink| sink.as_ref().map(Arc::clone));
        if let Some(sink) = sink {
            sink(snapshot);
        }
    }

    fn emit_logs(&self, batch: RunLogBatch) {
        let sink = self
            .log_event_sink
            .lock()
            .ok()
            .and_then(|sink| sink.as_ref().map(Arc::clone));
        if let Some(sink) = sink {
            sink(batch);
        }
    }
}

fn workspace_runtime_is_active(runtime: &WorkspaceRuntime) -> bool {
    runtime
        .composite_cancellations
        .values()
        .any(|cancel| !cancel.load(Ordering::SeqCst))
        || runtime.tasks.values().any(|task| task.cancel.is_some())
}

fn configuration_is_reusable(configuration: &RunConfiguration, runtime: &WorkspaceRuntime) -> bool {
    match configuration {
        RunConfiguration::Task { id, .. } => runtime
            .tasks
            .get(id)
            .is_some_and(|task| task.cancel.is_some() && task.state != RunLifecycleState::Stopping),
        RunConfiguration::Composite { id, children, .. } => {
            runtime
                .composite_cancellations
                .get(id)
                .is_some_and(|cancel| !cancel.load(Ordering::SeqCst))
                || children.iter().all(|child_id| {
                    runtime.tasks.get(child_id).is_some_and(|task| {
                        task.cancel.is_some() && task.state != RunLifecycleState::Stopping
                    })
                })
        }
    }
}

enum AttemptOutcome {
    Stopped,
    Exited(ExitStatus),
    Unhealthy(String),
}

fn spawn_task_process(
    command: &str,
    working_directory: &Path,
    environment: &std::collections::BTreeMap<String, String>,
) -> Result<Child, String> {
    let mut process = create_run_command(command);
    process
        .current_dir(working_directory)
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_process_group(&mut process);
    process.spawn().map_err(|error| {
        format!(
            "Failed to launch `{command}` in {}: {error}",
            working_directory.display()
        )
    })
}

fn terminate_managed_process(child: &mut Child, child_job: &ChildProcessJob) {
    if !child_job.terminate() {
        terminate_child_process_tree(child);
    }
}

fn resolve_configuration<'a>(
    document: &'a RunConfigurationDocument,
    requested_id: Option<&str>,
) -> Result<&'a RunConfiguration, String> {
    let id = requested_id
        .filter(|value| !value.trim().is_empty())
        .or(document.primary_configuration_id.as_deref())
        .ok_or_else(|| "No primary run configuration is configured.".to_string())?;
    document
        .configurations
        .iter()
        .find(|configuration| configuration.id() == id)
        .ok_or_else(|| format!("Run configuration `{id}` does not exist."))
}

fn task_ids(configuration: &RunConfiguration) -> Vec<&str> {
    match configuration {
        RunConfiguration::Task { id, .. } => vec![id],
        RunConfiguration::Composite { children, .. } => {
            children.iter().map(String::as_str).collect()
        }
    }
}

fn status_for(
    configuration: &RunConfiguration,
    runtime: &WorkspaceRuntime,
    by_id: &HashMap<&str, &RunConfiguration>,
) -> RunConfigurationStatus {
    match configuration {
        RunConfiguration::Task { id, .. } => {
            let task = runtime.tasks.get(id);
            RunConfigurationStatus {
                configuration: configuration.clone(),
                state: task
                    .map(|task| task.state)
                    .unwrap_or(RunLifecycleState::Stopped),
                pid: task.and_then(|task| task.pid),
                started_at: task.and_then(|task| task.started_at),
                stopped_at: task.and_then(|task| task.stopped_at),
                exit_code: task.and_then(|task| task.exit_code),
                restart_count: task.map(|task| task.restart_count).unwrap_or(0),
                health: task.and_then(|task| task.health.clone()),
                recent_failures: task
                    .map(|task| task.recent_failures.iter().cloned().collect())
                    .unwrap_or_default(),
                logs: task
                    .map(|task| task.logs.iter().cloned().collect())
                    .unwrap_or_default(),
                children: Vec::new(),
            }
        }
        RunConfiguration::Composite { id, children, .. } => {
            let child_statuses = children
                .iter()
                .filter_map(|child_id| by_id.get(child_id.as_str()))
                .map(|child| status_for(child, runtime, by_id))
                .collect::<Vec<_>>();
            let derived_state = composite_state(&child_statuses);
            let state = if derived_state == RunLifecycleState::Stopped
                && runtime
                    .composite_cancellations
                    .get(id)
                    .is_some_and(|cancel| !cancel.load(Ordering::SeqCst))
            {
                RunLifecycleState::Starting
            } else {
                derived_state
            };
            RunConfigurationStatus {
                configuration: configuration.clone(),
                state,
                pid: None,
                started_at: child_statuses
                    .iter()
                    .filter_map(|child| child.started_at)
                    .min(),
                stopped_at: child_statuses
                    .iter()
                    .filter_map(|child| child.stopped_at)
                    .max(),
                exit_code: None,
                restart_count: child_statuses.iter().map(|child| child.restart_count).sum(),
                health: None,
                recent_failures: Vec::new(),
                logs: Vec::new(),
                children: child_statuses,
            }
        }
    }
}

fn composite_state(children: &[RunConfigurationStatus]) -> RunLifecycleState {
    if children.is_empty()
        || children
            .iter()
            .all(|child| child.state == RunLifecycleState::Stopped)
    {
        return RunLifecycleState::Stopped;
    }
    for state in [
        RunLifecycleState::Stopping,
        RunLifecycleState::Restarting,
        RunLifecycleState::Unhealthy,
        RunLifecycleState::Crashed,
        RunLifecycleState::Starting,
    ] {
        if children.iter().any(|child| child.state == state) {
            return state;
        }
    }
    if children
        .iter()
        .any(|child| child.state == RunLifecycleState::Running)
    {
        RunLifecycleState::Running
    } else {
        RunLifecycleState::Starting
    }
}

fn format_exit_failure(name: &str, status: &ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("{name} exited with code {code}."),
        None => format!("{name} terminated without an exit code."),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn read_bounded_log_lines(
    mut reader: impl Read,
    mut on_line: impl FnMut(String),
) -> Result<(), std::io::Error> {
    let mut input = [0_u8; 4_096];
    let mut line = Vec::with_capacity(MAX_LOG_LINE_BYTES);
    let mut truncated = false;
    let mut previous_was_carriage_return = false;

    loop {
        let count = reader.read(&mut input)?;
        if count == 0 {
            if !line.is_empty() || truncated {
                on_line(format_bounded_log_line(&line, truncated));
            }
            return Ok(());
        }

        for byte in &input[..count] {
            if previous_was_carriage_return {
                previous_was_carriage_return = false;
                if *byte == b'\n' {
                    continue;
                }
            }
            if *byte == b'\r' {
                on_line(format_bounded_log_line(&line, truncated));
                line.clear();
                truncated = false;
                previous_was_carriage_return = true;
            } else if *byte == b'\n' {
                on_line(format_bounded_log_line(&line, truncated));
                line.clear();
                truncated = false;
            } else if line.len() < MAX_LOG_LINE_BYTES {
                line.push(*byte);
            } else {
                truncated = true;
            }
        }
    }
}

fn format_bounded_log_line(line: &[u8], truncated: bool) -> String {
    let decoded = String::from_utf8_lossy(line);
    let mut formatted = strip_terminal_control_sequences(&decoded);
    if truncated {
        formatted.push_str("...");
    }
    formatted
}

fn strip_terminal_control_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            match characters.next() {
                Some('[') => {
                    for next in characters.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    let mut escaped = false;
                    for next in characters.by_ref() {
                        if next == '\u{7}' || (escaped && next == '\\') {
                            break;
                        }
                        escaped = next == '\u{1b}';
                    }
                }
                Some(_) | None => {}
            }
        } else if character == '\t' || !character.is_control() {
            output.push(character);
        }
    }
    output
}

fn limit_line(mut line: String) -> String {
    if line.len() <= MAX_LOG_LINE_BYTES {
        return line;
    }
    let mut end = MAX_LOG_LINE_BYTES;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    line.truncate(end);
    line.push_str("...");
    line
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        env, fs,
        io::Cursor,
        net::TcpListener,
        path::PathBuf,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::workspace_run::{
        model::{RunHealthCheck, RunHealthCheckKind, RUN_SCHEMA_VERSION},
        persistence::configuration_path,
    };

    const CHILD_MODE_ENV: &str = "MACHDOCH_WORKSPACE_RUN_TEST_CHILD_MODE";
    const CHILD_MARKER_ENV: &str = "MACHDOCH_WORKSPACE_RUN_TEST_MARKER";
    static CHILD_PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serialize_child_process_test() -> std::sync::MutexGuard<'static, ()> {
        CHILD_PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn status(state: RunLifecycleState) -> RunConfigurationStatus {
        RunConfigurationStatus {
            configuration: RunConfiguration::Task {
                id: "task".to_string(),
                name: "Task".to_string(),
                command: "example".to_string(),
                working_directory: ".".to_string(),
                environment: Default::default(),
                hot_reload: false,
                ports: Vec::new(),
                urls: Vec::new(),
                health_check: None,
                restart_policy: RunRestartPolicy::default(),
            },
            state,
            pid: None,
            started_at: None,
            stopped_at: None,
            exit_code: None,
            restart_count: 0,
            health: None,
            recent_failures: Vec::new(),
            logs: Vec::new(),
            children: Vec::new(),
        }
    }

    fn temporary_workspace(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "machdoch-run-manager-{}-{unique}-{name}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temporary workspace should be created");
        path.canonicalize().expect("workspace should canonicalize")
    }

    fn child_command() -> String {
        let executable = env::current_exe().expect("test executable should resolve");
        let target = "workspace_run::manager::tests::run_test_child_entrypoint";
        #[cfg(target_os = "windows")]
        {
            format!("{} --exact {target} --nocapture", executable.display())
        }
        #[cfg(not(target_os = "windows"))]
        {
            format!("'{}' --exact {target} --nocapture", executable.display())
        }
    }

    fn task_configuration(
        id: &str,
        mode: &str,
        working_directory: &str,
        restart_policy: RunRestartPolicy,
        health_check: Option<RunHealthCheck>,
        marker: Option<&Path>,
    ) -> RunConfiguration {
        let mut environment = BTreeMap::from([(CHILD_MODE_ENV.to_string(), mode.to_string())]);
        if let Some(marker) = marker {
            environment.insert(CHILD_MARKER_ENV.to_string(), marker.display().to_string());
        }
        RunConfiguration::Task {
            id: id.to_string(),
            name: id.to_string(),
            command: child_command(),
            working_directory: working_directory.to_string(),
            environment,
            hot_reload: mode == "hold",
            ports: Vec::new(),
            urls: Vec::new(),
            health_check: health_check.map(Box::new),
            restart_policy,
        }
    }

    fn save_test_document(
        manager: &RunManager,
        workspace: &Path,
        primary: &str,
        configurations: Vec<RunConfiguration>,
    ) {
        manager
            .save_configuration_document(
                workspace.to_string_lossy().as_ref(),
                &RunConfigurationDocument {
                    schema_version: RUN_SCHEMA_VERSION,
                    primary_configuration_id: Some(primary.to_string()),
                    configurations,
                },
            )
            .expect("test run document should save");
    }

    fn wait_for_status(
        manager: &RunManager,
        workspace: &Path,
        configuration_id: &str,
        timeout: Duration,
        predicate: impl Fn(&RunConfigurationStatus) -> bool,
    ) -> RunConfigurationStatus {
        let deadline = Instant::now() + timeout;
        loop {
            let snapshot = manager
                .snapshot(workspace.to_string_lossy().as_ref())
                .expect("snapshot should load");
            let status = snapshot
                .configurations
                .into_iter()
                .find(|status| status.configuration.id() == configuration_id)
                .expect("configuration status should exist");
            if predicate(&status) {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "timed out with state {:?}",
                status.state
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn process_is_running(process_id: u32) -> bool {
        #[cfg(target_os = "windows")]
        {
            let filter = format!("PID eq {process_id}");
            Command::new("tasklist")
                .args(["/FI", filter.as_str(), "/FO", "CSV", "/NH"])
                .output()
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout).contains(&format!(",\"{process_id}\","))
                })
                .unwrap_or(false)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let process_id = process_id.to_string();
            Command::new("kill")
                .args(["-0", process_id.as_str()])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
    }

    #[test]
    fn run_test_child_entrypoint() {
        let Ok(mode) = env::var(CHILD_MODE_ENV) else {
            return;
        };
        let marker = env::var(CHILD_MARKER_ENV).ok().map(PathBuf::from);
        if mode == "output-exit" {
            println!("stdout-ready");
            eprintln!("stderr-detail");
            return;
        }
        if mode == "crash" {
            eprintln!("crash-detail");
            std::process::exit(9);
        }
        if mode == "crash-once" {
            let marker = marker.as_ref().expect("crash-once mode needs a marker");
            if !marker.exists() {
                fs::write(marker, "crashed").expect("crash marker should be written");
                std::process::exit(7);
            }
        }
        if mode == "record-cwd" {
            let marker = marker.as_ref().expect("record-cwd mode needs a marker");
            fs::write(
                marker,
                env::current_dir()
                    .expect("child current directory should resolve")
                    .display()
                    .to_string(),
            )
            .expect("working directory marker should be written");
        }
        if mode == "count-hold" {
            let marker = marker.as_ref().expect("count-hold mode needs a marker");
            use std::io::Write as _;
            writeln!(
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(marker)
                    .expect("start marker should open"),
                "started"
            )
            .expect("start marker should be written");
        }
        if mode == "fast-output-hold" {
            for index in 0..600 {
                println!("line-{index}");
            }
            eprintln!("fast-stderr");
        }
        if mode == "descendant" {
            let marker = marker.as_ref().expect("descendant mode needs a marker");
            fs::write(marker, std::process::id().to_string())
                .expect("descendant pid should be written");
        }
        let mut descendant = if mode == "spawn-descendant" {
            let marker = marker
                .as_ref()
                .expect("spawn-descendant mode needs a marker");
            Some(
                Command::new(env::current_exe().expect("test executable should resolve"))
                    .args([
                        "--exact",
                        "workspace_run::manager::tests::run_test_child_entrypoint",
                        "--nocapture",
                    ])
                    .env(CHILD_MODE_ENV, "descendant")
                    .env(CHILD_MARKER_ENV, marker)
                    .spawn()
                    .expect("descendant should start"),
            )
        } else {
            None
        };
        println!("ready");
        if let Some(descendant) = descendant.as_mut() {
            let _ = descendant.wait();
            return;
        }
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn composite_state_surfaces_child_failures_and_progress() {
        assert_eq!(
            composite_state(&[
                status(RunLifecycleState::Running),
                status(RunLifecycleState::Unhealthy)
            ]),
            RunLifecycleState::Unhealthy
        );
        assert_eq!(
            composite_state(&[
                status(RunLifecycleState::Running),
                status(RunLifecycleState::Starting)
            ]),
            RunLifecycleState::Starting
        );
        assert_eq!(
            composite_state(&[
                status(RunLifecycleState::Running),
                status(RunLifecycleState::Running)
            ]),
            RunLifecycleState::Running
        );
    }

    #[test]
    fn process_log_lines_are_bounded_before_allocation_grows() {
        let input = format!("{}\nsecond\r\n", "x".repeat(MAX_LOG_LINE_BYTES * 64));
        let mut output = Vec::new();

        read_bounded_log_lines(Cursor::new(input), |line| output.push(line))
            .expect("log input should be read");

        assert_eq!(output.len(), 2);
        assert_eq!(output[0].len(), MAX_LOG_LINE_BYTES + 3);
        assert!(output[0].ends_with("..."));
        assert_eq!(output[1], "second");
    }

    #[test]
    fn process_log_lines_handle_terminal_controls_and_carriage_returns() {
        let input = b"\x1b[31mred\x1b[0m\rnext\r\nlast\n";
        let mut output = Vec::new();

        read_bounded_log_lines(Cursor::new(input), |line| output.push(line))
            .expect("log input should be read");

        assert_eq!(output, ["red", "next", "last"]);
    }

    #[test]
    fn retains_stdout_and_stderr_after_successful_exit() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("completed-output");
        let manager = Arc::new(RunManager::default());
        let events = Arc::new(Mutex::new(Vec::<RunWorkspaceSnapshot>::new()));
        let event_output = events.clone();
        manager.set_event_sink(Arc::new(move |snapshot| {
            event_output
                .lock()
                .expect("events should lock")
                .push(snapshot);
        }));
        let task = task_configuration(
            "command",
            "output-exit",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        save_test_document(&manager, &workspace, "command", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        let completed = wait_for_status(
            &manager,
            &workspace,
            "command",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Stopped && status.exit_code == Some(0),
        );

        assert!(completed.logs.iter().any(|entry| {
            matches!(entry.stream, RunLogStream::Stdout) && entry.line == "stdout-ready"
        }));
        assert!(completed.logs.iter().any(|entry| {
            matches!(entry.stream, RunLogStream::Stderr) && entry.line == "stderr-detail"
        }));
        assert!(events
            .lock()
            .expect("events should lock")
            .iter()
            .any(|snapshot| snapshot.configurations.iter().any(|status| {
                status
                    .logs
                    .iter()
                    .any(|entry| entry.line == "stderr-detail")
            })));
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn keeps_fast_output_bounded_and_publishes_it_while_running() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("fast-output");
        let manager = Arc::new(RunManager::default());
        let events = Arc::new(Mutex::new(Vec::<RunLogBatch>::new()));
        let event_output = events.clone();
        manager.set_log_event_sink(Arc::new(move |batch| {
            event_output.lock().expect("events should lock").push(batch);
        }));
        let task = task_configuration(
            "server",
            "fast-output-hold",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        let status = wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(10),
            |status| {
                status.state == RunLifecycleState::Running
                    && status.logs.iter().any(|entry| entry.line == "line-599")
                    && status.logs.iter().any(|entry| entry.line == "fast-stderr")
            },
        );

        assert_eq!(status.logs.len(), MAX_LOG_ENTRIES);
        assert!(!status.logs.iter().any(|entry| entry.line == "line-0"));
        let event_deadline = Instant::now() + Duration::from_secs(2);
        while !events
            .lock()
            .expect("events should lock")
            .iter()
            .any(|batch| {
                batch
                    .entries
                    .iter()
                    .any(|update| update.entry.line == "line-599")
            })
            && Instant::now() < event_deadline
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(events
            .lock()
            .expect("events should lock")
            .iter()
            .any(|batch| batch
                .entries
                .iter()
                .any(|update| update.entry.line == "line-599")));
        assert!(events
            .lock()
            .expect("events should lock")
            .iter()
            .all(|batch| batch.entries.len() <= MAX_LOG_EVENT_ENTRIES));
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("task should stop");
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn starts_and_stops_a_single_task_with_synchronized_events() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("single");
        let manager = Arc::new(RunManager::default());
        let events = Arc::new(Mutex::new(Vec::<RunWorkspaceSnapshot>::new()));
        let event_output = events.clone();
        manager.set_event_sink(Arc::new(move |snapshot| {
            event_output
                .lock()
                .expect("events should lock")
                .push(snapshot);
        }));
        let task = task_configuration(
            "server",
            "hold",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Running && status.pid.is_some(),
        );
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("task should stop");
        wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Stopped && status.pid.is_none(),
        );

        let observed_states = events
            .lock()
            .expect("events should lock")
            .iter()
            .flat_map(|snapshot| &snapshot.configurations)
            .map(|status| status.state)
            .collect::<Vec<_>>();
        assert!(observed_states.contains(&RunLifecycleState::Running));
        assert!(observed_states.contains(&RunLifecycleState::Stopped));
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn repeated_concurrent_starts_launch_one_process() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("concurrent-start");
        let marker = workspace.join("starts.marker");
        let manager = Arc::new(RunManager::default());
        let task = task_configuration(
            "server",
            "count-hold",
            ".",
            RunRestartPolicy::default(),
            None,
            Some(&marker),
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        let handles = (0..8)
            .map(|_| {
                let manager = manager.clone();
                let workspace = workspace.clone();
                thread::spawn(move || manager.start(workspace.to_string_lossy().as_ref(), None))
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle
                .join()
                .expect("start worker should finish")
                .expect("start should succeed");
        }
        wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Running,
        );
        let marker_deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < marker_deadline {
            thread::sleep(Duration::from_millis(25));
        }

        assert_eq!(
            fs::read_to_string(&marker)
                .expect("start marker should be readable")
                .lines()
                .count(),
            1
        );
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("task should stop");
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn active_runs_remain_stoppable_after_configuration_corruption() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("corrupted-active-config");
        let manager = Arc::new(RunManager::default());
        let task = task_configuration(
            "server",
            "hold",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        save_test_document(&manager, &workspace, "server", vec![task]);
        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Running,
        );
        fs::write(configuration_path(&workspace), "{invalid")
            .expect("configuration should be corrupted");

        assert_eq!(
            manager
                .snapshot(workspace.to_string_lossy().as_ref())
                .expect("cached active snapshot should remain available")
                .configurations[0]
                .state,
            RunLifecycleState::Running
        );
        assert_eq!(
            manager
                .start(workspace.to_string_lossy().as_ref(), None)
                .expect("repeated active start should reuse cached state")
                .configurations[0]
                .state,
            RunLifecycleState::Running
        );
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("cached configuration should remain stoppable");
        wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Stopped,
        );
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn composite_prevalidation_does_not_leave_partial_processes() {
        let workspace = temporary_workspace("composite-prevalidation");
        let missing_directory = workspace.join("missing-later");
        fs::create_dir_all(&missing_directory).expect("directory should initially exist");
        let marker = workspace.join("starts.marker");
        let manager = Arc::new(RunManager::default());
        let valid = task_configuration(
            "valid",
            "count-hold",
            ".",
            RunRestartPolicy::default(),
            None,
            Some(&marker),
        );
        let missing = task_configuration(
            "missing",
            "hold",
            "missing-later",
            RunRestartPolicy::default(),
            None,
            None,
        );
        let composite = RunConfiguration::Composite {
            id: "fullstack".to_string(),
            name: "Fullstack".to_string(),
            children: vec!["valid".to_string(), "missing".to_string()],
            start_order: CompositeStartOrder::Parallel,
        };
        save_test_document(
            &manager,
            &workspace,
            "fullstack",
            vec![valid, missing, composite],
        );
        fs::remove_dir_all(missing_directory).expect("directory should be removed");

        assert!(manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .is_err());
        thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists());
        assert!(manager
            .snapshot(workspace.to_string_lossy().as_ref())
            .expect("snapshot should load")
            .configurations
            .iter()
            .filter(|status| matches!(&status.configuration, RunConfiguration::Task { .. }))
            .all(|status| status.started_at.is_none()));
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn starts_and_stops_composite_children_with_one_action() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("composite");
        let manager = Arc::new(RunManager::default());
        let backend = task_configuration(
            "backend",
            "hold",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        let frontend = task_configuration(
            "frontend",
            "hold",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        let composite = RunConfiguration::Composite {
            id: "fullstack".to_string(),
            name: "Fullstack Start".to_string(),
            children: vec!["backend".to_string(), "frontend".to_string()],
            start_order: CompositeStartOrder::Parallel,
        };
        save_test_document(
            &manager,
            &workspace,
            "fullstack",
            vec![backend, frontend, composite],
        );

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("composite should start");
        let running = wait_for_status(
            &manager,
            &workspace,
            "fullstack",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Running,
        );
        assert!(running
            .children
            .iter()
            .all(|child| child.state == RunLifecycleState::Running));
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("composite should stop");
        wait_for_status(
            &manager,
            &workspace,
            "fullstack",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Stopped,
        );
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn sequential_composite_continues_after_a_successful_rapid_exit() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("sequential-composite");
        let manager = Arc::new(RunManager::default());
        let prepare = task_configuration(
            "prepare",
            "output-exit",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        let server = task_configuration(
            "server",
            "hold",
            ".",
            RunRestartPolicy::default(),
            None,
            None,
        );
        let composite = RunConfiguration::Composite {
            id: "application".to_string(),
            name: "Application".to_string(),
            children: vec!["prepare".to_string(), "server".to_string()],
            start_order: CompositeStartOrder::Sequence,
        };
        save_test_document(
            &manager,
            &workspace,
            "application",
            vec![prepare, server, composite],
        );

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("sequential composite should start");
        let running = wait_for_status(
            &manager,
            &workspace,
            "application",
            Duration::from_secs(10),
            |status| {
                let prepare_completed = status.children.iter().any(|child| {
                    child.configuration.id() == "prepare"
                        && child.state == RunLifecycleState::Stopped
                        && child.exit_code == Some(0)
                });
                let server_running = status.children.iter().any(|child| {
                    child.configuration.id() == "server"
                        && child.state == RunLifecycleState::Running
                });
                prepare_completed && server_running
            },
        );

        let prepare = running
            .children
            .iter()
            .find(|child| child.configuration.id() == "prepare")
            .expect("prepare child should exist");
        assert_eq!(prepare.state, RunLifecycleState::Stopped);
        assert_eq!(prepare.exit_code, Some(0));
        assert!(prepare
            .logs
            .iter()
            .any(|entry| entry.line == "stdout-ready"));
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("sequential composite should stop");
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn recovers_once_from_a_crashed_process() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("crash-recovery");
        let marker = workspace.join("crash.marker");
        let manager = Arc::new(RunManager::default());
        let task = task_configuration(
            "server",
            "crash-once",
            ".",
            RunRestartPolicy {
                on_crash: true,
                max_restarts: 3,
                window_ms: 10_000,
                backoff_ms: 25,
                max_backoff_ms: 100,
            },
            None,
            Some(&marker),
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        let status = wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(15),
            |status| status.state == RunLifecycleState::Running && status.restart_count == 1,
        );

        assert!(marker.exists());
        assert!(status
            .recent_failures
            .iter()
            .any(|failure| matches!(failure.kind, RunFailureKind::Crash)));
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("recovered task should stop");
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn failed_health_checks_stop_at_the_restart_limit() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("health-limit");
        let unavailable_port = TcpListener::bind("127.0.0.1:0")
            .expect("temporary port should bind")
            .local_addr()
            .expect("temporary address should resolve")
            .port();
        let manager = Arc::new(RunManager::default());
        let task = task_configuration(
            "server",
            "hold",
            ".",
            RunRestartPolicy {
                on_crash: false,
                max_restarts: 2,
                window_ms: 10_000,
                backoff_ms: 0,
                max_backoff_ms: 0,
            },
            Some(RunHealthCheck {
                kind: RunHealthCheckKind::Tcp,
                host: Some("127.0.0.1".to_string()),
                port: Some(unavailable_port),
                url: None,
                startup_delay_ms: 0,
                interval_ms: 250,
                timeout_ms: 100,
                failure_threshold: 1,
                restart_on_failure: true,
            }),
            None,
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        let status = wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(15),
            |status| {
                status.state == RunLifecycleState::Unhealthy
                    && status.restart_count == 2
                    && status.pid.is_none()
            },
        );

        assert!(status
            .recent_failures
            .iter()
            .any(|failure| { matches!(failure.kind, RunFailureKind::RestartLimit) }));
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("unhealthy task should stop explicitly");
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn shutdown_interrupts_a_pending_health_check_and_stops_the_process() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("pending-health-shutdown");
        let listener = TcpListener::bind("127.0.0.1:0").expect("health server should bind");
        let port = listener
            .local_addr()
            .expect("health server address should resolve")
            .port();
        let release_server = Arc::new(AtomicBool::new(false));
        let server_release = release_server.clone();
        let (accepted_sender, accepted_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("health request should connect");
            accepted_sender
                .send(())
                .expect("health connection should be reported");
            while !server_release.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(10));
            }
        });
        let manager = Arc::new(RunManager::default());
        let task = task_configuration(
            "server",
            "hold",
            ".",
            RunRestartPolicy::default(),
            Some(RunHealthCheck {
                kind: RunHealthCheckKind::Http,
                host: None,
                port: None,
                url: Some(format!("http://127.0.0.1:{port}/health")),
                startup_delay_ms: 0,
                interval_ms: 60_000,
                timeout_ms: 60_000,
                failure_threshold: 1,
                restart_on_failure: false,
            }),
            None,
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        accepted_receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("health check should begin");
        let started_shutdown = Instant::now();
        manager.shutdown();

        assert!(started_shutdown.elapsed() < Duration::from_secs(6));
        let status = wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(2),
            |status| status.state == RunLifecycleState::Stopped && status.pid.is_none(),
        );
        assert_eq!(status.state, RunLifecycleState::Stopped);
        release_server.store(true, Ordering::SeqCst);
        server.join().expect("health server should stop");
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn launches_from_the_configured_workspace_directory() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("working-directory");
        let application_directory = workspace.join("apps").join("server");
        fs::create_dir_all(&application_directory)
            .expect("application directory should be created");
        let marker = workspace.join("cwd.marker");
        let manager = Arc::new(RunManager::default());
        let task = task_configuration(
            "server",
            "record-cwd",
            "apps/server",
            RunRestartPolicy::default(),
            None,
            Some(&marker),
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            PathBuf::from(fs::read_to_string(&marker).expect("cwd marker should be readable"))
                .canonicalize()
                .expect("recorded cwd should canonicalize"),
            application_directory
                .canonicalize()
                .expect("application directory should canonicalize")
        );
        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("task should stop");
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn stop_terminates_descendant_processes() {
        let _process_test = serialize_child_process_test();
        let workspace = temporary_workspace("process-tree");
        let marker = workspace.join("descendant.pid");
        let manager = Arc::new(RunManager::default());
        let task = task_configuration(
            "server",
            "spawn-descendant",
            ".",
            RunRestartPolicy::default(),
            None,
            Some(&marker),
        );
        save_test_document(&manager, &workspace, "server", vec![task]);

        manager
            .start(workspace.to_string_lossy().as_ref(), None)
            .expect("task should start");
        let marker_deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < marker_deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let descendant_id = fs::read_to_string(&marker)
            .expect("descendant pid should be readable")
            .parse::<u32>()
            .expect("descendant pid should be numeric");
        assert!(process_is_running(descendant_id));

        manager
            .stop(workspace.to_string_lossy().as_ref(), None)
            .expect("task should stop");
        wait_for_status(
            &manager,
            &workspace,
            "server",
            Duration::from_secs(10),
            |status| status.state == RunLifecycleState::Stopped,
        );
        let process_deadline = Instant::now() + Duration::from_secs(5);
        while process_is_running(descendant_id) && Instant::now() < process_deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!process_is_running(descendant_id));
        manager.shutdown();
        let _ = fs::remove_dir_all(workspace);
    }
}
