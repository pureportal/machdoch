use super::commands::truncate_chars;
use super::shell::{
    RemoteShellAttachment, RemoteShellComposer, RemoteShellContextPack,
    RemoteShellInstructionProfile, RemoteShellInstructions, RemoteShellMedia,
    RemoteShellMediaAsset, RemoteShellMediaGeneration, RemoteShellMediaModel, RemoteShellMediaRun,
    RemoteShellMessage, RemoteShellMessageSource, RemoteShellQuickTask, RemoteShellRuntime,
    RemoteShellRuntimeCapability, RemoteShellScheduler, RemoteShellSchedulerJob,
    RemoteShellSchedulerRun, RemoteShellSession, RemoteShellSnapshot, RemoteShellTraceEntry,
    RemoteShellVoice, RemoteShellWorkspace,
};
use super::{
    now_millis, MAX_COMMAND_TEXT_CHARS, MAX_REMOTE_CONTEXT_PACKS, MAX_REMOTE_MEDIA_ASSETS,
    MAX_REMOTE_MEDIA_MODELS, MAX_REMOTE_MEDIA_PREVIEW_CHARS, MAX_REMOTE_MEDIA_RUNS,
    MAX_REMOTE_PROMPT_HISTORY, MAX_REMOTE_SCHEDULER_JOBS, MAX_REMOTE_SCHEDULER_RUNS,
    MAX_REMOTE_SHELL_MESSAGES, MAX_REMOTE_SHELL_SESSIONS, MAX_REMOTE_SHORT_TEXT_CHARS,
    MAX_REMOTE_TEXT_CHARS,
};
use machdoch_fleet_protocol::PRODUCT_SNAPSHOT_VERSION;

