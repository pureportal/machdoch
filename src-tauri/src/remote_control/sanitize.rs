use super::commands::truncate_chars;
use super::shell::{
    RemoteShellAttachment, RemoteShellComposer, RemoteShellContextPack, RemoteShellMessage,
    RemoteShellMessageSource, RemoteShellQuickTask, RemoteShellRuntime,
    RemoteShellRuntimeCapability, RemoteShellScheduler, RemoteShellSchedulerJob,
    RemoteShellSchedulerRun, RemoteShellSession, RemoteShellSnapshot, RemoteShellTraceEntry,
    RemoteShellVoice,
};
use super::{
    now_millis, MAX_REMOTE_CONTEXT_PACKS, MAX_REMOTE_PROMPT_HISTORY, MAX_REMOTE_SCHEDULER_JOBS,
    MAX_REMOTE_SCHEDULER_RUNS, MAX_REMOTE_SHELL_MESSAGES, MAX_REMOTE_SHELL_SESSIONS,
    MAX_REMOTE_SHORT_TEXT_CHARS, MAX_REMOTE_TEXT_CHARS,
};

pub(super) fn sanitize_shell_snapshot(
    mut snapshot: RemoteShellSnapshot,
) -> Result<RemoteShellSnapshot, String> {
    if snapshot.version == 0 {
        snapshot.version = 1;
    }

    if snapshot.captured_at == 0 {
        snapshot.captured_at = now_millis();
    }

    snapshot.active_session_id =
        sanitize_optional_text(snapshot.active_session_id, MAX_REMOTE_SHORT_TEXT_CHARS);

    snapshot.sessions = snapshot
        .sessions
        .into_iter()
        .take(MAX_REMOTE_SHELL_SESSIONS)
        .filter_map(sanitize_shell_session)
        .collect();

    snapshot.visible_messages = snapshot
        .visible_messages
        .into_iter()
        .take(MAX_REMOTE_SHELL_MESSAGES)
        .filter_map(sanitize_shell_message)
        .collect();

    snapshot.composer = snapshot.composer.and_then(sanitize_shell_composer);
    snapshot.runtime = snapshot.runtime.map(sanitize_shell_runtime);
    snapshot.scheduler = snapshot.scheduler.map(sanitize_shell_scheduler);
    snapshot.context_packs = snapshot
        .context_packs
        .into_iter()
        .take(MAX_REMOTE_CONTEXT_PACKS)
        .filter_map(sanitize_shell_context_pack)
        .collect();
    snapshot.prompt_history = snapshot
        .prompt_history
        .into_iter()
        .map(|prompt| sanitize_text(prompt, MAX_REMOTE_TEXT_CHARS))
        .filter(|prompt| !prompt.is_empty())
        .take(MAX_REMOTE_PROMPT_HISTORY)
        .collect();
    snapshot.voice = snapshot.voice.map(sanitize_shell_voice);
    snapshot.quick_task = snapshot.quick_task.map(sanitize_shell_quick_task);

    Ok(snapshot)
}

