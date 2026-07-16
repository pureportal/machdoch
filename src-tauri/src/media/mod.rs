mod analysis;
mod catalog;
mod civitai_addon;
mod database;
mod error;
mod executor;
mod exporting;
mod flow;
mod hardware;
mod ingest;
mod local_flow;
mod model_addon;
mod model_import;
mod model_install;
mod provider_local_diffusers;
mod provider_mock;
mod provider_openai;
mod provider_svg;
mod subject_cutout;
mod svg;
mod transform;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _};

pub(crate) type MediaResult<T> = Result<T, String>;

use error::{command_result, MediaCommandResult, MediaError};

#[derive(Debug, Clone)]
pub(crate) struct MediaRuntimePaths {
    pub(crate) database: PathBuf,
    pub(crate) blobs: PathBuf,
}

impl MediaRuntimePaths {
    fn resolve(app: &AppHandle) -> MediaResult<Self> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve Media Studio data directory: {error}"))?
            .join("media-studio");

        Ok(Self {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs").join("sha256"),
        })
    }

    fn models_root(&self) -> MediaResult<PathBuf> {
        self.database
            .parent()
            .map(|root| root.join("models"))
            .ok_or_else(|| "Media Studio storage path has no parent directory".to_string())
    }
}

#[derive(Default)]
pub(crate) struct MediaRuntimeState {
    active_runs: Mutex<HashSet<String>>,
    active_model_installs: Mutex<HashSet<String>>,
    local_diffusers_status: Mutex<Option<provider_local_diffusers::LocalDiffusersRuntimeStatus>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RalphMediaResolvedInputBinding {
    pub(crate) source: String,
    pub(crate) value: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RalphMediaFlowRunRequest {
    pub(crate) run_id: String,
    pub(crate) flow_id: String,
    pub(crate) revision_id: String,
    pub(crate) input_bindings: HashMap<String, RalphMediaResolvedInputBinding>,
    pub(crate) approval_policy: String,
}

impl MediaRuntimeState {
    fn begin_run(&self, run_id: &str) -> MediaResult<bool> {
        let mut active_runs = self
            .active_runs
            .lock()
            .map_err(|_| "Media Studio worker state is unavailable".to_string())?;
        Ok(active_runs.insert(run_id.to_string()))
    }

    fn finish_run(&self, run_id: &str) {
        if let Ok(mut active_runs) = self.active_runs.lock() {
            active_runs.remove(run_id);
        }
    }

    fn active_count(&self) -> u32 {
        self.active_runs
            .lock()
            .map(|active_runs| active_runs.len() as u32)
            .unwrap_or(0)
    }

    fn local_diffusers_status(
        &self,
        app: &AppHandle,
    ) -> provider_local_diffusers::LocalDiffusersRuntimeStatus {
        if let Ok(status) = self.local_diffusers_status.lock() {
            if let Some(status) = status.as_ref() {
                return status.clone();
            }
        }
        let probed = provider_local_diffusers::probe(app);
        if let Ok(mut status) = self.local_diffusers_status.lock() {
            *status = Some(probed.clone());
        }
        probed
    }

    fn begin_model_install(&self, job_id: &str) -> MediaResult<bool> {
        let mut active_installs = self
            .active_model_installs
            .lock()
            .map_err(|_| "Media Studio model installer state is unavailable".to_string())?;
        Ok(active_installs.insert(job_id.to_string()))
    }

    fn finish_model_install(&self, job_id: &str) {
        if let Ok(mut active_installs) = self.active_model_installs.lock() {
            active_installs.remove(job_id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRuntimeStatus {
    schema_version: u32,
    recovered_runs: u32,
    queued_runs: u32,
    active_runs: u32,
    storage_ready: bool,
    mode: &'static str,
    direct_generation_model_ids: Vec<String>,
    direct_reference_image_model_ids: Vec<String>,
    local_diffusers: provider_local_diffusers::LocalDiffusersRuntimeStatus,
}

fn direct_generation_model_ids(
    paths: &MediaRuntimePaths,
    local_diffusers: &provider_local_diffusers::LocalDiffusersRuntimeStatus,
) -> MediaResult<Vec<String>> {
    let mut model_ids = vec![
        "openai:gpt-image-2".to_string(),
        "quiver:arrow-1.1-max".to_string(),
        "quiver:arrow-1.1".to_string(),
        "recraft:recraftv4_1_pro_vector".to_string(),
        "recraft:recraftv4_1_vector".to_string(),
        "local-svg:IntroSVG-Qwen2.5-VL-7B".to_string(),
        "local-svg:InternSVG-8B".to_string(),
        "local-svg:VFIG-4B".to_string(),
    ];
    model_ids.extend(provider_local_diffusers::runnable_model_ids(
        paths,
        local_diffusers,
    )?);
    Ok(model_ids)
}

fn direct_reference_image_model_ids() -> Vec<String> {
    vec![
        "openai:gpt-image-2".to_string(),
        "quiver:arrow-1.1-max".to_string(),
        "quiver:arrow-1.1".to_string(),
        "recraft:recraftv4_1_pro_vector".to_string(),
        "recraft:recraftv4_1_vector".to_string(),
        "local-svg:IntroSVG-Qwen2.5-VL-7B".to_string(),
        "local-svg:InternSVG-8B".to_string(),
        "local-svg:VFIG-4B".to_string(),
    ]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelLicense {
    name: String,
    spdx_id: Option<String>,
    source_url: String,
    commercial_use: String,
    requires_acceptance: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaProviderCatalogEntry {
    id: String,
    display_name: String,
    target: String,
    configured: bool,
    lifecycle: String,
    capabilities: Vec<String>,
    privacy_summary: String,
    checked_at: String,
    stale_after_seconds: u64,
    source_url: Option<String>,
    catalog_revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelDescriptor {
    id: String,
    provider_id: String,
    display_name: String,
    family: String,
    target: String,
    lifecycle: String,
    lifecycle_checked_at: String,
    lifecycle_stale_after_seconds: u64,
    lifecycle_source_url: Option<String>,
    catalog_revision: String,
    capabilities: Vec<String>,
    configured: bool,
    installed: bool,
    bundled: bool,
    installation_status: String,
    installed_revision: Option<String>,
    package_type: String,
    architecture: Option<String>,
    addon_capabilities: Vec<MediaModelAddonCapability>,
    runtime_readiness: String,
    runtime_readiness_diagnostic: Option<String>,
    runtime_readiness_checked_at: Option<String>,
    license: MediaModelLicense,
    recommended: bool,
    speed_score: u32,
    quality_score: u32,
    min_vram_gb: Option<f64>,
    expected_download_gb: Option<f64>,
    cost_hint: Option<String>,
    privacy_summary: String,
    limitation: Option<String>,
    user_imported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelAddonCapability {
    kind: String,
    target_components: Vec<String>,
    max_active: u32,
    supports_separate_component_strengths: bool,
    supports_denoising_schedules: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaEmbeddingVectorProfile {
    component: String,
    tensor_key: String,
    vector_count: u32,
    dimension: u32,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaLoraTensorProfile {
    algorithm: String,
    dialect: String,
    rank_minimum: u32,
    rank_maximum: u32,
    heterogeneous_ranks: bool,
    target_module_count: u32,
    convolution_target_count: u32,
    magnitude_vector_count: u32,
    network_alpha_count: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaLoraDenoisingSchedule {
    start: f64,
    end: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelAddonDescriptor {
    id: String,
    kind: String,
    display_name: String,
    architecture: String,
    architecture_confidence: String,
    format: String,
    target_components: Vec<String>,
    embedding_vectors: Vec<MediaEmbeddingVectorProfile>,
    lora_profile: Option<MediaLoraTensorProfile>,
    base_model_hint: Option<String>,
    trigger_words: Vec<String>,
    default_token: Option<String>,
    digest: String,
    header_digest: String,
    byte_size: u64,
    relative_path: String,
    source_url: Option<String>,
    source_metadata: Option<serde_json::Value>,
    license: MediaModelLicense,
    imported_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelCatalogSnapshot {
    schema_version: u32,
    catalog_revision: String,
    observed_at: String,
    providers: Vec<MediaProviderCatalogEntry>,
    models: Vec<MediaModelDescriptor>,
    addons: Vec<MediaModelAddonDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaLocalModelImportInspection {
    schema_version: u32,
    can_import: bool,
    blocking_reason: Option<String>,
    source_path: String,
    source_file_name: String,
    byte_size: u64,
    tensor_count: u32,
    header_digest: String,
    review_token: String,
    suggested_display_name: String,
    detected_architecture: Option<String>,
    architecture_confidence: String,
    metadata_summary: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportMediaLocalModelRequest {
    source_path: String,
    review_token: String,
    display_name: String,
    architecture: String,
    source_url: Option<String>,
    license_name: String,
    commercial_use: String,
    confirm_rights: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaLocalModelImportResult {
    schema_version: u32,
    model_id: String,
    display_name: String,
    family: String,
    revision: String,
    digest: String,
    byte_size: u64,
    target_label: String,
    imported_at: String,
    already_installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelAddonImportInspection {
    schema_version: u32,
    can_import: bool,
    blocking_reason: Option<String>,
    source_path: String,
    source_file_name: String,
    byte_size: u64,
    tensor_count: u32,
    header_digest: String,
    review_token: String,
    suggested_display_name: String,
    detected_kind: Option<String>,
    detected_architecture: Option<String>,
    architecture_confidence: String,
    target_components: Vec<String>,
    embedding_vectors: Vec<MediaEmbeddingVectorProfile>,
    lora_profile: Option<MediaLoraTensorProfile>,
    base_model_hint: Option<String>,
    suggested_trigger_words: Vec<String>,
    suggested_token: Option<String>,
    metadata_summary: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportMediaModelAddonRequest {
    source_path: String,
    review_token: String,
    display_name: String,
    kind: String,
    architecture: String,
    trigger_words: Vec<String>,
    token: Option<String>,
    source_url: Option<String>,
    license_name: String,
    commercial_use: String,
    confirm_rights: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelAddonImportResult {
    schema_version: u32,
    addon_id: String,
    kind: String,
    display_name: String,
    architecture: String,
    digest: String,
    byte_size: u64,
    target_label: String,
    imported_at: String,
    already_installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelAddonRemovalPlan {
    schema_version: u32,
    addon_id: String,
    display_name: String,
    kind: String,
    digest: String,
    installed_bytes: u64,
    target_label: String,
    confirmation_token: String,
    can_remove: bool,
    blocking_run_count: u32,
    blocking_run_ids: Vec<String>,
    saved_flow_count: u32,
    saved_flow_ids: Vec<String>,
    historical_run_count: u32,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoveMediaModelAddonRequest {
    addon_id: String,
    confirmation_token: String,
    confirm_removal: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelAddonRemovalResult {
    schema_version: u32,
    addon_id: String,
    digest: String,
    removed_at: String,
    reclaimed_bytes: u64,
    cleanup_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelInstallManifestFile {
    path: String,
    byte_size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelInstallPlan {
    schema_version: u32,
    model_id: String,
    display_name: String,
    revision: String,
    manifest_digest: String,
    license_digest: String,
    review_token: String,
    source_url: String,
    target_label: String,
    files: Vec<MediaModelInstallManifestFile>,
    excluded_paths: Vec<String>,
    total_bytes: u64,
    required_working_bytes: u64,
    available_bytes: Option<u64>,
    has_sufficient_space: Option<bool>,
    already_installed: bool,
    license: MediaModelLicense,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartMediaModelInstallRequest {
    model_id: String,
    review_token: String,
    manifest_digest: String,
    license_digest: String,
    accept_license: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelInstallJob {
    id: String,
    model_id: String,
    revision: String,
    status: String,
    manifest_digest: String,
    files_total: u32,
    files_completed: u32,
    bytes_total: u64,
    bytes_downloaded: u64,
    progress: f64,
    current_file: Option<String>,
    error: Option<String>,
    failure: Option<MediaError>,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelRemovalPlan {
    schema_version: u32,
    model_id: String,
    display_name: String,
    revision: String,
    installed_bytes: u64,
    target_label: String,
    confirmation_token: String,
    can_remove: bool,
    blocking_job_id: Option<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveMediaModelRequest {
    model_id: String,
    confirmation_token: String,
    confirm_removal: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaModelRemovalResult {
    model_id: String,
    revision: String,
    removed_at: String,
    reclaimed_bytes: u64,
    cleanup_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRunRecord {
    id: String,
    flow_id: String,
    flow_revision_id: Option<String>,
    flow_name: String,
    plan_id: String,
    status: String,
    created_at: String,
    updated_at: String,
    prompt: String,
    model_label: String,
    target: Option<String>,
    output_count: u32,
    diagnostic_count: u32,
    progress: f64,
    current_step: String,
    executor: String,
    error: Option<String>,
    failure: Option<MediaError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRunEvent {
    id: i64,
    run_id: String,
    sequence: u32,
    kind: String,
    created_at: String,
    message: String,
    progress: Option<f64>,
    step_id: Option<String>,
    node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaNodeExecutionRecord {
    run_id: String,
    node_id: String,
    node_type: String,
    node_label: String,
    ordinal: u32,
    status: String,
    active_step_id: Option<String>,
    runtime_phase: Option<String>,
    attempt: u32,
    progress: Option<f64>,
    message: Option<String>,
    started_at: Option<String>,
    updated_at: String,
    finished_at: Option<String>,
    state_sequence: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetRecord {
    id: String,
    run_id: String,
    digest: String,
    kind: String,
    mime_type: String,
    byte_size: u64,
    width: u32,
    height: u32,
    created_at: String,
    output_index: u32,
    fixture: bool,
    operation: Option<serde_json::Value>,
    source_asset_ids: Vec<String>,
    tags: Vec<MediaAssetTag>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetTag {
    value: String,
    label: String,
    source: String,
    confidence: Option<f64>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetDeletionImpact {
    asset_id: String,
    digest: String,
    dependent_asset_ids: Vec<String>,
    shared_blob_asset_ids: Vec<String>,
    export_count: u32,
    active_export_count: u32,
    rendition_count: u32,
    original_byte_size: u64,
    rendition_byte_size: u64,
    reclaimable_byte_size: u64,
    retained_shared_byte_size: u64,
    warnings: Vec<String>,
    confirmation_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetDeletionRequest {
    asset_id: String,
    mode: String,
    confirmation_token: String,
    confirm_dependencies: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetTombstone {
    asset_id: String,
    digest: String,
    kind: String,
    mime_type: String,
    deleted_at: String,
    mode: String,
    bytes_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetDeletionResult {
    tombstone: MediaAssetTombstone,
    reclaimed_bytes: u64,
    retained_bytes: u64,
    failed_blob_digests: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRunDetail {
    #[serde(flatten)]
    run: MediaRunRecord,
    events: Vec<MediaRunEvent>,
    assets: Vec<MediaAssetRecord>,
    provider_jobs: Vec<MediaProviderJobRecord>,
    human_reviews: Vec<MediaHumanReviewRecord>,
    node_executions: Vec<MediaNodeExecutionRecord>,
    plan_snapshot: Option<MediaRunPlanSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaImageImportResult {
    detail: MediaRunDetail,
    asset: MediaAssetRecord,
    deduplicated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RalphMediaRunDetail {
    id: String,
    status: String,
    current_step: String,
    error: Option<String>,
    assets: Vec<RalphMediaRunAsset>,
    human_reviews: Vec<RalphMediaRunHumanReview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RalphMediaRunAsset {
    id: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RalphMediaRunHumanReview {
    status: String,
    selected_asset_ids: Vec<String>,
}

impl From<MediaRunDetail> for RalphMediaRunDetail {
    fn from(detail: MediaRunDetail) -> Self {
        Self {
            id: detail.run.id,
            status: detail.run.status,
            current_step: detail.run.current_step,
            error: detail.run.error,
            assets: detail
                .assets
                .into_iter()
                .map(|asset| RalphMediaRunAsset {
                    id: asset.id,
                    kind: asset.kind,
                })
                .collect(),
            human_reviews: detail
                .human_reviews
                .into_iter()
                .map(|review| RalphMediaRunHumanReview {
                    status: review.status,
                    selected_asset_ids: review.selected_asset_ids,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaHumanReviewRecord {
    id: String,
    run_id: String,
    node_id: String,
    sequence: u32,
    status: String,
    instructions: String,
    max_selections: u32,
    require_comment: bool,
    candidate_asset_ids: Vec<String>,
    selected_asset_ids: Vec<String>,
    decision_id: Option<String>,
    decision_action: Option<String>,
    comment: Option<String>,
    actor: Option<String>,
    created_at: String,
    updated_at: String,
    decided_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaRunPlanNodeSnapshot {
    id: String,
    r#type: String,
    label: String,
    layer: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaRunPlanStepSnapshot {
    id: String,
    source_node_id: String,
    kind: String,
    label: String,
    target: String,
    cacheable: bool,
    side_effect: Option<String>,
    review: Option<MediaHumanReviewContract>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaHumanReviewContract {
    instructions: String,
    max_selections: u32,
    require_comment: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaRunPlanSnapshot {
    schema_version: u32,
    plan_id: String,
    flow_id: String,
    flow_fingerprint: String,
    compiled_at: String,
    nodes: Vec<MediaRunPlanNodeSnapshot>,
    steps: Vec<MediaRunPlanStepSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaProviderPolicySnapshot {
    adapter_id: String,
    adapter_version: String,
    endpoint_version: String,
    region: String,
    idempotency_mode: String,
    retry_policy: String,
    cancellation_semantics: String,
    input_retention_seconds: Option<u64>,
    output_retention_seconds: Option<u64>,
    output_visibility: String,
    public_links: bool,
    no_store_requested: bool,
    upload_asset_count: u32,
    upload_bytes: u64,
    contains_personal_data: bool,
    remote_upload_allowed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaProviderJobRecord {
    id: String,
    run_id: String,
    attempt: u32,
    status: String,
    raw_state: Option<String>,
    scenario: String,
    request_digest: String,
    idempotency_key: Option<String>,
    provider_job_id: Option<String>,
    provider_request_id: Option<String>,
    estimated_cost_min: f64,
    estimated_cost_max: f64,
    currency: String,
    poll_attempts: u32,
    next_poll_at: Option<String>,
    reconciliation_deadline: String,
    accepted_at: Option<String>,
    retention_expires_at: Option<String>,
    late_success: bool,
    review_required: bool,
    review_reason: Option<String>,
    error: Option<String>,
    failure: Option<MediaError>,
    policy: MediaProviderPolicySnapshot,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaAssetExportMode {
    VerifiedOriginal,
    MetadataStripped,
}

impl MediaAssetExportMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::VerifiedOriginal => "verified-original",
            Self::MetadataStripped => "metadata-stripped",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaAssetExportRequest {
    asset_id: String,
    destination_path: String,
    mode: MediaAssetExportMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetExportRecord {
    id: String,
    asset_id: String,
    destination_path: String,
    mode: MediaAssetExportMode,
    source_digest: String,
    digest: String,
    byte_size: u64,
    metadata_stripped: bool,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaQualityProfileReference {
    id: String,
    version: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaQualityEvaluatorReference {
    id: String,
    version: String,
    digest: Option<String>,
    license: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaQualityObservation {
    metric_id: String,
    metric_version: String,
    family: String,
    scope: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direction: Option<String>,
    input_asset_ids: Vec<String>,
    reference_asset_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evaluator: Option<MediaQualityEvaluatorReference>,
    preprocessing_profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sampling_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    calibration_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
    limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaQualityReport {
    schema_version: u32,
    source_asset_id: String,
    analyzed_at: String,
    profile: MediaQualityProfileReference,
    verdict: String,
    gate_reasons: Vec<String>,
    observations: Vec<MediaQualityObservation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaQualityAnalysisResult {
    detail: MediaRunDetail,
    report: MediaQualityReport,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnqueueFixtureRunRequest {
    run_id: String,
    flow_id: String,
    flow_revision_id: Option<String>,
    flow_name: String,
    plan_id: String,
    prompt: String,
    model_label: String,
    target: Option<String>,
    output_count: u32,
    diagnostic_count: u32,
    aspect_ratio: String,
    plan_snapshot: Option<MediaRunPlanSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnqueueMockRemoteRunRequest {
    run_id: String,
    flow_id: String,
    flow_revision_id: Option<String>,
    flow_name: String,
    plan_id: String,
    prompt: String,
    model_label: String,
    target: Option<String>,
    output_count: u32,
    diagnostic_count: u32,
    aspect_ratio: String,
    scenario: String,
    allow_remote_upload: bool,
    plan_snapshot: Option<MediaRunPlanSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerateMediaImagesRequest {
    schema_version: u32,
    run_id: String,
    flow_id: String,
    flow_revision_id: String,
    flow_name: String,
    plan_id: String,
    prompt: String,
    model_id: String,
    model_label: String,
    output_count: u32,
    diagnostic_count: u32,
    aspect_ratio: String,
    output_format: String,
    model_policy: String,
    #[serde(default)]
    model_addons: Vec<MediaModelAddonSelection>,
    transparent_background: bool,
    #[serde(default)]
    subject_cutout_model_priority: Vec<String>,
    plan_snapshot: MediaRunPlanSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum MediaModelAddonSelection {
    #[serde(rename = "lora")]
    Lora {
        addon_id: String,
        enabled: bool,
        model_strength: f64,
        text_encoder_strength: Option<f64>,
        #[serde(default)]
        denoising_schedule: Option<MediaLoraDenoisingSchedule>,
    },
    #[serde(rename = "textual-inversion")]
    TextualInversion {
        addon_id: String,
        enabled: bool,
        token: String,
        placement: String,
    },
}

impl MediaModelAddonSelection {
    fn validate(&mut self) -> MediaResult<()> {
        match self {
            Self::Lora {
                addon_id,
                model_strength,
                text_encoder_strength,
                denoising_schedule,
                ..
            } => {
                *addon_id = required_text("modelAddons[].addonId", addon_id, 256)?;
                if !model_strength.is_finite() || !(-100.0..=100.0).contains(model_strength) {
                    return Err(
                        "modelAddons[].modelStrength must be between -100 and 100".to_string()
                    );
                }
                if text_encoder_strength.is_some_and(|strength| {
                    !strength.is_finite() || !(-100.0..=100.0).contains(&strength)
                }) {
                    return Err(
                        "modelAddons[].textEncoderStrength must be null or between -100 and 100"
                            .to_string(),
                    );
                }
                if denoising_schedule.as_ref().is_some_and(|schedule| {
                    !schedule.start.is_finite()
                        || !schedule.end.is_finite()
                        || schedule.start < 0.0
                        || schedule.start >= schedule.end
                        || schedule.end > 1.0
                }) {
                    return Err(
                        "modelAddons[].denoisingSchedule must satisfy 0 <= start < end <= 1"
                            .to_string(),
                    );
                }
            }
            Self::TextualInversion {
                addon_id,
                token,
                placement,
                ..
            } => {
                *addon_id = required_text("modelAddons[].addonId", addon_id, 256)?;
                *token = required_text("modelAddons[].token", token, 128)?;
                if token.chars().any(char::is_whitespace) {
                    return Err("modelAddons[].token must be a single token alias".to_string());
                }
                if !matches!(placement.as_str(), "positive" | "negative" | "both") {
                    return Err(
                        "modelAddons[].placement must be positive, negative, or both".to_string(),
                    );
                }
            }
        }
        Ok(())
    }

    pub(crate) fn addon_id(&self) -> &str {
        match self {
            Self::Lora { addon_id, .. } | Self::TextualInversion { addon_id, .. } => addon_id,
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        match self {
            Self::Lora { enabled, .. } | Self::TextualInversion { enabled, .. } => *enabled,
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Lora { .. } => "lora",
            Self::TextualInversion { .. } => "textual-inversion",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerateMediaSvgRequest {
    schema_version: u32,
    run_id: String,
    flow_id: String,
    flow_revision_id: String,
    flow_name: String,
    plan_id: String,
    prompt: String,
    model_id: String,
    model_label: String,
    output_count: u32,
    candidate_count: u32,
    diagnostic_count: u32,
    aspect_ratio: String,
    model_policy: String,
    transparent_background: bool,
    mode: String,
    auto_crop: bool,
    target_size: u32,
    style: String,
    text_policy: String,
    critic_enabled: bool,
    #[serde(default)]
    reference_images: Vec<MediaSvgReferenceInput>,
    #[serde(default)]
    allow_remote_upload: bool,
    plan_snapshot: MediaRunPlanSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaSvgReferenceInput {
    asset_id: String,
    role: String,
    influence: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveProviderReviewRequest {
    provider_job_id: String,
    action: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaHumanReviewDecisionRequest {
    review_id: String,
    decision_id: String,
    action: String,
    selected_asset_ids: Vec<String>,
    comment: String,
}

impl MediaHumanReviewDecisionRequest {
    fn validate(&mut self) -> MediaResult<()> {
        self.review_id = required_text("reviewId", &self.review_id, 512)?;
        self.decision_id = required_text("decisionId", &self.decision_id, 128)?;
        self.action = required_text("action", &self.action, 32)?;
        if !matches!(self.action.as_str(), "approve" | "reject") {
            return Err("action must be approve or reject".to_string());
        }
        if self.selected_asset_ids.len() > 8 {
            return Err("selectedAssetIds cannot contain more than 8 assets".to_string());
        }
        let mut unique_ids = HashSet::new();
        for asset_id in &mut self.selected_asset_ids {
            *asset_id = required_text("selectedAssetIds[]", asset_id, 256)?;
            if !unique_ids.insert(asset_id.clone()) {
                return Err("selectedAssetIds must be unique".to_string());
            }
        }
        self.comment = self.comment.trim().to_string();
        if self.comment.chars().count() > 2_000 {
            return Err("comment exceeds 2000 characters".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum MediaImageTransformOperation {
    Crop {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Resize {
        width: u32,
        height: u32,
        fit: String,
    },
    Convert,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaImageTransformRequest {
    source_asset_id: String,
    operation: MediaImageTransformOperation,
    output_format: String,
    quality: Option<u8>,
    jpeg_background: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecuteLocalImageFlowRequest {
    schema_version: u32,
    run_id: String,
    flow_id: String,
    flow_revision_id: String,
    plan_id: String,
    plan_snapshot: MediaRunPlanSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecuteRemoteImageEditFlowRequest {
    schema_version: u32,
    run_id: String,
    flow_id: String,
    flow_revision_id: String,
    plan_id: String,
    plan_snapshot: MediaRunPlanSnapshot,
    allow_remote_upload: bool,
}

impl ExecuteLocalImageFlowRequest {
    fn validate(&mut self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("local image flow execution requires schemaVersion 1".to_string());
        }
        self.run_id = required_text("runId", &self.run_id, 128)?;
        self.flow_id = required_text("flowId", &self.flow_id, 128)?;
        self.flow_revision_id = required_text("flowRevisionId", &self.flow_revision_id, 128)?;
        self.plan_id = required_text("planId", &self.plan_id, 128)?;
        self.plan_snapshot.validate(&self.plan_id, &self.flow_id)
    }
}

impl ExecuteRemoteImageEditFlowRequest {
    fn validate(&mut self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("remote image edit execution requires schemaVersion 1".to_string());
        }
        self.run_id = required_text("runId", &self.run_id, 128)?;
        self.flow_id = required_text("flowId", &self.flow_id, 128)?;
        self.flow_revision_id = required_text("flowRevisionId", &self.flow_revision_id, 128)?;
        self.plan_id = required_text("planId", &self.plan_id, 128)?;
        if !self.allow_remote_upload {
            return Err(
                "remote image edit execution requires explicit allowRemoteUpload confirmation"
                    .to_string(),
            );
        }
        self.plan_snapshot.validate(&self.plan_id, &self.flow_id)
    }
}

impl EnqueueFixtureRunRequest {
    fn validate(&mut self) -> MediaResult<()> {
        self.run_id = required_text("runId", &self.run_id, 128)?;
        self.flow_id = required_text("flowId", &self.flow_id, 128)?;
        if let Some(flow_revision_id) = &self.flow_revision_id {
            self.flow_revision_id = Some(required_text("flowRevisionId", flow_revision_id, 128)?);
        }
        self.flow_name = required_text("flowName", &self.flow_name, 256)?;
        self.plan_id = required_text("planId", &self.plan_id, 128)?;
        self.prompt = required_text("prompt", &self.prompt, 8_000)?;
        self.model_label = required_text("modelLabel", &self.model_label, 256)?;

        if !(1..=8).contains(&self.output_count) {
            return Err("outputCount must be between 1 and 8".to_string());
        }
        if !matches!(self.aspect_ratio.as_str(), "1:1" | "4:5" | "16:9" | "9:16") {
            return Err("aspectRatio is not supported by the fixture executor".to_string());
        }
        if !matches!(
            self.target.as_deref(),
            None | Some("local") | Some("remote")
        ) {
            return Err("target must be local, remote, or null".to_string());
        }
        if let Some(snapshot) = &mut self.plan_snapshot {
            snapshot.validate(&self.plan_id, &self.flow_id)?;
        }

        Ok(())
    }
}

impl EnqueueMockRemoteRunRequest {
    fn validate(&mut self) -> MediaResult<()> {
        self.run_id = required_text("runId", &self.run_id, 128)?;
        self.flow_id = required_text("flowId", &self.flow_id, 128)?;
        if let Some(flow_revision_id) = &self.flow_revision_id {
            self.flow_revision_id = Some(required_text("flowRevisionId", flow_revision_id, 128)?);
        }
        self.flow_name = required_text("flowName", &self.flow_name, 256)?;
        self.plan_id = required_text("planId", &self.plan_id, 128)?;
        self.prompt = required_text("prompt", &self.prompt, 8_000)?;
        self.model_label = required_text("modelLabel", &self.model_label, 256)?;
        if !(1..=8).contains(&self.output_count) {
            return Err("outputCount must be between 1 and 8".to_string());
        }
        if !matches!(self.aspect_ratio.as_str(), "1:1" | "4:5" | "16:9" | "9:16") {
            return Err("aspectRatio is not supported by the mock provider".to_string());
        }
        if !matches!(
            self.scenario.as_str(),
            "success"
                | "acceptance-unknown"
                | "crash-before-submit"
                | "crash-during-submit"
                | "crash-after-acceptance"
                | "crash-during-poll"
                | "crash-after-success"
                | "crash-during-download"
                | "cancel-race-success"
                | "provider-failure"
                | "result-expired"
        ) {
            return Err("scenario is not supported by the mock provider".to_string());
        }
        if self.target.as_deref() != Some("remote") {
            return Err("mock provider runs require target remote".to_string());
        }
        if let Some(snapshot) = &mut self.plan_snapshot {
            snapshot.validate(&self.plan_id, &self.flow_id)?;
        }
        Ok(())
    }
}

impl GenerateMediaImagesRequest {
    fn validate(&mut self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("direct image generation requires schemaVersion 1".to_string());
        }
        self.run_id = required_text("runId", &self.run_id, 128)?;
        self.flow_id = required_text("flowId", &self.flow_id, 128)?;
        self.flow_revision_id = required_text("flowRevisionId", &self.flow_revision_id, 128)?;
        self.flow_name = required_text("flowName", &self.flow_name, 256)?;
        self.plan_id = required_text("planId", &self.plan_id, 128)?;
        self.prompt = required_text("prompt", &self.prompt, 8_000)?;
        self.model_id = required_text("modelId", &self.model_id, 128)?;
        self.model_label = required_text("modelLabel", &self.model_label, 256)?;
        if self.model_addons.len() > 24 {
            return Err("modelAddons cannot contain more than 24 entries".to_string());
        }
        let mut addon_ids = HashSet::new();
        for addon in &mut self.model_addons {
            addon.validate()?;
            if !addon_ids.insert(addon.addon_id().to_string()) {
                return Err("modelAddons must contain unique add-on identifiers".to_string());
            }
        }
        if self.model_id == "openai:gpt-image-2" && !self.model_addons.is_empty() {
            return Err(
                "GPT Image 2 does not accept LoRA adapters or textual-inversion embeddings"
                    .to_string(),
            );
        }
        if self.model_id != "openai:gpt-image-2" && !self.model_id.starts_with("local:") {
            return Err("selected model is not an executable raster image generator".to_string());
        }
        if !(1..=8).contains(&self.output_count) {
            return Err("outputCount must be between 1 and 8".to_string());
        }
        if self.diagnostic_count > 128 {
            return Err("diagnosticCount cannot exceed 128".to_string());
        }
        if !matches!(self.aspect_ratio.as_str(), "1:1" | "4:5" | "16:9" | "9:16") {
            return Err("aspectRatio is not supported by direct image generation".to_string());
        }
        if !matches!(self.output_format.as_str(), "png" | "jpeg" | "webp") {
            return Err("outputFormat must be png, jpeg, or webp".to_string());
        }
        if self.transparent_background && self.output_format == "jpeg" {
            return Err(
                "transparentBackground requires PNG or WebP output because JPEG has no alpha channel"
                    .to_string(),
            );
        }
        if self.transparent_background {
            if self.subject_cutout_model_priority.is_empty() {
                self.subject_cutout_model_priority
                    .push(subject_cutout::BIREFNET_MODEL_ID.to_string());
            }
            subject_cutout::validate_model_priority(&mut self.subject_cutout_model_priority)?;
        } else if !self.subject_cutout_model_priority.is_empty() {
            return Err(
                "subjectCutoutModelPriority requires transparentBackground to be enabled"
                    .to_string(),
            );
        }
        if !matches!(self.model_policy.as_str(), "balanced" | "fast" | "quality") {
            return Err("modelPolicy must be balanced, fast, or quality".to_string());
        }
        self.plan_snapshot.validate(&self.plan_id, &self.flow_id)
    }
}

impl GenerateMediaSvgRequest {
    fn validate(&mut self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("direct SVG generation requires schemaVersion 1".to_string());
        }
        self.run_id = required_text("runId", &self.run_id, 128)?;
        self.flow_id = required_text("flowId", &self.flow_id, 128)?;
        self.flow_revision_id = required_text("flowRevisionId", &self.flow_revision_id, 128)?;
        self.flow_name = required_text("flowName", &self.flow_name, 256)?;
        self.plan_id = required_text("planId", &self.plan_id, 128)?;
        self.mode = required_text("mode", &self.mode, 32)?;
        if !matches!(self.mode.as_str(), "generate" | "vectorize") {
            return Err("mode must be generate or vectorize".to_string());
        }
        self.prompt = if self.mode == "vectorize" {
            let prompt = self.prompt.trim();
            if prompt.chars().count() > 8_000 {
                return Err("prompt exceeds 8000 characters".to_string());
            }
            prompt.to_string()
        } else {
            required_text("prompt", &self.prompt, 8_000)?
        };
        self.model_id = required_text("modelId", &self.model_id, 128)?;
        self.model_label = required_text("modelLabel", &self.model_label, 256)?;
        if !matches!(
            self.model_id.as_str(),
            "quiver:arrow-1.1-max"
                | "quiver:arrow-1.1"
                | "recraft:recraftv4_1_pro_vector"
                | "recraft:recraftv4_1_vector"
                | "local-svg:IntroSVG-Qwen2.5-VL-7B"
                | "local-svg:InternSVG-8B"
                | "local-svg:VFIG-4B"
        ) {
            return Err("selected model is not an executable SVG generator".to_string());
        }
        if !(1..=8).contains(&self.output_count) {
            return Err("outputCount must be between 1 and 8".to_string());
        }
        if self.candidate_count < self.output_count || self.candidate_count > 16 {
            return Err("candidateCount must be between outputCount and 16".to_string());
        }
        if self.model_id.starts_with("recraft:") && self.candidate_count > 6 {
            return Err("Recraft SVG generation supports at most 6 candidates".to_string());
        }
        if self.mode == "vectorize" && (self.output_count != 1 || self.candidate_count != 1) {
            return Err(
                "SVG vectorization requires outputCount and candidateCount to equal 1".to_string(),
            );
        }
        if !(128..=4_096).contains(&self.target_size) {
            return Err("targetSize must be between 128 and 4096".to_string());
        }
        if self.diagnostic_count > 128 {
            return Err("diagnosticCount cannot exceed 128".to_string());
        }
        if !matches!(self.aspect_ratio.as_str(), "1:1" | "4:5" | "16:9" | "9:16") {
            return Err("aspectRatio is not supported by direct SVG generation".to_string());
        }
        if !matches!(self.model_policy.as_str(), "balanced" | "fast" | "quality") {
            return Err("modelPolicy must be balanced, fast, or quality".to_string());
        }
        if self.critic_enabled
            && (self.mode != "generate"
                || self.model_policy != "quality"
                || self.model_id.starts_with("local-svg:"))
        {
            return Err(
                "OpenAI SVG render-feedback repair requires remote SVG generation with the quality model policy"
                    .to_string(),
            );
        }
        if !matches!(
            self.style.as_str(),
            "illustration" | "icon" | "logo" | "diagram" | "technical"
        ) {
            return Err("style is not a supported SVG design lane".to_string());
        }
        if !matches!(self.text_policy.as_str(), "avoid" | "editable" | "outlines") {
            return Err("textPolicy must be avoid, editable, or outlines".to_string());
        }
        if self.reference_images.len() > 8 {
            return Err("referenceImages cannot contain more than 8 assets".to_string());
        }
        if self.mode == "generate"
            && self.model_id.starts_with("recraft:")
            && !self.reference_images.is_empty()
        {
            return Err(
                "Recraft V4.1 prompt-to-vector models do not accept guided reference images"
                    .to_string(),
            );
        }
        if self.model_id == "quiver:arrow-1.1" && self.reference_images.len() > 4 {
            return Err("Quiver Arrow 1.1 accepts at most 4 reference images".to_string());
        }
        if self.mode == "vectorize" && self.reference_images.len() != 1 {
            return Err("SVG vectorization requires exactly one reference image".to_string());
        }
        if !self.reference_images.is_empty()
            && !self.model_id.starts_with("local-svg:")
            && !self.allow_remote_upload
        {
            return Err(
                "allowRemoteUpload must be true before reference pixels can leave this device"
                    .to_string(),
            );
        }
        let mut asset_ids = HashSet::new();
        let mut base_count = 0_usize;
        for reference in &mut self.reference_images {
            reference.asset_id =
                required_text("referenceImages[].assetId", &reference.asset_id, 256)?;
            reference.role = required_text("referenceImages[].role", &reference.role, 32)?;
            if !matches!(
                reference.role.as_str(),
                "base" | "subject" | "style" | "composition" | "palette" | "detail"
            ) {
                return Err("referenceImages[].role is unsupported".to_string());
            }
            if !reference.influence.is_finite() || !(0.0..=1.0).contains(&reference.influence) {
                return Err("referenceImages[].influence must be between 0 and 1".to_string());
            }
            if !asset_ids.insert(reference.asset_id.clone()) {
                return Err("referenceImages must contain unique asset ids".to_string());
            }
            if reference.role == "base" {
                base_count += 1;
            }
        }
        if base_count > 1 {
            return Err("referenceImages can contain at most one base image".to_string());
        }
        self.plan_snapshot.validate(&self.plan_id, &self.flow_id)?;
        let planned_reference_count = self
            .plan_snapshot
            .nodes
            .iter()
            .filter(|node| node.r#type == "source.image")
            .count();
        if planned_reference_count != self.reference_images.len() {
            return Err(
                "referenceImages must match the immutable source-image nodes in planSnapshot"
                    .to_string(),
            );
        }
        Ok(())
    }
}

impl MediaRunPlanSnapshot {
    fn validate(&mut self, expected_plan_id: &str, expected_flow_id: &str) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("planSnapshot.schemaVersion must be 1".to_string());
        }
        self.plan_id = required_text("planSnapshot.planId", &self.plan_id, 128)?;
        self.flow_id = required_text("planSnapshot.flowId", &self.flow_id, 128)?;
        self.flow_fingerprint =
            required_text("planSnapshot.flowFingerprint", &self.flow_fingerprint, 128)?;
        self.compiled_at = required_text("planSnapshot.compiledAt", &self.compiled_at, 64)?;
        chrono::DateTime::parse_from_rfc3339(&self.compiled_at)
            .map_err(|_| "planSnapshot.compiledAt must be RFC 3339".to_string())?;
        if self.plan_id != expected_plan_id || self.flow_id != expected_flow_id {
            return Err("planSnapshot identity does not match the enqueued run".to_string());
        }
        if self.nodes.is_empty() || self.nodes.len() > 64 {
            return Err("planSnapshot.nodes must contain between 1 and 64 entries".to_string());
        }
        if self.steps.is_empty() || self.steps.len() > 128 {
            return Err("planSnapshot.steps must contain between 1 and 128 entries".to_string());
        }

        let mut node_ids = HashSet::new();
        for node in &mut self.nodes {
            node.id = required_text("planSnapshot.node.id", &node.id, 128)?;
            node.label = required_text("planSnapshot.node.label", &node.label, 256)?;
            node.r#type = required_text("planSnapshot.node.type", &node.r#type, 64)?;
            node.layer = required_text("planSnapshot.node.layer", &node.layer, 32)?;
            if !matches!(
                node.r#type.as_str(),
                "source.prompt"
                    | "source.image"
                    | "task.generate-image"
                    | "task.edit-image"
                    | "operation.crop"
                    | "operation.resize"
                    | "operation.format-convert"
                    | "operation.metadata-strip"
                    | "operation.auto-tag"
                    | "operation.contact-sheet"
                    | "operation.subject-cutout"
                    | "operation.alpha-matte"
                    | "operation.quality-analyze"
                    | "control.quality-gate"
                    | "control.human-review"
                    | "output.asset"
            ) || !matches!(
                node.layer.as_str(),
                "source" | "task" | "operation" | "control" | "output" | "runtime"
            ) {
                return Err("planSnapshot contains an unsupported semantic node".to_string());
            }
            if !node_ids.insert(node.id.clone()) {
                return Err("planSnapshot contains duplicate node ids".to_string());
            }
        }

        let mut step_ids = HashSet::new();
        for step in &mut self.steps {
            step.id = required_text("planSnapshot.step.id", &step.id, 128)?;
            step.source_node_id =
                required_text("planSnapshot.step.sourceNodeId", &step.source_node_id, 128)?;
            step.kind = required_text("planSnapshot.step.kind", &step.kind, 64)?;
            step.label = required_text("planSnapshot.step.label", &step.label, 256)?;
            step.target = required_text("planSnapshot.step.target", &step.target, 32)?;
            if !node_ids.contains(&step.source_node_id)
                || !matches!(
                    step.kind.as_str(),
                    "normalize-prompt"
                        | "resolve-asset"
                        | "resolve-model"
                        | "generate-image"
                        | "generate-svg"
                        | "vectorize-svg"
                        | "validate-svg"
                        | "render-svg"
                        | "score-svg"
                        | "repair-svg"
                        | "edit-image"
                        | "crop-image"
                        | "resize-image"
                        | "convert-image"
                        | "strip-metadata"
                        | "auto-tag"
                        | "create-contact-sheet"
                        | "cutout-subject"
                        | "extract-alpha-matte"
                        | "analyze-quality"
                        | "evaluate-gate"
                        | "wait-for-review"
                        | "ingest-asset"
                )
                || !matches!(step.target.as_str(), "orchestrator" | "local" | "remote")
                || !matches!(
                    step.side_effect.as_deref(),
                    None | Some("paid-request" | "model-download" | "asset-write")
                )
            {
                return Err("planSnapshot contains an invalid expanded step".to_string());
            }
            match (&step.kind[..], &mut step.review) {
                ("wait-for-review", Some(review)) => {
                    review.instructions = required_text(
                        "planSnapshot.step.review.instructions",
                        &review.instructions,
                        1_000,
                    )?;
                    if !(1..=8).contains(&review.max_selections) {
                        return Err(
                            "planSnapshot.step.review.maxSelections must be between 1 and 8"
                                .to_string(),
                        );
                    }
                }
                ("wait-for-review", None) => {
                    return Err(
                        "planSnapshot wait-for-review step requires a review contract".to_string(),
                    );
                }
                (_, Some(_)) => {
                    return Err(
                        "planSnapshot review contract is only valid on wait-for-review steps"
                            .to_string(),
                    );
                }
                (_, None) => {}
            }
            if !step_ids.insert(step.id.clone()) {
                return Err("planSnapshot contains duplicate step ids".to_string());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod run_plan_contract_tests {
    use super::*;

    fn request(snapshot: MediaRunPlanSnapshot) -> EnqueueFixtureRunRequest {
        EnqueueFixtureRunRequest {
            run_id: "run:plan-contract".to_string(),
            flow_id: "flow:plan-contract".to_string(),
            flow_revision_id: None,
            flow_name: "Plan contract".to_string(),
            plan_id: "plan:contract".to_string(),
            prompt: "A validated plan snapshot".to_string(),
            model_label: "Fixture".to_string(),
            target: Some("local".to_string()),
            output_count: 1,
            diagnostic_count: 0,
            aspect_ratio: "1:1".to_string(),
            plan_snapshot: Some(snapshot),
        }
    }

    fn snapshot(source_node_id: &str) -> MediaRunPlanSnapshot {
        MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: "plan:contract".to_string(),
            flow_id: "flow:plan-contract".to_string(),
            flow_fingerprint: "sha256:contract".to_string(),
            compiled_at: "2026-07-14T00:00:00.000Z".to_string(),
            nodes: vec![MediaRunPlanNodeSnapshot {
                id: "node:prompt".to_string(),
                r#type: "source.prompt".to_string(),
                label: "Prompt".to_string(),
                layer: "source".to_string(),
            }],
            steps: vec![MediaRunPlanStepSnapshot {
                id: "step:normalize".to_string(),
                source_node_id: source_node_id.to_string(),
                kind: "normalize-prompt".to_string(),
                label: "Normalize prompt".to_string(),
                target: "orchestrator".to_string(),
                cacheable: true,
                side_effect: None,
                review: None,
            }],
        }
    }

    fn semantic_node(
        id: &str,
        node_type: &str,
        label: &str,
        layer: &str,
    ) -> MediaRunPlanNodeSnapshot {
        MediaRunPlanNodeSnapshot {
            id: id.to_string(),
            r#type: node_type.to_string(),
            label: label.to_string(),
            layer: layer.to_string(),
        }
    }

    fn local_step(id: &str, source_node_id: &str, kind: &str) -> MediaRunPlanStepSnapshot {
        MediaRunPlanStepSnapshot {
            id: id.to_string(),
            source_node_id: source_node_id.to_string(),
            kind: kind.to_string(),
            label: kind.to_string(),
            target: "local".to_string(),
            cacheable: true,
            side_effect: None,
            review: None,
        }
    }

    #[test]
    fn accepts_bounded_plan_snapshot_with_valid_node_lineage() {
        assert!(request(snapshot("node:prompt")).validate().is_ok());
    }

    #[test]
    fn accepts_local_alpha_matte_plan_snapshot() {
        let mut plan = snapshot("source");
        plan.nodes = vec![
            semantic_node("source", "source.image", "Source image", "source"),
            semantic_node(
                "alpha",
                "operation.alpha-matte",
                "Extract alpha matte",
                "operation",
            ),
            semantic_node(
                "tag",
                "operation.auto-tag",
                "Tag technical output",
                "operation",
            ),
            semantic_node("output", "output.asset", "Save alpha matte", "output"),
        ];
        plan.steps = vec![
            local_step("resolve-asset:source", "source", "resolve-asset"),
            local_step("extract-alpha-matte:alpha", "alpha", "extract-alpha-matte"),
            local_step("auto-tag:tag", "tag", "auto-tag"),
            local_step("ingest-asset:output", "output", "ingest-asset"),
        ];
        let mut execution_request = ExecuteLocalImageFlowRequest {
            schema_version: 1,
            run_id: "run:alpha-matte".to_string(),
            flow_id: plan.flow_id.clone(),
            flow_revision_id: "revision:alpha-matte".to_string(),
            plan_id: plan.plan_id.clone(),
            plan_snapshot: plan,
        };

        assert!(execution_request.validate().is_ok());
    }

    #[test]
    fn accepts_human_review_plan_step_with_semantic_lineage() {
        let mut plan = snapshot("node:prompt");
        plan.nodes.push(MediaRunPlanNodeSnapshot {
            id: "node:review".to_string(),
            r#type: "control.human-review".to_string(),
            label: "Human review".to_string(),
            layer: "control".to_string(),
        });
        plan.steps.push(MediaRunPlanStepSnapshot {
            id: "step:review".to_string(),
            source_node_id: "node:review".to_string(),
            kind: "wait-for-review".to_string(),
            label: "Pause for review".to_string(),
            target: "orchestrator".to_string(),
            cacheable: false,
            side_effect: None,
            review: Some(MediaHumanReviewContract {
                instructions: "Select the strongest candidate.".to_string(),
                max_selections: 1,
                require_comment: false,
            }),
        });
        assert!(request(plan).validate().is_ok());
    }

    #[test]
    fn rejects_plan_step_that_references_unknown_semantic_node() {
        assert_eq!(
            request(snapshot("node:missing")).validate().unwrap_err(),
            "planSnapshot contains an invalid expanded step"
        );
    }
}

fn required_text(field: &str, value: &str, max_chars: usize) -> MediaResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} is required"));
    }
    if value.chars().count() > max_chars {
        return Err(format!("{field} exceeds {max_chars} characters"));
    }
    Ok(value.to_string())
}

pub(crate) fn resolve_published_image_asset_path(
    app: &AppHandle,
    asset_id: &str,
) -> MediaResult<PathBuf> {
    let asset_id = required_text("assetId", asset_id, 256)?;
    let paths = MediaRuntimePaths::resolve(app)?;
    database::ensure_initialized(&paths)?;
    let source = database::get_published_image_blob_source(&paths, &asset_id)?;
    transform::resolve_verified_blob_path(&paths, &source)
}

fn validate_ralph_media_binding_authority(
    paths: &MediaRuntimePaths,
    workspace_root: &Path,
    binding: &RalphMediaResolvedInputBinding,
) -> MediaResult<()> {
    match binding.source.as_str() {
        "literal" => Ok(()),
        "path" => {
            let value = binding
                .value
                .as_str()
                .ok_or_else(|| "Ralph media path binding must be a string".to_string())?;
            let resolved = std::fs::canonicalize(value)
                .map_err(|error| format!("failed to resolve Ralph media path binding: {error}"))?;
            if !resolved.starts_with(workspace_root) {
                return Err("Ralph media path binding escapes the active workspace".to_string());
            }
            let metadata = std::fs::metadata(&resolved)
                .map_err(|error| format!("failed to inspect Ralph media path binding: {error}"))?;
            if !metadata.is_file() {
                return Err("Ralph media path binding must reference a regular file".to_string());
            }
            Ok(())
        }
        "media-asset" => {
            let asset_id = binding
                .value
                .as_str()
                .ok_or_else(|| "Ralph media asset binding must contain an asset id".to_string())?;
            database::get_published_image_blob_source(paths, asset_id).map(|_| ())
        }
        _ => Err("Ralph media input binding uses an unsupported source".to_string()),
    }
}

pub(crate) fn ensure_ralph_media_flow_run(
    app: AppHandle,
    workspace_root: &Path,
    mut request: RalphMediaFlowRunRequest,
) -> MediaResult<RalphMediaRunDetail> {
    request.run_id = required_text("runId", &request.run_id, 128)?;
    request.flow_id = required_text("flowId", &request.flow_id, 128)?;
    request.revision_id = required_text("revisionId", &request.revision_id, 128)?;
    request.approval_policy = required_text("approvalPolicy", &request.approval_policy, 64)?;
    if !matches!(
        request.approval_policy.as_str(),
        "inherit-workspace" | "always-review-preflight"
    ) {
        return Err("Ralph media approvalPolicy is unsupported".to_string());
    }
    if request.input_bindings.len() > 32 {
        return Err("Ralph media inputBindings is limited to 32 entries".to_string());
    }

    let workspace_root = std::fs::canonicalize(workspace_root)
        .map_err(|error| format!("failed to resolve Ralph media workspace: {error}"))?;
    if !workspace_root.is_dir() {
        return Err("Ralph media workspace must be a directory".to_string());
    }
    let paths = MediaRuntimePaths::resolve(&app)?;
    database::ensure_initialized(&paths)?;
    for binding in request.input_bindings.values() {
        validate_ralph_media_binding_authority(&paths, &workspace_root, binding)?;
    }

    let mut enqueue_request = flow::create_ralph_fixture_run_request(&paths, &request)?;
    enqueue_request.validate()?;
    database::enqueue_fixture_run(&paths, &enqueue_request)?;
    let detail = database::get_run_detail(&paths, &request.run_id)?;
    if detail.run.status == "queued" {
        spawn_fixture_worker(app, request.run_id.clone())?;
    }
    database::get_run_detail(&paths, &request.run_id).map(Into::into)
}

pub(crate) fn inspect_ralph_media_run(
    app: AppHandle,
    run_id: &str,
) -> MediaResult<RalphMediaRunDetail> {
    let paths = MediaRuntimePaths::resolve(&app)?;
    database::ensure_initialized(&paths)?;
    database::get_run_detail(&paths, &required_text("runId", run_id, 128)?).map(Into::into)
}

pub(crate) fn initialize_runtime(app: &AppHandle) -> MediaResult<MediaRuntimeStatus> {
    let paths = MediaRuntimePaths::resolve(app)?;
    let recovery = database::initialize(&paths)?;
    model_install::recover_removals(&paths)?;
    model_addon::recover_removals(&paths)?;
    let queued_run_ids = database::list_queued_run_ids(&paths)?;
    let provider_run_ids = provider_mock::recover_interrupted(&paths)?;
    let queued_model_install_ids = model_install::recover_interrupted(&paths)?;

    for run_id in &queued_run_ids {
        spawn_fixture_worker(app.clone(), run_id.clone())?;
    }
    for run_id in &provider_run_ids {
        spawn_provider_worker(app.clone(), run_id.clone())?;
    }
    for job_id in queued_model_install_ids {
        spawn_model_install_worker(app.clone(), job_id)?;
    }

    let local_diffusers = app.state::<MediaRuntimeState>().local_diffusers_status(app);
    let direct_generation_model_ids = direct_generation_model_ids(&paths, &local_diffusers)?;
    Ok(MediaRuntimeStatus {
        schema_version: database::SCHEMA_VERSION,
        recovered_runs: recovery.recovered_runs,
        queued_runs: (queued_run_ids.len() + provider_run_ids.len()) as u32,
        active_runs: app.state::<MediaRuntimeState>().active_count(),
        storage_ready: true,
        mode: "native",
        direct_generation_model_ids,
        direct_reference_image_model_ids: direct_reference_image_model_ids(),
        local_diffusers,
    })
}

fn spawn_provider_worker(app: AppHandle, run_id: String) -> MediaResult<()> {
    if !app.state::<MediaRuntimeState>().begin_run(&run_id)? {
        return Ok(());
    }

    let worker_app = app.clone();
    let worker_run_id = run_id.clone();
    std::thread::Builder::new()
        .name(format!(
            "media-provider-{}",
            &run_id.chars().take(24).collect::<String>()
        ))
        .spawn(move || {
            let result = MediaRuntimePaths::resolve(&worker_app)
                .and_then(|paths| provider_mock::execute(&paths, &worker_run_id));
            if let Err(error) = result {
                if let Ok(paths) = MediaRuntimePaths::resolve(&worker_app) {
                    let _ = database::fail_run(&paths, &worker_run_id, &error);
                }
            }
            worker_app
                .state::<MediaRuntimeState>()
                .finish_run(&worker_run_id);
        })
        .map_err(|error| {
            app.state::<MediaRuntimeState>().finish_run(&run_id);
            format!("failed to start Media Studio provider worker: {error}")
        })?;

    Ok(())
}

fn spawn_fixture_worker(app: AppHandle, run_id: String) -> MediaResult<()> {
    if !app.state::<MediaRuntimeState>().begin_run(&run_id)? {
        return Ok(());
    }

    let worker_app = app.clone();
    let worker_run_id = run_id.clone();
    std::thread::Builder::new()
        .name(format!(
            "media-fixture-{}",
            &run_id.chars().take(24).collect::<String>()
        ))
        .spawn(move || {
            let result = MediaRuntimePaths::resolve(&worker_app)
                .and_then(|paths| executor::execute_fixture_run(&paths, &worker_run_id));
            if let Err(error) = result {
                if let Ok(paths) = MediaRuntimePaths::resolve(&worker_app) {
                    let _ = database::fail_run(&paths, &worker_run_id, &error);
                }
            }
            worker_app
                .state::<MediaRuntimeState>()
                .finish_run(&worker_run_id);
        })
        .map_err(|error| {
            app.state::<MediaRuntimeState>().finish_run(&run_id);
            format!("failed to start Media Studio fixture worker: {error}")
        })?;

    Ok(())
}

fn spawn_model_install_worker(app: AppHandle, job_id: String) -> MediaResult<()> {
    if !app
        .state::<MediaRuntimeState>()
        .begin_model_install(&job_id)?
    {
        return Ok(());
    }

    let worker_app = app.clone();
    let worker_job_id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = match MediaRuntimePaths::resolve(&worker_app) {
            Ok(paths) => model_install::execute(&paths, &worker_job_id).await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            eprintln!("Media Studio model installation {worker_job_id} failed: {error}");
        }
        worker_app
            .state::<MediaRuntimeState>()
            .finish_model_install(&worker_job_id);
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn media_initialize_runtime(app: AppHandle) -> MediaCommandResult<MediaRuntimeStatus> {
    command_result(
        "media_initialize_runtime",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let queued_run_ids = database::list_queued_run_ids(&paths)?;
            for run_id in &queued_run_ids {
                spawn_fixture_worker(app.clone(), run_id.clone())?;
            }
            let provider_run_ids = provider_mock::list_resumable_run_ids(&paths)?;
            for run_id in &provider_run_ids {
                spawn_provider_worker(app.clone(), run_id.clone())?;
            }
            for job_id in model_install::list_queued_job_ids(&paths)? {
                spawn_model_install_worker(app.clone(), job_id)?;
            }
            let local_diffusers = app
                .state::<MediaRuntimeState>()
                .local_diffusers_status(&app);
            let direct_generation_model_ids =
                direct_generation_model_ids(&paths, &local_diffusers)?;
            Ok(MediaRuntimeStatus {
                schema_version: database::SCHEMA_VERSION,
                recovered_runs: 0,
                queued_runs: (queued_run_ids.len() + provider_run_ids.len()) as u32,
                active_runs: app.state::<MediaRuntimeState>().active_count(),
                storage_ready: true,
                mode: "native",
                direct_generation_model_ids,
                direct_reference_image_model_ids: direct_reference_image_model_ids(),
                local_diffusers,
            })
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_list_flows(app: AppHandle) -> MediaCommandResult<Vec<flow::MediaFlowHead>> {
    command_result(
        "media_list_flows",
        MediaRuntimePaths::resolve(&app).and_then(|paths| flow::list(&paths)),
    )
}

#[tauri::command]
pub(crate) fn media_get_flow(
    app: AppHandle,
    flow_id: String,
) -> MediaCommandResult<flow::MediaFlowHistory> {
    command_result(
        "media_get_flow",
        MediaRuntimePaths::resolve(&app).and_then(|paths| flow::get(&paths, &flow_id)),
    )
}

#[tauri::command]
pub(crate) fn media_save_flow_revision(
    app: AppHandle,
    request: flow::SaveMediaFlowRevisionRequest,
) -> MediaCommandResult<flow::SaveMediaFlowRevisionResult> {
    command_result(
        "media_save_flow_revision",
        MediaRuntimePaths::resolve(&app).and_then(|paths| flow::save(&paths, &request)),
    )
}

#[tauri::command]
pub(crate) async fn media_export_flow_revision(
    app: AppHandle,
    request: flow::ExportMediaFlowRevisionRequest,
) -> MediaCommandResult<flow::MediaFlowExportResult> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            tauri::async_runtime::spawn_blocking(move || flow::export_revision(&paths, &request))
                .await
                .map_err(|error| format!("flow export worker failed: {error}"))
                .and_then(|result| result)
        }
        Err(error) => Err(error),
    };
    command_result("media_export_flow_revision", result)
}

#[tauri::command]
pub(crate) async fn media_inspect_flow_import(
    app: AppHandle,
    request: flow::InspectMediaFlowImportRequest,
) -> MediaCommandResult<flow::MediaFlowImportInspection> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            tauri::async_runtime::spawn_blocking(move || flow::inspect_import(&paths, &request))
                .await
                .map_err(|error| format!("flow import inspection worker failed: {error}"))
                .and_then(|result| result)
        }
        Err(error) => Err(error),
    };
    command_result("media_inspect_flow_import", result)
}

#[tauri::command]
pub(crate) async fn media_import_flow(
    app: AppHandle,
    request: flow::ImportMediaFlowRequest,
) -> MediaCommandResult<flow::ImportMediaFlowResult> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            tauri::async_runtime::spawn_blocking(move || flow::import_reviewed(&paths, &request))
                .await
                .map_err(|error| format!("flow import worker failed: {error}"))
                .and_then(|result| result)
        }
        Err(error) => Err(error),
    };
    command_result("media_import_flow", result)
}

#[tauri::command]
pub(crate) async fn media_inspect_local_model(
    app: AppHandle,
    source_path: String,
) -> MediaCommandResult<MediaLocalModelImportInspection> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            if let Err(error) = database::ensure_initialized(&paths) {
                Err(error)
            } else {
                tauri::async_runtime::spawn_blocking(move || model_import::inspect(&source_path))
                    .await
                    .map_err(|error| format!("local model inspection worker failed: {error}"))
                    .and_then(|result| result)
            }
        }
        Err(error) => Err(error),
    };
    command_result("media_inspect_local_model", result)
}

#[tauri::command]
pub(crate) async fn media_import_local_model(
    app: AppHandle,
    request: ImportMediaLocalModelRequest,
) -> MediaCommandResult<MediaLocalModelImportResult> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            if let Err(error) = database::ensure_initialized(&paths) {
                Err(error)
            } else {
                tauri::async_runtime::spawn_blocking(move || {
                    model_import::import_reviewed(&paths, &request)
                })
                .await
                .map_err(|error| format!("local model import worker failed: {error}"))
                .and_then(|result| result)
            }
        }
        Err(error) => Err(error),
    };
    command_result("media_import_local_model", result)
}

#[tauri::command]
pub(crate) async fn media_probe_local_model(
    app: AppHandle,
    model_id: String,
) -> MediaCommandResult<provider_local_diffusers::LocalModelRuntimeProbeResult> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            if let Err(error) = database::ensure_initialized(&paths) {
                Err(error)
            } else {
                let model_id = match required_text("modelId", &model_id, 256) {
                    Ok(model_id) => model_id,
                    Err(error) => return command_result("media_probe_local_model", Err(error)),
                };
                tauri::async_runtime::spawn_blocking(move || {
                    provider_local_diffusers::probe_model(&app, &paths, &model_id)
                })
                .await
                .map_err(|error| format!("local model probe worker failed: {error}"))
                .and_then(|result| result)
            }
        }
        Err(error) => Err(error),
    };
    command_result("media_probe_local_model", result)
}

#[tauri::command]
pub(crate) async fn media_inspect_model_addon(
    app: AppHandle,
    source_path: String,
) -> MediaCommandResult<MediaModelAddonImportInspection> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            if let Err(error) = database::ensure_initialized(&paths) {
                Err(error)
            } else {
                tauri::async_runtime::spawn_blocking(move || model_addon::inspect(&source_path))
                    .await
                    .map_err(|error| format!("model add-on inspection worker failed: {error}"))
                    .and_then(|result| result)
            }
        }
        Err(error) => Err(error),
    };
    command_result("media_inspect_model_addon", result)
}

#[tauri::command]
pub(crate) async fn media_inspect_civitai_model_addon(
    source: String,
) -> MediaCommandResult<civitai_addon::MediaCivitaiModelAddonInspection> {
    command_result(
        "media_inspect_civitai_model_addon",
        civitai_addon::inspect_source(&source).await,
    )
}

#[tauri::command]
pub(crate) async fn media_download_civitai_model_addon(
    app: AppHandle,
    request: civitai_addon::DownloadMediaCivitaiModelAddonRequest,
) -> MediaCommandResult<MediaModelAddonImportInspection> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            if let Err(error) = database::ensure_initialized(&paths) {
                Err(error)
            } else {
                civitai_addon::download_reviewed(&paths, &request).await
            }
        }
        Err(error) => Err(error),
    };
    command_result("media_download_civitai_model_addon", result)
}

#[tauri::command]
pub(crate) async fn media_import_model_addon(
    app: AppHandle,
    request: ImportMediaModelAddonRequest,
) -> MediaCommandResult<MediaModelAddonImportResult> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            if let Err(error) = database::ensure_initialized(&paths) {
                Err(error)
            } else {
                tauri::async_runtime::spawn_blocking(move || {
                    let source_metadata =
                        civitai_addon::read_staged_source_metadata(&paths, &request.source_path)?;
                    let result = model_addon::import_reviewed_with_source(
                        &paths,
                        &request,
                        source_metadata.as_ref(),
                    )?;
                    let _ = civitai_addon::remove_staged_source_after_import(
                        &paths,
                        &request.source_path,
                    );
                    Ok(result)
                })
                .await
                .map_err(|error| format!("model add-on import worker failed: {error}"))
                .and_then(|result| result)
            }
        }
        Err(error) => Err(error),
    };
    command_result("media_import_model_addon", result)
}

#[tauri::command]
pub(crate) fn media_plan_model_addon_removal(
    app: AppHandle,
    addon_id: String,
) -> MediaCommandResult<MediaModelAddonRemovalPlan> {
    command_result(
        "media_plan_model_addon_removal",
        (|| {
            let addon_id = required_text("addonId", &addon_id, 256)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            model_addon::plan_removal(&paths, &addon_id)
        })(),
    )
}

#[tauri::command]
pub(crate) async fn media_remove_model_addon(
    app: AppHandle,
    request: RemoveMediaModelAddonRequest,
) -> MediaCommandResult<MediaModelAddonRemovalResult> {
    let result = match MediaRuntimePaths::resolve(&app) {
        Ok(paths) => {
            if let Err(error) = database::ensure_initialized(&paths) {
                Err(error)
            } else {
                tauri::async_runtime::spawn_blocking(move || model_addon::remove(&paths, &request))
                    .await
                    .map_err(|error| format!("model add-on removal worker failed: {error}"))
                    .and_then(|result| result)
            }
        }
        Err(error) => Err(error),
    };
    command_result("media_remove_model_addon", result)
}

#[tauri::command]
pub(crate) fn media_plan_model_install(
    app: AppHandle,
    model_id: String,
) -> MediaCommandResult<MediaModelInstallPlan> {
    command_result(
        "media_plan_model_install",
        (|| {
            let model_id = required_text("modelId", &model_id, 128)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            model_install::plan(&paths, &model_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_start_model_install(
    app: AppHandle,
    mut request: StartMediaModelInstallRequest,
) -> MediaCommandResult<MediaModelInstallJob> {
    command_result(
        "media_start_model_install",
        (|| {
            request.model_id = required_text("modelId", &request.model_id, 128)?;
            request.review_token = required_text("reviewToken", &request.review_token, 128)?;
            request.manifest_digest =
                required_text("manifestDigest", &request.manifest_digest, 128)?;
            request.license_digest = required_text("licenseDigest", &request.license_digest, 128)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let job = model_install::start(&paths, &request)?;
            spawn_model_install_worker(app, job.id.clone())?;
            Ok(job)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_get_model_install_job(
    app: AppHandle,
    job_id: String,
) -> MediaCommandResult<MediaModelInstallJob> {
    command_result(
        "media_get_model_install_job",
        (|| {
            let job_id = required_text("jobId", &job_id, 128)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            model_install::get_job(&paths, &job_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_cancel_model_install(
    app: AppHandle,
    job_id: String,
) -> MediaCommandResult<MediaModelInstallJob> {
    command_result(
        "media_cancel_model_install",
        (|| {
            let job_id = required_text("jobId", &job_id, 128)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            model_install::request_cancellation(&paths, &job_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_plan_model_removal(
    app: AppHandle,
    model_id: String,
) -> MediaCommandResult<MediaModelRemovalPlan> {
    command_result(
        "media_plan_model_removal",
        (|| {
            let model_id = required_text("modelId", &model_id, 128)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            model_install::plan_removal(&paths, &model_id)
        })(),
    )
}

#[tauri::command]
pub(crate) async fn media_remove_model(
    app: AppHandle,
    mut request: RemoveMediaModelRequest,
) -> MediaCommandResult<MediaModelRemovalResult> {
    let result: MediaResult<_> = async {
        request.model_id = required_text("modelId", &request.model_id, 128)?;
        request.confirmation_token =
            required_text("confirmationToken", &request.confirmation_token, 128)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        tauri::async_runtime::spawn_blocking(move || model_install::remove(&paths, &request))
            .await
            .map_err(|error| format!("model removal worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_remove_model", result)
}

#[tauri::command]
pub(crate) fn media_enqueue_fixture_run(
    app: AppHandle,
    mut request: EnqueueFixtureRunRequest,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_enqueue_fixture_run",
        (|| {
            request.validate()?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            database::enqueue_fixture_run(&paths, &request)?;
            spawn_fixture_worker(app, request.run_id.clone())?;
            database::get_run_detail(&paths, &request.run_id)
        })(),
    )
}

#[tauri::command]
pub(crate) async fn media_generate_images(
    app: AppHandle,
    mut request: GenerateMediaImagesRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result = async {
        request.validate()?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        if request.model_id != "openai:gpt-image-2" {
            return generate_local_diffusers(app.clone(), paths, request.clone()).await;
        }
        let env = crate::runtime_snapshot::load_global_env()?;
        let api_key = env
            .get("OPENAI_API_KEY")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "OpenAI provider is not configured. Save an API key first.".to_string()
            })?
            .to_string();
        let begin_paths = paths.clone();
        let begin_request = request.clone();
        let claimed = tauri::async_runtime::spawn_blocking(move || {
            database::begin_remote_image_generation(&begin_paths, &begin_request)
        })
        .await
        .map_err(|error| format!("direct image generation worker could not be joined: {error}"))??;
        if !claimed {
            return database::get_run_detail(&paths, &request.run_id);
        }
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["source.prompt", "source.image"],
            "completed",
            Some("provider.resolve-inputs"),
            Some("Generation inputs resolved"),
            Some(0.08),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.generate-image"],
            "running",
            Some("provider.generate"),
            Some("Generating images with OpenAI"),
            Some(0.1),
        )?;

        let batch = match provider_openai::generate(&paths, &request, &api_key).await {
            Ok(batch) => batch,
            Err(failure) => {
                let failure_paths = paths.clone();
                let run_id = request.run_id.clone();
                let failure_diagnostic = failure.diagnostic.clone();
                let acceptance_unknown = failure.acceptance_unknown;
                let provider_request_id = failure.provider_request_id.clone();
                let recorded = tauri::async_runtime::spawn_blocking(move || {
                    database::fail_remote_image_generation(
                        &failure_paths,
                        &run_id,
                        &failure_diagnostic,
                        acceptance_unknown,
                        provider_request_id.as_deref(),
                    )
                })
                .await
                .map_err(|error| {
                    format!("direct generation failure worker could not be joined: {error}")
                })?;
                return match recorded {
                    Ok(()) => database::get_run_detail(&paths, &request.run_id),
                    Err(recording_error) => Err(format!(
                        "{}; additionally failed to persist the run failure: {recording_error}",
                        failure.diagnostic
                    )),
                };
            }
        };
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.generate-image"],
            "completed",
            Some("provider.generate"),
            Some("OpenAI generation completed"),
            Some(0.8),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["operation.subject-cutout"],
            "completed",
            Some("local.subject-cutout"),
            Some("Subject cutout completed with the configured model fallback policy"),
            Some(0.9),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["output.asset"],
            "running",
            Some("asset.publish"),
            Some("Publishing final image"),
            Some(0.94),
        )?;

        let complete_paths = paths.clone();
        let complete_request = request.clone();
        let batch_provider_request_id = batch.provider_request_id.clone();
        let completed = tauri::async_runtime::spawn_blocking(move || {
            database::complete_remote_image_generation(
                &complete_paths,
                &complete_request,
                &batch,
            )
        })
        .await
        .map_err(|error| format!("generated image publisher could not be joined: {error}"))?;
        match completed {
            Ok(detail) => Ok(detail),
            Err(diagnostic) => {
                let failure_paths = paths.clone();
                let run_id = request.run_id.clone();
                let failure_diagnostic = diagnostic.clone();
                let provider_request_id = batch_provider_request_id;
                let recorded = tauri::async_runtime::spawn_blocking(move || {
                    database::fail_remote_image_generation(
                        &failure_paths,
                        &run_id,
                        &failure_diagnostic,
                        true,
                        provider_request_id.as_deref(),
                    )
                })
                .await
                .map_err(|error| {
                    format!("direct generation failure worker could not be joined: {error}")
                })?;
                match recorded {
                    Ok(()) => database::get_run_detail(&paths, &request.run_id),
                    Err(recording_error) => Err(format!(
                        "{diagnostic}; additionally failed to persist the run failure: {recording_error}"
                    )),
                }
            }
        }
    }
    .await;
    command_result("media_generate_images", result)
}

async fn generate_local_diffusers(
    app: AppHandle,
    paths: MediaRuntimePaths,
    request: GenerateMediaImagesRequest,
) -> MediaResult<MediaRunDetail> {
    let begin_paths = paths.clone();
    let begin_request = request.clone();
    let claimed = tauri::async_runtime::spawn_blocking(move || {
        database::begin_local_diffusers_generation(&begin_paths, &begin_request)
    })
    .await
    .map_err(|error| format!("local image generation worker could not be joined: {error}"))??;
    if !claimed {
        return database::get_run_detail(&paths, &request.run_id);
    }
    database::transition_nodes_by_type(
        &paths,
        &request.run_id,
        &["source.prompt", "source.image"],
        "completed",
        Some("local-diffusers.resolve-inputs"),
        Some("Local model and immutable add-on inputs resolved"),
        Some(0.08),
    )?;
    database::transition_nodes_by_type(
        &paths,
        &request.run_id,
        &["task.generate-image"],
        "running",
        Some("local-diffusers.generate"),
        Some("Generating images with the local Diffusers worker"),
        Some(0.1),
    )?;
    let generation_app = app.clone();
    let generation_paths = paths.clone();
    let generation_request = request.clone();
    let batch = tauri::async_runtime::spawn_blocking(move || {
        provider_local_diffusers::generate(&generation_app, &generation_paths, &generation_request)
    })
    .await
    .map_err(|error| format!("local Diffusers worker could not be joined: {error}"))?;
    let batch = match batch {
        Ok(batch) => batch,
        Err(diagnostic) => {
            if database::is_cancellation_requested(&paths, &request.run_id)? {
                database::cancel_run(&paths, &request.run_id)?;
                return database::get_run_detail(&paths, &request.run_id);
            }
            database::fail_run(&paths, &request.run_id, &diagnostic)?;
            return database::get_run_detail(&paths, &request.run_id);
        }
    };
    database::transition_nodes_by_type(
        &paths,
        &request.run_id,
        &["task.generate-image"],
        "completed",
        Some("local-diffusers.generate"),
        Some("Local diffusion generation completed"),
        Some(0.84),
    )?;
    database::transition_nodes_by_type(
        &paths,
        &request.run_id,
        &["operation.subject-cutout"],
        "completed",
        Some("local.subject-cutout"),
        Some("Subject cutout completed with the configured model fallback policy"),
        Some(0.9),
    )?;
    database::transition_nodes_by_type(
        &paths,
        &request.run_id,
        &["output.asset"],
        "running",
        Some("asset.publish"),
        Some("Publishing locally generated image"),
        Some(0.94),
    )?;
    let complete_paths = paths.clone();
    let complete_request = request.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        database::complete_local_diffusers_generation(&complete_paths, &complete_request, &batch)
    })
    .await
    .map_err(|error| format!("local image publisher could not be joined: {error}"))?
    {
        Ok(detail) => Ok(detail),
        Err(diagnostic) => {
            database::fail_run(&paths, &request.run_id, &diagnostic)?;
            database::get_run_detail(&paths, &request.run_id)
        }
    }
}

#[tauri::command]
pub(crate) async fn media_generate_svg(
    app: AppHandle,
    mut request: GenerateMediaSvgRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result = async {
        request.validate()?;
        let env = crate::runtime_snapshot::load_global_env()?;
        if request.critic_enabled
            && env
                .get("OPENAI_API_KEY")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        {
            return Err(
                "OpenAI SVG render-feedback repair is enabled, but OPENAI_API_KEY is not configured"
                    .to_string(),
            );
        }
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;

        let prepare_paths = paths.clone();
        let prepare_request = request.clone();
        let reference_plan = Arc::new(
            tauri::async_runtime::spawn_blocking(move || {
                provider_svg::prepare_references(&prepare_paths, &prepare_request)
            })
            .await
            .map_err(|error| {
                format!("SVG reference preparation worker could not be joined: {error}")
            })??,
        );

        let begin_paths = paths.clone();
        let begin_request = request.clone();
        let begin_reference_plan = Arc::clone(&reference_plan);
        let claimed = tauri::async_runtime::spawn_blocking(move || {
            database::begin_remote_svg_generation(
                &begin_paths,
                &begin_request,
                begin_reference_plan.as_ref(),
            )
        })
        .await
        .map_err(|error| format!("SVG generation worker could not be joined: {error}"))??;
        if !claimed {
            return database::get_run_detail(&paths, &request.run_id);
        }
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["source.prompt", "source.image"],
            "completed",
            Some("provider.resolve-inputs"),
            Some("SVG design specification and audited visual references resolved"),
            Some(0.05),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.generate-image"],
            "running",
            Some(if request.mode == "vectorize" {
                "provider.vectorize-svg"
            } else {
                "provider.generate-svg"
            }),
            Some(if request.mode == "vectorize" {
                "Vectorizing the audited source image"
            } else {
                "Generating diverse SVG candidates"
            }),
            Some(0.1),
        )?;

        let batch = match provider_svg::generate(&paths, &request, reference_plan.as_ref(), &env)
            .await
        {
            Ok(batch) => batch,
            Err(failure) => {
                let failure_paths = paths.clone();
                let run_id = request.run_id.clone();
                let diagnostic = failure.diagnostic.clone();
                let acceptance_unknown = failure.acceptance_unknown;
                let provider_request_id = failure.provider_request_id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    database::fail_remote_image_generation(
                        &failure_paths,
                        &run_id,
                        &diagnostic,
                        acceptance_unknown,
                        provider_request_id.as_deref(),
                    )
                })
                .await
                .map_err(|error| format!("SVG failure worker could not be joined: {error}"))??;
                return database::get_run_detail(&paths, &request.run_id);
            }
        };
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.generate-image"],
            "completed",
            Some("provider.verify-svg"),
            Some(if request.mode == "vectorize" {
                "Vectorized SVG passed Secure Static validation, rendering, and scoring"
            } else {
                "Candidates passed Secure Static validation, rendering, scoring, and repair"
            }),
            Some(0.88),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["output.asset"],
            "running",
            Some("asset.publish-svg"),
            Some("Publishing canonical SVG and deterministic previews"),
            Some(0.94),
        )?;

        let complete_paths = paths.clone();
        let complete_request = request.clone();
        let complete_reference_plan = Arc::clone(&reference_plan);
        let batch_request_id = batch.provider_request_id.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            database::complete_remote_svg_generation(
                &complete_paths,
                &complete_request,
                &batch,
                complete_reference_plan.as_ref(),
            )
        })
        .await
        .map_err(|error| format!("SVG publisher could not be joined: {error}"))?
        {
            Ok(detail) => Ok(detail),
            Err(diagnostic) => {
                let failure_paths = paths.clone();
                let run_id = request.run_id.clone();
                let failure_diagnostic = diagnostic.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    database::fail_remote_image_generation(
                        &failure_paths,
                        &run_id,
                        &failure_diagnostic,
                        true,
                        batch_request_id.as_deref(),
                    )
                })
                .await
                .map_err(|error| format!("SVG failure worker could not be joined: {error}"))??;
                database::get_run_detail(&paths, &request.run_id)
            }
        }
    }
    .await;
    command_result("media_generate_svg", result)
}

#[tauri::command]
pub(crate) async fn media_execute_remote_image_edit_flow(
    app: AppHandle,
    mut request: ExecuteRemoteImageEditFlowRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result = async {
        request.validate()?;
        let env = crate::runtime_snapshot::load_global_env()?;
        let api_key = env
            .get("OPENAI_API_KEY")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "OpenAI provider is not configured. Save an API key first.".to_string()
            })?
            .to_string();
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;

        let begin_paths = paths.clone();
        let begin_request = request.clone();
        let (claimed, mut plan) = tauri::async_runtime::spawn_blocking(move || {
            let plan = flow::compile_remote_image_edit_flow(
                &begin_paths,
                &begin_request.flow_id,
                &begin_request.flow_revision_id,
                &begin_request.plan_snapshot,
            )?;
            let claimed =
                database::begin_remote_image_edit(&begin_paths, &begin_request, &plan)?;
            Ok::<_, String>((claimed, plan))
        })
        .await
        .map_err(|error| format!("remote image edit worker could not be joined: {error}"))??;
        if !claimed {
            return database::get_run_detail(&paths, &request.run_id);
        }
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["source.prompt", "source.image"],
            "completed",
            Some("provider.resolve-inputs"),
            Some("Edit inputs resolved"),
            Some(0.08),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.edit-image"],
            "running",
            Some("provider.edit"),
            Some("Editing images with OpenAI"),
            Some(0.1),
        )?;

        let batch = match provider_openai::edit(&paths, &mut plan, &api_key).await {
            Ok(batch) => batch,
            Err(failure) => {
                let failure_paths = paths.clone();
                let run_id = request.run_id.clone();
                let failure_diagnostic = failure.diagnostic.clone();
                let acceptance_unknown = failure.acceptance_unknown;
                let provider_request_id = failure.provider_request_id.clone();
                let recorded = tauri::async_runtime::spawn_blocking(move || {
                    database::fail_remote_image_generation(
                        &failure_paths,
                        &run_id,
                        &failure_diagnostic,
                        acceptance_unknown,
                        provider_request_id.as_deref(),
                    )
                })
                .await
                .map_err(|error| {
                    format!("remote image edit failure worker could not be joined: {error}")
                })?;
                return match recorded {
                    Ok(()) => database::get_run_detail(&paths, &request.run_id),
                    Err(recording_error) => Err(format!(
                        "{}; additionally failed to persist the run failure: {recording_error}",
                        failure.diagnostic
                    )),
                };
            }
        };
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.edit-image"],
            "completed",
            Some("provider.edit"),
            Some("OpenAI image edit completed"),
            Some(0.8),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["operation.subject-cutout"],
            "completed",
            Some("local.subject-cutout"),
            Some("Subject cutout completed with the configured model fallback policy"),
            Some(0.9),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["output.asset"],
            "running",
            Some("asset.publish"),
            Some("Publishing final edited image"),
            Some(0.94),
        )?;

        let complete_paths = paths.clone();
        let complete_request = request.clone();
        let batch_provider_request_id = batch.provider_request_id.clone();
        let completed = tauri::async_runtime::spawn_blocking(move || {
            database::complete_remote_image_edit(
                &complete_paths,
                &complete_request,
                &plan,
                &batch,
            )
        })
        .await
        .map_err(|error| format!("edited image publisher could not be joined: {error}"))?;
        match completed {
            Ok(detail) => Ok(detail),
            Err(diagnostic) => {
                let failure_paths = paths.clone();
                let run_id = request.run_id.clone();
                let failure_diagnostic = diagnostic.clone();
                let provider_request_id = batch_provider_request_id;
                let recorded = tauri::async_runtime::spawn_blocking(move || {
                    database::fail_remote_image_generation(
                        &failure_paths,
                        &run_id,
                        &failure_diagnostic,
                        true,
                        provider_request_id.as_deref(),
                    )
                })
                .await
                .map_err(|error| {
                    format!("remote image edit failure worker could not be joined: {error}")
                })?;
                match recorded {
                    Ok(()) => database::get_run_detail(&paths, &request.run_id),
                    Err(recording_error) => Err(format!(
                        "{diagnostic}; additionally failed to persist the run failure: {recording_error}"
                    )),
                }
            }
        }
    }
    .await;
    command_result("media_execute_remote_image_edit_flow", result)
}

#[tauri::command]
pub(crate) fn media_enqueue_mock_remote_run(
    app: AppHandle,
    mut request: EnqueueMockRemoteRunRequest,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_enqueue_mock_remote_run",
        (|| {
            request.validate()?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            provider_mock::enqueue(&paths, &request)?;
            spawn_provider_worker(app, request.run_id.clone())?;
            database::get_run_detail(&paths, &request.run_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_resolve_provider_review(
    app: AppHandle,
    mut request: ResolveProviderReviewRequest,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_resolve_provider_review",
        (|| {
            request.provider_job_id =
                required_text("providerJobId", &request.provider_job_id, 256)?;
            request.action = required_text("action", &request.action, 64)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let scenario = database::open(&paths)?
                .query_row(
                    "SELECT scenario FROM provider_jobs WHERE id = ?1",
                    rusqlite::params![request.provider_job_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| format!("failed to inspect provider review adapter: {error}"))?;
            let run_id = if scenario == "openai:gpt-image-2"
                || scenario.starts_with("quiver:")
                || scenario.starts_with("recraft:")
                || scenario.starts_with("local-svg:")
            {
                database::resolve_openai_provider_review(
                    &paths,
                    &request.provider_job_id,
                    &request.action,
                )?
            } else {
                let run_id = provider_mock::resolve_review(&paths, &request)?;
                spawn_provider_worker(app, run_id.clone())?;
                run_id
            };
            database::get_run_detail(&paths, &run_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_resolve_human_review(
    app: AppHandle,
    mut request: MediaHumanReviewDecisionRequest,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_resolve_human_review",
        (|| {
            request.validate()?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let run_id = database::resolve_human_review(&paths, &request)?;
            database::get_run_detail(&paths, &run_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_wake_provider_reconciliation(
    app: AppHandle,
    provider_job_id: String,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_wake_provider_reconciliation",
        (|| {
            let provider_job_id = required_text("providerJobId", &provider_job_id, 256)?;
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let run_id = provider_mock::wake_reconciliation(&paths, &provider_job_id)?;
            spawn_provider_worker(app, run_id.clone())?;
            database::get_run_detail(&paths, &run_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_list_runs(
    app: AppHandle,
    limit: Option<u32>,
) -> MediaCommandResult<Vec<MediaRunRecord>> {
    command_result(
        "media_list_runs",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            database::list_runs(&paths, limit.unwrap_or(100).clamp(1, 500))
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_get_run_detail(
    app: AppHandle,
    run_id: String,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_get_run_detail",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            database::get_run_detail(&paths, &required_text("runId", &run_id, 128)?)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_cancel_run(
    app: AppHandle,
    run_id: String,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_cancel_run",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let run_id = required_text("runId", &run_id, 128)?;
            database::request_cancellation(&paths, &run_id)?;
            if provider_mock::is_provider_run(&paths, &run_id)? {
                provider_mock::request_cancellation(&paths, &run_id)?;
                spawn_provider_worker(app, run_id.clone())?;
            }
            database::get_run_detail(&paths, &run_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_retry_fixture_run(
    app: AppHandle,
    run_id: String,
) -> MediaCommandResult<MediaRunDetail> {
    command_result(
        "media_retry_fixture_run",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let run_id = required_text("runId", &run_id, 128)?;
            database::retry_fixture_run(&paths, &run_id)?;
            spawn_fixture_worker(app, run_id.clone())?;
            database::get_run_detail(&paths, &run_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_list_assets(
    app: AppHandle,
    limit: Option<u32>,
) -> MediaCommandResult<Vec<MediaAssetRecord>> {
    command_result(
        "media_list_assets",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            database::list_assets(&paths, limit.unwrap_or(200).clamp(1, 1_000))
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_get_model_catalog(
    app: AppHandle,
    configured_provider_ids: Vec<String>,
) -> MediaCommandResult<MediaModelCatalogSnapshot> {
    command_result(
        "media_get_model_catalog",
        (|| {
            if configured_provider_ids.len() > 32 {
                return Err("configuredProviderIds is limited to 32 entries".to_string());
            }
            let mut configured_provider_ids = configured_provider_ids
                .into_iter()
                .map(|provider_id| required_text("configuredProviderId", &provider_id, 64))
                .collect::<MediaResult<HashSet<_>>>()?;
            let env = crate::runtime_snapshot::load_global_env()?;
            for (provider_id, env_key) in [
                ("quiver", "QUIVERAI_API_KEY"),
                ("recraft", "RECRAFT_API_KEY"),
                ("local-svg-runtime", "MACHDOCH_SVG_LOCAL_ENDPOINT"),
            ] {
                if env
                    .get(env_key)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    configured_provider_ids.insert(provider_id.to_string());
                }
            }
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let mut snapshot = database::get_model_catalog(&paths, &configured_provider_ids)?;
            let runtime = app
                .state::<MediaRuntimeState>()
                .local_diffusers_status(&app);
            provider_local_diffusers::annotate_catalog_readiness(
                &paths,
                &runtime,
                &mut snapshot.models,
            )?;
            Ok(snapshot)
        })(),
    )
}

fn normalize_asset_tags(tags: Vec<String>) -> MediaResult<Vec<(String, String)>> {
    if tags.len() > 64 {
        return Err("asset tag input is limited to 64 entries".to_string());
    }
    let mut normalized_tags = Vec::new();
    let mut seen = HashSet::new();
    for tag in tags {
        let label = tag.split_whitespace().collect::<Vec<_>>().join(" ");
        if label.is_empty() {
            continue;
        }
        if label.chars().count() > 48 {
            return Err("asset tags are limited to 48 characters".to_string());
        }
        let mut normalized = String::new();
        let mut separator_pending = false;
        for character in label.chars() {
            if character.is_alphanumeric() {
                if separator_pending && !normalized.is_empty() {
                    normalized.push('-');
                }
                separator_pending = false;
                normalized.extend(character.to_lowercase());
            } else if character.is_whitespace() || matches!(character, '-' | '_') {
                separator_pending = true;
            } else {
                return Err(
                    "asset tags may contain letters, numbers, spaces, hyphens, and underscores"
                        .to_string(),
                );
            }
        }
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        normalized_tags.push((normalized, label));
    }
    if normalized_tags.len() > 32 {
        return Err("an asset can have at most 32 user tags".to_string());
    }
    Ok(normalized_tags)
}

#[tauri::command]
pub(crate) fn media_set_asset_tags(
    app: AppHandle,
    asset_id: String,
    tags: Vec<String>,
) -> MediaCommandResult<MediaAssetRecord> {
    command_result(
        "media_set_asset_tags",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let asset_id = required_text("assetId", &asset_id, 256)?;
            let tags = normalize_asset_tags(tags)?;
            database::set_user_asset_tags(&paths, &asset_id, &tags)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_auto_tag_asset(
    app: AppHandle,
    asset_id: String,
) -> MediaCommandResult<MediaAssetRecord> {
    command_result(
        "media_auto_tag_asset",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let asset_id = required_text("assetId", &asset_id, 256)?;
            database::auto_tag_asset(&paths, &asset_id)
        })(),
    )
}

#[tauri::command]
pub(crate) fn media_plan_asset_deletion(
    app: AppHandle,
    asset_id: String,
) -> MediaCommandResult<MediaAssetDeletionImpact> {
    command_result(
        "media_plan_asset_deletion",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let asset_id = required_text("assetId", &asset_id, 256)?;
            database::plan_asset_deletion(&paths, &asset_id)
        })(),
    )
}

#[tauri::command]
pub(crate) async fn media_delete_asset(
    app: AppHandle,
    mut request: MediaAssetDeletionRequest,
) -> MediaCommandResult<MediaAssetDeletionResult> {
    let result: MediaResult<_> = async {
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        request.asset_id = required_text("assetId", &request.asset_id, 256)?;
        request.confirmation_token =
            required_text("confirmationToken", &request.confirmation_token, 128)?;
        tauri::async_runtime::spawn_blocking(move || database::delete_asset(&paths, &request))
            .await
            .map_err(|error| format!("asset deletion worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_delete_asset", result)
}

#[tauri::command]
pub(crate) fn media_inspect_hardware(
    app: AppHandle,
) -> MediaCommandResult<hardware::MediaHardwareInspection> {
    command_result(
        "media_inspect_hardware",
        (|| {
            let paths = MediaRuntimePaths::resolve(&app)?;
            database::ensure_initialized(&paths)?;
            let storage_path = paths
                .database
                .parent()
                .ok_or_else(|| "Media Studio storage path has no parent directory".to_string())?;
            hardware::inspect(storage_path)
        })(),
    )
}

#[tauri::command]
pub(crate) async fn media_import_image(
    app: AppHandle,
    path: String,
) -> MediaCommandResult<MediaImageImportResult> {
    let result: MediaResult<_> = async {
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        tauri::async_runtime::spawn_blocking(move || ingest::import_image(&paths, &path))
            .await
            .map_err(|error| format!("image import worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_import_image", result)
}

#[tauri::command]
pub(crate) async fn media_read_asset_preview(
    app: AppHandle,
    asset_id: String,
    max_edge: Option<u32>,
) -> MediaCommandResult<tauri::ipc::Response> {
    let result: MediaResult<_> = async {
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        let asset_id = required_text("assetId", &asset_id, 256)?;
        let max_edge = max_edge.unwrap_or(512);
        if !(64..=2_048).contains(&max_edge) {
            return Err("maxEdge must be between 64 and 2048 pixels".to_string());
        }
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            transform::read_asset_preview(&paths, &asset_id, max_edge)
        })
        .await
        .map_err(|error| format!("asset preview worker could not be joined: {error}"))??;
        Ok(tauri::ipc::Response::new(bytes))
    }
    .await;
    command_result("media_read_asset_preview", result)
}

#[tauri::command]
pub(crate) async fn media_transform_image(
    app: AppHandle,
    mut request: MediaImageTransformRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result: MediaResult<_> = async {
        request.source_asset_id = required_text("sourceAssetId", &request.source_asset_id, 256)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        tauri::async_runtime::spawn_blocking(move || transform::transform_image(&paths, &request))
            .await
            .map_err(|error| format!("image transform worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_transform_image", result)
}

#[tauri::command]
pub(crate) async fn media_execute_local_image_flow(
    app: AppHandle,
    mut request: ExecuteLocalImageFlowRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result: MediaResult<_> = async {
        request.validate()?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        tauri::async_runtime::spawn_blocking(move || {
            let plan = flow::compile_local_image_flow(
                &paths,
                &request.flow_id,
                &request.flow_revision_id,
                &request.plan_snapshot,
            )?;
            local_flow::execute(&paths, &request, &plan)
        })
        .await
        .map_err(|error| format!("local image flow worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_execute_local_image_flow", result)
}

#[tauri::command]
pub(crate) async fn media_export_asset(
    app: AppHandle,
    mut request: MediaAssetExportRequest,
) -> MediaCommandResult<MediaAssetExportRecord> {
    let result: MediaResult<_> = async {
        request.asset_id = required_text("assetId", &request.asset_id, 256)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        tauri::async_runtime::spawn_blocking(move || exporting::export_asset(&paths, &request))
            .await
            .map_err(|error| format!("asset export worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_export_asset", result)
}

#[tauri::command]
pub(crate) async fn media_analyze_image_quality(
    app: AppHandle,
    source_asset_id: String,
) -> MediaCommandResult<MediaQualityAnalysisResult> {
    let result: MediaResult<_> = async {
        let source_asset_id = required_text("sourceAssetId", &source_asset_id, 256)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        tauri::async_runtime::spawn_blocking(move || {
            analysis::analyze_image(&paths, &source_asset_id)
        })
        .await
        .map_err(|error| format!("image analysis worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_analyze_image_quality", result)
}

#[tauri::command]
pub(crate) async fn media_read_quality_report(
    app: AppHandle,
    report_asset_id: String,
) -> MediaCommandResult<MediaQualityReport> {
    let result: MediaResult<_> = async {
        let report_asset_id = required_text("reportAssetId", &report_asset_id, 256)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        tauri::async_runtime::spawn_blocking(move || {
            analysis::read_quality_report(&paths, &report_asset_id)
        })
        .await
        .map_err(|error| format!("quality report worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_read_quality_report", result)
}