pub(super) fn sanitize_shell_snapshot(
    mut snapshot: RemoteShellSnapshot,
) -> Result<RemoteShellSnapshot, String> {
    if snapshot.version != PRODUCT_SNAPSHOT_VERSION {
        return Err(format!(
            "The Mission Control shell snapshot does not match schema version {PRODUCT_SNAPSHOT_VERSION}."
        ));
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

    snapshot.workspaces = snapshot
        .workspaces
        .into_iter()
        .take(40)
        .filter_map(sanitize_shell_workspace)
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
    snapshot.instructions = snapshot.instructions.map(sanitize_shell_instructions);
    snapshot.prompt_history = snapshot
        .prompt_history
        .into_iter()
        .map(|prompt| sanitize_text(prompt, MAX_REMOTE_TEXT_CHARS))
        .filter(|prompt| !prompt.is_empty())
        .take(MAX_REMOTE_PROMPT_HISTORY)
        .collect();
    snapshot.voice = snapshot.voice.map(sanitize_shell_voice);
    snapshot.quick_task = snapshot.quick_task.map(sanitize_shell_quick_task);
    snapshot.media = snapshot.media.map(sanitize_shell_media);

    Ok(snapshot)
}

fn sanitize_shell_workspace(mut workspace: RemoteShellWorkspace) -> Option<RemoteShellWorkspace> {
    workspace.root = sanitize_text(workspace.root, MAX_REMOTE_TEXT_CHARS);
    workspace.label = sanitize_text(workspace.label, MAX_REMOTE_SHORT_TEXT_CHARS);
    if workspace.root.is_empty() {
        return None;
    }
    if workspace.label.is_empty() {
        workspace.label = workspace.root.clone();
    }
    Some(workspace)
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
    session.reasoning = sanitize_optional_text(session.reasoning, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.effective_reasoning =
        sanitize_text(session.effective_reasoning, MAX_REMOTE_SHORT_TEXT_CHARS);
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
    message.presentation = match message.presentation.as_str() {
        "prompt-enhancement" => "prompt-enhancement".to_string(),
        _ => "message".to_string(),
    };
    message.task_id = sanitize_optional_text(message.task_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    message.task_action = message.task_action.and_then(|mut task_action| {
        task_action.objective = sanitize_text(task_action.objective, MAX_REMOTE_TEXT_CHARS);
        (!task_action.objective.is_empty()).then_some(task_action)
    });
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

fn sanitize_shell_attachment(attachment: RemoteShellAttachment) -> Option<RemoteShellAttachment> {
    match attachment {
        RemoteShellAttachment::Path {
            id,
            kind,
            name,
            path,
            parent,
        } => {
            let id = sanitize_text(id, MAX_REMOTE_SHORT_TEXT_CHARS);
            let name = sanitize_text(name, MAX_REMOTE_SHORT_TEXT_CHARS);
            if id.is_empty() || name.is_empty() {
                return None;
            }
            Some(RemoteShellAttachment::Path {
                id,
                kind: sanitize_text(kind, MAX_REMOTE_SHORT_TEXT_CHARS),
                name,
                path: sanitize_text(path, MAX_REMOTE_TEXT_CHARS),
                parent: sanitize_optional_text(parent, MAX_REMOTE_TEXT_CHARS),
            })
        }
        RemoteShellAttachment::MediaAsset {
            id,
            kind,
            name,
            workspace_root,
            asset_id,
        } => {
            let id = sanitize_text(id, MAX_REMOTE_SHORT_TEXT_CHARS);
            let name = sanitize_text(name, MAX_REMOTE_SHORT_TEXT_CHARS);
            let asset_id = sanitize_text(asset_id, MAX_REMOTE_SHORT_TEXT_CHARS);
            if id.is_empty() || name.is_empty() || asset_id.is_empty() {
                return None;
            }
            Some(RemoteShellAttachment::MediaAsset {
                id,
                kind: sanitize_text(kind, MAX_REMOTE_SHORT_TEXT_CHARS),
                name,
                workspace_root: sanitize_text(workspace_root, MAX_REMOTE_TEXT_CHARS),
                asset_id,
            })
        }
    }
}

fn sanitize_shell_composer(mut composer: RemoteShellComposer) -> Option<RemoteShellComposer> {
    composer.session_id = sanitize_text(composer.session_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if composer.session_id.is_empty() {
        return None;
    }

    composer.draft = sanitize_text(composer.draft, MAX_REMOTE_TEXT_CHARS);
    composer.provider = sanitize_text(composer.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.provider_label = sanitize_text(composer.provider_label, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.model = sanitize_text(composer.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.model_label = sanitize_text(composer.model_label, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.model_catalog = composer
        .model_catalog
        .into_iter()
        .take(12)
        .map(|mut provider| {
            provider.provider = sanitize_text(provider.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
            provider.label = sanitize_text(provider.label, MAX_REMOTE_SHORT_TEXT_CHARS);
            provider.error = sanitize_optional_text(provider.error, MAX_REMOTE_TEXT_CHARS);
            provider.models = provider
                .models
                .into_iter()
                .take(256)
                .map(|mut model| {
                    model.id = sanitize_text(model.id, MAX_REMOTE_SHORT_TEXT_CHARS);
                    model.label = sanitize_text(model.label, MAX_REMOTE_SHORT_TEXT_CHARS);
                    model
                })
                .filter(|model| !model.id.is_empty() && !model.label.is_empty())
                .collect();
            provider
        })
        .filter(|provider| !provider.provider.is_empty() && !provider.label.is_empty())
        .collect();
    composer.mode = sanitize_text(composer.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.default_mode = sanitize_text(composer.default_mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.reasoning = sanitize_text(composer.reasoning, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.default_reasoning =
        sanitize_text(composer.default_reasoning, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.reasoning_options = composer
        .reasoning_options
        .into_iter()
        .map(|mode| sanitize_text(mode, MAX_REMOTE_SHORT_TEXT_CHARS))
        .filter(|mode| {
            matches!(
                mode.as_str(),
                "default"
                    | "none"
                    | "minimal"
                    | "low"
                    | "medium"
                    | "high"
                    | "xhigh"
                    | "max"
                    | "ultra"
            )
        })
        .take(9)
        .collect();
    if composer.reasoning_options.is_empty() {
        composer.reasoning_options.push("default".to_string());
    }
    composer.prompt_enhancement_mode = match composer.prompt_enhancement_mode.as_str() {
        "simple" => "simple".to_string(),
        "web-search" => "web-search".to_string(),
        _ => "off".to_string(),
    };
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
    runtime.reasoning = sanitize_optional_text(runtime.reasoning, MAX_REMOTE_SHORT_TEXT_CHARS);
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
    pack.scope = sanitize_optional_text(pack.scope, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.scope_label = sanitize_optional_text(pack.scope_label, MAX_REMOTE_SHORT_TEXT_CHARS);
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
    pack.reasoning = sanitize_optional_text(pack.reasoning, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.prompt_enhancement_mode =
        sanitize_optional_text(pack.prompt_enhancement_mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    Some(pack)
}

fn sanitize_shell_instructions(
    mut instructions: RemoteShellInstructions,
) -> RemoteShellInstructions {
    instructions.error = sanitize_optional_text(instructions.error, MAX_REMOTE_TEXT_CHARS);
    instructions.profiles = instructions
        .profiles
        .into_iter()
        .take(128)
        .filter_map(sanitize_shell_instruction_profile)
        .collect();
    instructions
}

fn sanitize_shell_instruction_profile(
    mut profile: RemoteShellInstructionProfile,
) -> Option<RemoteShellInstructionProfile> {
    profile.id = sanitize_text(profile.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    profile.name = sanitize_text(profile.name, MAX_REMOTE_SHORT_TEXT_CHARS);
    if profile.id.is_empty() || profile.name.is_empty() {
        return None;
    }
    profile.description = sanitize_optional_text(profile.description, 2_000);
    profile.body = sanitize_optional_text(profile.body, MAX_REMOTE_TEXT_CHARS);
    profile.tags = profile
        .tags
        .into_iter()
        .map(|tag| sanitize_text(tag, 80))
        .filter(|tag| !tag.is_empty())
        .take(64)
        .collect();
    Some(profile)
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

fn sanitize_shell_media(mut media: RemoteShellMedia) -> RemoteShellMedia {
    media.error = sanitize_optional_text(media.error, MAX_REMOTE_TEXT_CHARS);
    media.runtime_mode = match media.runtime_mode.as_deref() {
        Some("native") => Some("native".to_string()),
        Some("browser-preview") => Some("browser-preview".to_string()),
        _ => None,
    };
    media.generation = sanitize_shell_media_generation(media.generation);
    media.models = media
        .models
        .into_iter()
        .take(MAX_REMOTE_MEDIA_MODELS)
        .filter_map(sanitize_shell_media_model)
        .collect();
    media.assets = media
        .assets
        .into_iter()
        .take(MAX_REMOTE_MEDIA_ASSETS)
        .filter_map(sanitize_shell_media_asset)
        .collect();
    media.runs = media
        .runs
        .into_iter()
        .take(MAX_REMOTE_MEDIA_RUNS)
        .filter_map(sanitize_shell_media_run)
        .collect();
    media.asset_count = media.asset_count.max(media.assets.len());
    media.run_count = media.run_count.max(media.runs.len());
    media
}

fn sanitize_shell_media_generation(
    mut generation: RemoteShellMediaGeneration,
) -> RemoteShellMediaGeneration {
    generation.prompt = sanitize_text(generation.prompt, MAX_COMMAND_TEXT_CHARS);
    generation.target = match generation.target.as_str() {
        "svg" => "svg".to_string(),
        _ => "image".to_string(),
    };
    generation.model_id = sanitize_optional_text(generation.model_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    generation.aspect_ratio = match generation.aspect_ratio.as_str() {
        "4:5" => "4:5".to_string(),
        "16:9" => "16:9".to_string(),
        "9:16" => "9:16".to_string(),
        _ => "1:1".to_string(),
    };
    generation.output_count = generation.output_count.clamp(1, 8);
    generation.output_format = if generation.target == "svg" {
        "svg".to_string()
    } else {
        match generation.output_format.as_str() {
            "jpeg" => "jpeg".to_string(),
            "webp" => "webp".to_string(),
            _ => "png".to_string(),
        }
    };
    generation.unavailable_reason =
        sanitize_optional_text(generation.unavailable_reason, MAX_REMOTE_TEXT_CHARS);
    generation
}

fn sanitize_shell_media_model(mut model: RemoteShellMediaModel) -> Option<RemoteShellMediaModel> {
    model.id = sanitize_text(model.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    model.label = sanitize_text(model.label, MAX_REMOTE_SHORT_TEXT_CHARS);
    if model.id.is_empty() || model.label.is_empty() {
        return None;
    }
    model.target = match model.target.as_str() {
        "local" => "local".to_string(),
        "remote" => "remote".to_string(),
        _ => return None,
    };
    model.targets = model
        .targets
        .into_iter()
        .filter(|target| matches!(target.as_str(), "image" | "svg"))
        .take(2)
        .collect();
    if model.targets.is_empty() {
        return None;
    }
    model.cost_hint = sanitize_optional_text(model.cost_hint, MAX_REMOTE_SHORT_TEXT_CHARS);
    Some(model)
}

fn sanitize_shell_media_asset(mut asset: RemoteShellMediaAsset) -> Option<RemoteShellMediaAsset> {
    asset.id = sanitize_text(asset.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    asset.run_id = sanitize_text(asset.run_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if asset.id.is_empty() || asset.run_id.is_empty() {
        return None;
    }
    asset.kind = match asset.kind.as_str() {
        "image" | "video" | "vector" | "report" => asset.kind,
        _ => return None,
    };
    asset.mime_type = sanitize_text(asset.mime_type, 80);
    asset.created_at = sanitize_text(asset.created_at, 80);
    asset.preview_data_url = asset.preview_data_url.and_then(|preview| {
        (preview.len() <= MAX_REMOTE_MEDIA_PREVIEW_CHARS && preview.starts_with("data:image/"))
            .then_some(preview)
    });
    asset.tags = asset
        .tags
        .into_iter()
        .map(|tag| sanitize_text(tag, 80))
        .filter(|tag| !tag.is_empty())
        .take(8)
        .collect();
    Some(asset)
}

fn sanitize_shell_media_run(mut run: RemoteShellMediaRun) -> Option<RemoteShellMediaRun> {
    run.id = sanitize_text(run.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if run.id.is_empty() {
        return None;
    }
    run.status = match run.status.as_str() {
        "queued" | "running" | "needs-review" | "waiting-for-review" | "canceling"
        | "completed" | "failed" | "canceled" => run.status,
        _ => "failed".to_string(),
    };
    run.created_at = sanitize_text(run.created_at, 80);
    run.updated_at = sanitize_text(run.updated_at, 80);
    run.prompt = sanitize_text(run.prompt, MAX_REMOTE_TEXT_CHARS);
    run.model_label = sanitize_text(run.model_label, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.target = match run.target.as_deref() {
        Some("local") => Some("local".to_string()),
        Some("remote") => Some("remote".to_string()),
        _ => None,
    };
    run.progress = if run.progress.is_finite() {
        run.progress.clamp(0.0, 1.0)
    } else {
        0.0
    };
    run.current_step = sanitize_text(run.current_step, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.error = sanitize_optional_text(run.error, MAX_REMOTE_TEXT_CHARS);
    Some(run)
}

fn sanitize_text(value: String, max_chars: usize) -> String {
    truncate_chars(value.trim(), max_chars)
}

fn sanitize_optional_text(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|value| sanitize_text(value, max_chars))
        .filter(|value| !value.is_empty())
}