fn sanitize_shell_session(mut session: RemoteShellSession) -> Option<RemoteShellSession> {
    session.id = sanitize_text(session.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if session.id.is_empty() {
        return None;
    }

    session.title = sanitize_text(session.title, MAX_REMOTE_SHORT_TEXT_CHARS);
    if session.title.is_empty() {
        session.title = "Untitled session".to_string();
    }
    session.status = sanitize_text(session.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.workspace = sanitize_optional_text(session.workspace, MAX_REMOTE_TEXT_CHARS);
    session.provider = sanitize_text(session.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.model = sanitize_text(session.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.mode = sanitize_optional_text(session.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.effective_mode = sanitize_text(session.effective_mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.tags = session
        .tags
        .into_iter()
        .map(|tag| sanitize_text(tag, 64))
        .filter(|tag| !tag.is_empty())
        .take(24)
        .collect();
    session.running_task_id =
        sanitize_optional_text(session.running_task_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.special_kind =
        sanitize_optional_text(session.special_kind, MAX_REMOTE_SHORT_TEXT_CHARS);

    Some(session)
}

fn sanitize_shell_message(mut message: RemoteShellMessage) -> Option<RemoteShellMessage> {
    message.id = sanitize_text(message.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if message.id.is_empty() {
        return None;
    }

    message.role = sanitize_text(message.role, MAX_REMOTE_SHORT_TEXT_CHARS);
    message.content = sanitize_text(message.content, MAX_REMOTE_TEXT_CHARS);
    message.task_id = sanitize_optional_text(message.task_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    message.intent = sanitize_optional_text(message.intent, MAX_REMOTE_SHORT_TEXT_CHARS);
    message.attachments = message
        .attachments
        .into_iter()
        .take(24)
        .filter_map(sanitize_shell_attachment)
        .collect();
    message.source = message.source.map(sanitize_shell_message_source);

    Some(message)
}

fn sanitize_shell_message_source(mut source: RemoteShellMessageSource) -> RemoteShellMessageSource {
    source.kind = sanitize_text(source.kind, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.status = sanitize_optional_text(source.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.title = sanitize_optional_text(source.title, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.summary = sanitize_optional_text(source.summary, MAX_REMOTE_TEXT_CHARS);
    source.mode = sanitize_optional_text(source.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.entries = source
        .entries
        .into_iter()
        .take(24)
        .filter_map(sanitize_shell_trace_entry)
        .collect();
    source.timeline = source
        .timeline
        .into_iter()
        .take(40)
        .filter_map(sanitize_shell_trace_entry)
        .collect();
    source
}

fn sanitize_shell_trace_entry(mut entry: RemoteShellTraceEntry) -> Option<RemoteShellTraceEntry> {
    entry.label = sanitize_text(entry.label, MAX_REMOTE_SHORT_TEXT_CHARS);
    entry.detail = sanitize_text(entry.detail, 1_500);
    entry.tone = sanitize_optional_text(entry.tone, MAX_REMOTE_SHORT_TEXT_CHARS);

    if entry.label.is_empty() && entry.detail.is_empty() {
        return None;
    }

    Some(entry)
}

fn sanitize_shell_attachment(
    mut attachment: RemoteShellAttachment,
) -> Option<RemoteShellAttachment> {
    attachment.id = sanitize_text(attachment.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    attachment.kind = sanitize_text(attachment.kind, MAX_REMOTE_SHORT_TEXT_CHARS);
    attachment.name = sanitize_text(attachment.name, MAX_REMOTE_SHORT_TEXT_CHARS);
    attachment.path = sanitize_text(attachment.path, MAX_REMOTE_TEXT_CHARS);
    attachment.parent = sanitize_optional_text(attachment.parent, MAX_REMOTE_TEXT_CHARS);

    if attachment.id.is_empty() || attachment.name.is_empty() {
        return None;
    }

    Some(attachment)
}

fn sanitize_shell_composer(mut composer: RemoteShellComposer) -> Option<RemoteShellComposer> {
    composer.session_id = sanitize_text(composer.session_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if composer.session_id.is_empty() {
        return None;
    }

    composer.draft = sanitize_text(composer.draft, MAX_REMOTE_TEXT_CHARS);
    composer.provider = sanitize_text(composer.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.model = sanitize_text(composer.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.mode = sanitize_text(composer.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.default_mode = sanitize_text(composer.default_mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.workspace = sanitize_optional_text(composer.workspace, MAX_REMOTE_TEXT_CHARS);
    composer.workspace_label = sanitize_text(composer.workspace_label, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.send_disabled_reason =
        sanitize_optional_text(composer.send_disabled_reason, MAX_REMOTE_TEXT_CHARS);
    composer.ui_control_description =
        sanitize_text(composer.ui_control_description, MAX_REMOTE_TEXT_CHARS);
    composer.attachments = composer
        .attachments
        .into_iter()
        .take(24)
        .filter_map(sanitize_shell_attachment)
        .collect();
    composer.chooser_providers = composer
        .chooser_providers
        .into_iter()
        .map(|provider| sanitize_text(provider, MAX_REMOTE_SHORT_TEXT_CHARS))
        .filter(|provider| !provider.is_empty())
        .take(12)
        .collect();
    composer.matched_context_pack_ids = composer
        .matched_context_pack_ids
        .into_iter()
        .map(|id| sanitize_text(id, MAX_REMOTE_SHORT_TEXT_CHARS))
        .filter(|id| !id.is_empty())
        .take(24)
        .collect();

    Some(composer)
}

fn sanitize_shell_runtime(mut runtime: RemoteShellRuntime) -> RemoteShellRuntime {
    runtime.error = sanitize_optional_text(runtime.error, MAX_REMOTE_TEXT_CHARS);
    runtime.provider_statuses = runtime
        .provider_statuses
        .into_iter()
        .map(|mut status| {
            status.provider = sanitize_text(status.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
            status.reason = sanitize_optional_text(status.reason, MAX_REMOTE_TEXT_CHARS);
            status
        })
        .filter(|status| !status.provider.is_empty())
        .take(12)
        .collect();
    runtime.mode = sanitize_optional_text(runtime.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    runtime.ui_control = runtime.ui_control.map(sanitize_shell_runtime_capability);
    runtime.web_search = runtime.web_search.map(sanitize_shell_runtime_capability);
    runtime
}

fn sanitize_shell_runtime_capability(
    mut capability: RemoteShellRuntimeCapability,
) -> RemoteShellRuntimeCapability {
    capability.reason = sanitize_optional_text(capability.reason, MAX_REMOTE_TEXT_CHARS);
    capability
}

fn sanitize_shell_scheduler(mut scheduler: RemoteShellScheduler) -> RemoteShellScheduler {
    scheduler.workspace_root =
        sanitize_optional_text(scheduler.workspace_root, MAX_REMOTE_TEXT_CHARS);
    scheduler.error = sanitize_optional_text(scheduler.error, MAX_REMOTE_TEXT_CHARS);
    scheduler.jobs = scheduler
        .jobs
        .into_iter()
        .take(MAX_REMOTE_SCHEDULER_JOBS)
        .filter_map(sanitize_shell_scheduler_job)
        .collect();
    scheduler.runs = scheduler
        .runs
        .into_iter()
        .take(MAX_REMOTE_SCHEDULER_RUNS)
        .filter_map(sanitize_shell_scheduler_run)
        .collect();
    scheduler
}

fn sanitize_shell_scheduler_job(
    mut job: RemoteShellSchedulerJob,
) -> Option<RemoteShellSchedulerJob> {
    job.id = sanitize_text(job.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if job.id.is_empty() {
        return None;
    }

    job.name = sanitize_text(job.name, MAX_REMOTE_SHORT_TEXT_CHARS);
    job.status = sanitize_text(job.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    job.schedule = sanitize_text(job.schedule, MAX_REMOTE_SHORT_TEXT_CHARS);
    job.prompt_preview = sanitize_text(job.prompt_preview, 1_000);
    Some(job)
}

fn sanitize_shell_scheduler_run(
    mut run: RemoteShellSchedulerRun,
) -> Option<RemoteShellSchedulerRun> {
    run.id = sanitize_text(run.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.job_id = sanitize_text(run.job_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if run.id.is_empty() || run.job_id.is_empty() {
        return None;
    }

    run.source = sanitize_text(run.source, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.status = sanitize_text(run.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.error = sanitize_optional_text(run.error, MAX_REMOTE_TEXT_CHARS);
    run.summary = sanitize_optional_text(run.summary, MAX_REMOTE_TEXT_CHARS);
    Some(run)
}

fn sanitize_shell_context_pack(mut pack: RemoteShellContextPack) -> Option<RemoteShellContextPack> {
    pack.id = sanitize_text(pack.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if pack.id.is_empty() {
        return None;
    }

    pack.name = sanitize_text(pack.name, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.workspace = sanitize_optional_text(pack.workspace, MAX_REMOTE_TEXT_CHARS);
    pack.instructions_preview = sanitize_text(pack.instructions_preview, 1_000);
    pack.prompt_preview = sanitize_text(pack.prompt_preview, 1_000);
    pack.variables = pack
        .variables
        .into_iter()
        .map(|variable| sanitize_text(variable, MAX_REMOTE_SHORT_TEXT_CHARS))
        .filter(|variable| !variable.is_empty())
        .take(16)
        .collect();
    pack.provider = sanitize_optional_text(pack.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.model = sanitize_optional_text(pack.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.mode = sanitize_optional_text(pack.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    Some(pack)
}

fn sanitize_shell_voice(mut voice: RemoteShellVoice) -> RemoteShellVoice {
    voice.speaking_message_id =
        sanitize_optional_text(voice.speaking_message_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    voice.speech_input_status =
        sanitize_optional_text(voice.speech_input_status, MAX_REMOTE_TEXT_CHARS);
    voice
}

fn sanitize_shell_quick_task(mut quick_task: RemoteShellQuickTask) -> RemoteShellQuickTask {
    quick_task.status = sanitize_text(quick_task.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    quick_task.draft = sanitize_text(quick_task.draft, MAX_REMOTE_TEXT_CHARS);
    quick_task.provider = sanitize_text(quick_task.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    quick_task.model = sanitize_text(quick_task.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    quick_task
}

fn sanitize_text(value: String, max_chars: usize) -> String {
    truncate_chars(value.trim(), max_chars)
}

fn sanitize_optional_text(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|value| sanitize_text(value, max_chars))
        .filter(|value| !value.is_empty())
}
