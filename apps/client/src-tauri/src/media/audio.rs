use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _};

use super::{
    database, provider_local_diffusers, MediaCommandResult, MediaResult, MediaRunDetail,
    MediaRunPlanSnapshot, MediaRuntimePaths, MediaRuntimeState,
};

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerateMediaAudioRequest {
    pub(crate) schema_version: u32,
    pub(crate) run_id: String,
    pub(crate) flow_id: String,
    pub(crate) flow_revision_id: String,
    pub(crate) flow_name: String,
    pub(crate) plan_id: String,
    pub(crate) model_id: String,
    pub(crate) model_label: String,
    pub(crate) prompt: String,
    pub(crate) negative_prompt: String,
    pub(crate) duration_seconds: f64,
    pub(crate) num_inference_steps: u32,
    pub(crate) guidance_scale: f64,
    pub(crate) seed: u64,
    pub(crate) diagnostic_count: u32,
    pub(crate) plan_snapshot: MediaRunPlanSnapshot,
}

impl GenerateMediaAudioRequest {
    fn validate(&mut self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("Audio generation requires schemaVersion 1".into());
        }
        for (label, value, limit) in [
            ("runId", &mut self.run_id, 128),
            ("flowId", &mut self.flow_id, 128),
            ("flowRevisionId", &mut self.flow_revision_id, 128),
            ("flowName", &mut self.flow_name, 256),
            ("planId", &mut self.plan_id, 128),
            ("modelId", &mut self.model_id, 128),
            ("modelLabel", &mut self.model_label, 256),
            ("prompt", &mut self.prompt, 8_000),
        ] {
            *value = super::required_text(label, value, limit)?;
        }
        if self.negative_prompt.chars().count() > 8_000
            || !self.duration_seconds.is_finite()
            || !(1.0..=30.0).contains(&self.duration_seconds)
            || !(1..=200).contains(&self.num_inference_steps)
            || !self.guidance_scale.is_finite()
            || !(0.0..=20.0).contains(&self.guidance_scale)
            || self.seed > super::MAX_IMAGE_GENERATION_SEED
        {
            return Err("Check audio duration, steps, guidance, and seed.".into());
        }
        self.plan_snapshot.validate(&self.plan_id, &self.flow_id)?;
        let tasks: Vec<_> = self
            .plan_snapshot
            .nodes
            .iter()
            .filter(|node| node.layer == "task")
            .collect();
        if tasks.len() != 1
            || tasks[0].r#type != "task.generate-audio"
            || self
                .plan_snapshot
                .nodes
                .iter()
                .filter(|node| node.r#type == "output.audio")
                .count()
                != 1
        {
            return Err("Choose one audio generator and one audio output.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioOutput {
    pub(crate) file_name: String,
    pub(crate) sample_rate: u32,
    pub(crate) channels: u16,
    pub(crate) frames: u64,
    pub(crate) duration_seconds: f64,
    pub(crate) seed: u64,
    pub(crate) digest: String,
    pub(crate) byte_size: u64,
}

pub(crate) struct GeneratedAudio {
    pub(crate) relative_path: String,
    pub(crate) output: AudioOutput,
    pub(crate) provenance: serde_json::Value,
}

#[tauri::command]
pub(crate) async fn media_generate_audio(
    app: AppHandle,
    mut request: GenerateMediaAudioRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result = async {
        request.validate()?;
        let _sleep_inhibition = super::inhibit_system_sleep_for_media_work(&app)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        let state = app.state::<MediaRuntimeState>();
        let Some(_active_run) = state.claim_run(&request.run_id)? else {
            return database::get_run_detail(&paths, &request.run_id);
        };
        if !database::audio::begin(&paths, &request)? {
            return database::get_run_detail(&paths, &request.run_id);
        }
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["source.prompt"],
            "completed",
            Some("audio.inputs"),
            Some("Prompt resolved"),
            Some(0.08),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.generate-audio"],
            "running",
            Some("audio.generate"),
            Some("Generating audio"),
            Some(0.1),
        )?;
        let generation_app = app.clone();
        let generation_paths = paths.clone();
        let generation_request = request.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            provider_local_diffusers::generate_audio(
                &generation_app,
                &generation_paths,
                &generation_request,
            )
        })
        .await
        .map_err(|error| format!("Audio worker could not be joined: {error}"))
        .and_then(|result| result);
        let publication =
            generated.and_then(|audio| database::audio::complete(&paths, &request, &audio));
        if let Err(error) = publication {
            if database::is_cancellation_requested(&paths, &request.run_id)? {
                database::cancel_run(&paths, &request.run_id)?;
            } else {
                database::fail_run(&paths, &request.run_id, &error)?;
            }
        }
        database::get_run_detail(&paths, &request.run_id)
    }
    .await;
    super::command_result("media_generate_audio", result)
}
