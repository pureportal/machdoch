use serde::Serialize;

use super::MediaResult;

pub(crate) type MediaCommandResult<T> = Result<T, Box<MediaError>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum MediaErrorCode {
    InvalidRequest,
    FlowRevisionConflict,
    ResourceNotFound,
    StorageUnavailable,
    DiskFull,
    PathNotAllowed,
    InternalError,
    ModelNotInstalled,
    ModelLicenseRequired,
    ModelAccessDenied,
    ProviderNotConfigured,
    ProviderModelDeprecated,
    ProviderModelRemoved,
    ProviderLifecycleUnknown,
    ProviderQuotaExceeded,
    ProviderRateLimited,
    ProviderRegionUnsupported,
    ProviderFeatureUiOnly,
    ProviderRequestFailed,
    RemoteUploadNotAllowed,
    RemoteOutputExpired,
    RemoteRetryCostRisk,
    UnsupportedCapability,
    UnsupportedHardware,
    UnsupportedRuntimeVariant,
    UnsupportedDimensions,
    UnsupportedFormat,
    UnsupportedAdapter,
    AdapterBaseModelMismatch,
    UnsupportedOptimization,
    OptimizationQualityDrift,
    TrainingDatasetInvalid,
    TrainingInterrupted,
    InvalidMaskAlignment,
    InvalidFrameRange,
    InvalidKeyframeSet,
    InvalidConditionSet,
    InvalidEditIntent,
    ContinuityConstraintFailed,
    Oom,
    DriverRuntimeMismatch,
    OptimizedEngineInvalid,
    WorkerCrashed,
    WorkerTimeout,
    SafetyRejectedInput,
    SafetyRejectedOutput,
    ProvenanceAttachFailed,
    ProvenanceVerifyFailed,
    WatermarkDetectionFailed,
    OutputValidationFailed,
    QualityGateFailed,
    ExportFailed,
    CancelledByUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaErrorCategory {
    Validation,
    Configuration,
    Capability,
    Resource,
    Provider,
    Safety,
    Integrity,
    Storage,
    Lifecycle,
    Cancellation,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaErrorRetryability {
    Never,
    RetrySafe,
    AfterUserAction,
    ReconcileFirst,
    UserApprovalRequired,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaErrorContext {
    node_id: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    runtime_id: Option<String>,
    run_id: Option<String>,
    asset_id: Option<String>,
    operation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaErrorAction {
    id: &'static str,
    label: &'static str,
    description: &'static str,
}

impl MediaErrorAction {
    const fn new(id: &'static str, label: &'static str, description: &'static str) -> Self {
        Self {
            id,
            label,
            description,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaError {
    schema_version: u32,
    code: MediaErrorCode,
    category: MediaErrorCategory,
    message: String,
    technical_diagnostic: String,
    context: MediaErrorContext,
    retryability: MediaErrorRetryability,
    partial_outputs_exist: bool,
    suggested_actions: Vec<MediaErrorAction>,
}

impl MediaError {
    pub(crate) fn from_internal(operation: &str, diagnostic: impl Into<String>) -> Self {
        let diagnostic = diagnostic.into();
        let lower = diagnostic.to_ascii_lowercase();
        let cause = lower
            .split("\nworker diagnostics (tail):")
            .next()
            .unwrap_or(&lower);
        let code = classify(operation, cause);
        let (category, message, retryability, suggested_actions) = presentation(code);
        Self {
            schema_version: 1,
            code,
            category,
            message: if operation.contains("civitai") {
                sanitize_diagnostic(&diagnostic)
            } else if cause.contains("cannot fit all vectors for") {
                "Prompt is too long for the selected embeddings. Shorten it or remove an embedding."
                    .to_string()
            } else if cause.contains("negative embeddings need guidance above 1") {
                "Negative embeddings need guidance above 1. Increase guidance or change placement."
                    .to_string()
            } else if code == MediaErrorCode::QualityGateFailed {
                format!(
                    "{}. Review the image and gate settings.",
                    sanitize_diagnostic(&diagnostic).trim_end_matches('.')
                )
            } else {
                message.to_string()
            },
            technical_diagnostic: sanitize_diagnostic(&diagnostic),
            context: MediaErrorContext {
                operation: Some(operation.to_string()),
                ..MediaErrorContext::default()
            },
            retryability,
            partial_outputs_exist: false,
            suggested_actions,
        }
    }

    pub(crate) fn with_run_id(mut self, run_id: &str) -> Self {
        self.context.run_id = Some(run_id.to_string());
        self
    }

    pub(crate) fn with_partial_outputs(mut self, partial_outputs_exist: bool) -> Self {
        self.partial_outputs_exist = partial_outputs_exist;
        self
    }
}

pub(crate) fn command_result<T>(
    operation: &'static str,
    result: MediaResult<T>,
) -> MediaCommandResult<T> {
    result.map_err(|diagnostic| Box::new(MediaError::from_internal(operation, diagnostic)))
}

fn classify(operation: &str, diagnostic: &str) -> MediaErrorCode {
    if diagnostic.contains("cannot fit all vectors for")
        || diagnostic.contains("negative embeddings need guidance above 1")
    {
        return MediaErrorCode::InvalidRequest;
    }
    if diagnostic.starts_with("quality gate failed")
        || diagnostic.starts_with("quality gate stopped")
    {
        return MediaErrorCode::QualityGateFailed;
    }
    if diagnostic.contains("flow revision conflict") {
        return MediaErrorCode::FlowRevisionConflict;
    }
    if diagnostic.contains("cancelled") || diagnostic.contains("canceled") {
        return MediaErrorCode::CancelledByUser;
    }
    if diagnostic.contains("license")
        && (diagnostic.contains("accept") || diagnostic.contains("required"))
    {
        return MediaErrorCode::ModelLicenseRequired;
    }
    if diagnostic.contains("model") && diagnostic.contains("not installed") {
        return MediaErrorCode::ModelNotInstalled;
    }
    if (diagnostic.contains("model access") && diagnostic.contains("denied"))
        || (operation.contains("civitai")
            && (diagnostic.contains("denied") || diagnostic.contains("rejected the api key")))
    {
        return MediaErrorCode::ModelAccessDenied;
    }
    if diagnostic.contains("provider") && diagnostic.contains("not configured") {
        return MediaErrorCode::ProviderNotConfigured;
    }
    if diagnostic.contains("provider model") && diagnostic.contains("deprecated") {
        return MediaErrorCode::ProviderModelDeprecated;
    }
    if diagnostic.contains("provider model") && diagnostic.contains("removed") {
        return MediaErrorCode::ProviderModelRemoved;
    }
    if diagnostic.contains("provider lifecycle") && diagnostic.contains("unknown") {
        return MediaErrorCode::ProviderLifecycleUnknown;
    }
    if diagnostic.contains("provider region") && diagnostic.contains("unsupported") {
        return MediaErrorCode::ProviderRegionUnsupported;
    }
    if diagnostic.contains("provider feature") && diagnostic.contains("ui only") {
        return MediaErrorCode::ProviderFeatureUiOnly;
    }
    if diagnostic.contains("provider")
        && (diagnostic.contains("rejected") || diagnostic.contains("failed"))
    {
        return MediaErrorCode::ProviderRequestFailed;
    }
    if diagnostic.contains("retry")
        && (diagnostic.contains("paid")
            || diagnostic.contains("charge")
            || diagnostic.contains("acceptance"))
    {
        return MediaErrorCode::RemoteRetryCostRisk;
    }
    if diagnostic.contains("expired") && diagnostic.contains("result") {
        return MediaErrorCode::RemoteOutputExpired;
    }
    if diagnostic.contains("quota") {
        return MediaErrorCode::ProviderQuotaExceeded;
    }
    if diagnostic.contains("rate limit") {
        return MediaErrorCode::ProviderRateLimited;
    }
    if diagnostic.contains("remote upload") && diagnostic.contains("not allowed") {
        return MediaErrorCode::RemoteUploadNotAllowed;
    }
    if diagnostic.contains("out of memory")
        || diagnostic.contains("outofmemoryerror")
        || diagnostic.contains("hiperroroutofmemory")
        || diagnostic
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| word == "oom")
    {
        return MediaErrorCode::Oom;
    }
    if diagnostic.contains("timed out") || diagnostic.contains("timeout") {
        return MediaErrorCode::WorkerTimeout;
    }
    if diagnostic.contains("worker")
        && (diagnostic.contains("join") || diagnostic.contains("crash"))
    {
        return MediaErrorCode::WorkerCrashed;
    }
    if diagnostic.contains("safety rejected input") || diagnostic.contains("safety_rejected_input")
    {
        return MediaErrorCode::SafetyRejectedInput;
    }
    if diagnostic.contains("safety rejected output")
        || diagnostic.contains("safety_rejected_output")
    {
        return MediaErrorCode::SafetyRejectedOutput;
    }
    if diagnostic.contains("generator of type cuda")
        || diagnostic.contains("same device")
        || diagnostic.contains("cpu/gpu")
    {
        return MediaErrorCode::DriverRuntimeMismatch;
    }
    if diagnostic.contains("provenance") && diagnostic.contains("attach") {
        return MediaErrorCode::ProvenanceAttachFailed;
    }
    if diagnostic.contains("provenance") && diagnostic.contains("verify") {
        return MediaErrorCode::ProvenanceVerifyFailed;
    }
    if diagnostic.contains("watermark detection") {
        return MediaErrorCode::WatermarkDetectionFailed;
    }
    if diagnostic.contains("output validation") {
        return MediaErrorCode::OutputValidationFailed;
    }
    if diagnostic.contains("not found") || diagnostic.contains("was not found") {
        return MediaErrorCode::ResourceNotFound;
    }
    if diagnostic.contains("outside") && diagnostic.contains("path") {
        return MediaErrorCode::PathNotAllowed;
    }
    if diagnostic.contains("no space")
        || diagnostic.contains("disk full")
        || diagnostic.contains("insufficient space")
        || diagnostic.contains("not have enough free space")
        || diagnostic.contains("not enough free space")
    {
        return MediaErrorCode::DiskFull;
    }
    if diagnostic.contains("unsupported") && diagnostic.contains("format") {
        return MediaErrorCode::UnsupportedFormat;
    }
    if diagnostic.contains("unsupported runtime variant") {
        return MediaErrorCode::UnsupportedRuntimeVariant;
    }
    if diagnostic.contains("adapter base model mismatch") {
        return MediaErrorCode::AdapterBaseModelMismatch;
    }
    if diagnostic.contains("unsupported adapter") {
        return MediaErrorCode::UnsupportedAdapter;
    }
    if diagnostic.contains("optimization quality drift") {
        return MediaErrorCode::OptimizationQualityDrift;
    }
    if diagnostic.contains("unsupported optimization") {
        return MediaErrorCode::UnsupportedOptimization;
    }
    if diagnostic.contains("dimension")
        || diagnostic.contains("pixel limit")
        || diagnostic.contains("too many pixels")
    {
        return MediaErrorCode::UnsupportedDimensions;
    }
    if diagnostic.contains("unsupported") && diagnostic.contains("hardware") {
        return MediaErrorCode::UnsupportedHardware;
    }
    if diagnostic.contains("training dataset") && diagnostic.contains("invalid") {
        return MediaErrorCode::TrainingDatasetInvalid;
    }
    if diagnostic.contains("training") && diagnostic.contains("interrupted") {
        return MediaErrorCode::TrainingInterrupted;
    }
    if diagnostic.contains("mask alignment") {
        return MediaErrorCode::InvalidMaskAlignment;
    }
    if diagnostic.contains("frame range") {
        return MediaErrorCode::InvalidFrameRange;
    }
    if diagnostic.contains("keyframe set") {
        return MediaErrorCode::InvalidKeyframeSet;
    }
    if diagnostic.contains("condition set") {
        return MediaErrorCode::InvalidConditionSet;
    }
    if diagnostic.contains("edit intent") {
        return MediaErrorCode::InvalidEditIntent;
    }
    if diagnostic.contains("continuity constraint") {
        return MediaErrorCode::ContinuityConstraintFailed;
    }
    if diagnostic.contains("driver runtime mismatch") {
        return MediaErrorCode::DriverRuntimeMismatch;
    }
    if diagnostic.contains("optimized engine") && diagnostic.contains("invalid") {
        return MediaErrorCode::OptimizedEngineInvalid;
    }
    if diagnostic.contains("unsupported") {
        return MediaErrorCode::UnsupportedCapability;
    }
    if diagnostic.contains("invalid")
        || diagnostic.contains("must be")
        || diagnostic.contains("required")
        || diagnostic.contains("limited to")
        || diagnostic.contains("exceeds")
        || diagnostic.contains("does not match")
    {
        return MediaErrorCode::InvalidRequest;
    }
    if operation.contains("export") {
        return MediaErrorCode::ExportFailed;
    }
    if diagnostic.contains("sqlite")
        || diagnostic.contains("database")
        || diagnostic.contains("storage")
        || diagnostic.contains("content-addressed")
        || diagnostic.contains("blob")
    {
        return MediaErrorCode::StorageUnavailable;
    }
    MediaErrorCode::InternalError
}

fn presentation(
    code: MediaErrorCode,
) -> (
    MediaErrorCategory,
    &'static str,
    MediaErrorRetryability,
    Vec<MediaErrorAction>,
) {
    use MediaErrorAction as Action;
    use MediaErrorCategory as Category;
    use MediaErrorCode as Code;
    use MediaErrorRetryability as Retry;

    let refresh = Action::new(
        "refresh",
        "Refresh",
        "Reload the durable Media Studio state before trying again.",
    );
    match code {
        Code::QualityGateFailed => (
            Category::Validation,
            "Quality checks failed. Review the image and gate settings.",
            Retry::AfterUserAction,
            vec![Action::new("review-input", "Review gate", "Review the image and gate settings.")],
        ),
        Code::FlowRevisionConflict => (
            Category::Integrity,
            "This flow changed since its revision history was loaded.",
            Retry::ReconcileFirst,
            vec![refresh],
        ),
        Code::InvalidRequest
        | Code::InvalidMaskAlignment
        | Code::InvalidFrameRange
        | Code::InvalidKeyframeSet
        | Code::InvalidConditionSet
        | Code::InvalidEditIntent => (
            Category::Validation,
            "Some media settings are invalid.",
            Retry::AfterUserAction,
            vec![Action::new(
                "review-input",
                "Review settings",
                "Correct the highlighted input or choose a compatible preset.",
            )],
        ),
        Code::ResourceNotFound => (
            Category::Storage,
            "The requested media item is no longer available.",
            Retry::AfterUserAction,
            vec![refresh],
        ),
        Code::StorageUnavailable => (
            Category::Storage,
            "Media Studio storage is temporarily unavailable.",
            Retry::RetrySafe,
            vec![refresh],
        ),
        Code::DiskFull => (
            Category::Storage,
            "There is not enough free disk space for this operation.",
            Retry::AfterUserAction,
            vec![Action::new(
                "free-space",
                "Review storage",
                "Free space or remove unreferenced Media Studio data, then retry.",
            )],
        ),
        Code::PathNotAllowed => (
            Category::Storage,
            "Media Studio cannot use that file location.",
            Retry::AfterUserAction,
            vec![Action::new(
                "choose-location",
                "Choose another location",
                "Select a user-approved file or export destination.",
            )],
        ),
        Code::ModelNotInstalled => (
            Category::Configuration,
            "The selected local model is not installed.",
            Retry::AfterUserAction,
            vec![Action::new(
                "open-models",
                "Open Models",
                "Review the download, license, disk, and compatibility plan.",
            )],
        ),
        Code::ModelLicenseRequired | Code::ModelAccessDenied => (
            Category::Configuration,
            "Model access requires review before this operation can continue.",
            Retry::AfterUserAction,
            vec![Action::new(
                "open-models",
                "Review model",
                "Review the model license and access requirements.",
            )],
        ),
        Code::ProviderNotConfigured => (
            Category::Configuration,
            "The selected remote provider is not configured.",
            Retry::AfterUserAction,
            vec![Action::new(
                "open-provider-settings",
                "Provider settings",
                "Configure credentials without storing them in the media flow.",
            )],
        ),
        Code::RemoteRetryCostRisk => (
            Category::Provider,
            "Retrying could create a duplicate remote charge.",
            Retry::ReconcileFirst,
            vec![Action::new(
                "review-run",
                "Review provider job",
                "Reconcile the original provider request before approving a new paid attempt.",
            )],
        ),
        Code::ProviderRateLimited => (
            Category::Provider,
            "The media provider is rate limiting requests.",
            Retry::RetrySafe,
            vec![Action::new(
                "retry",
                "Retry safely",
                "Retry after the provider backoff window.",
            )],
        ),
        Code::ProviderQuotaExceeded => (
            Category::Provider,
            "The media provider quota has been exceeded.",
            Retry::AfterUserAction,
            vec![Action::new(
                "open-provider-settings",
                "Provider settings",
                "Review account quota or select another configured provider.",
            )],
        ),
        Code::ProviderRequestFailed => (
            Category::Provider,
            "The remote provider did not complete the media request.",
            Retry::UserApprovalRequired,
            vec![Action::new(
                "review-run",
                "Review provider job",
                "Inspect the terminal provider state and cost record before creating a new attempt.",
            )],
        ),
        Code::RemoteOutputExpired => (
            Category::Provider,
            "The remote result expired before it could be ingested.",
            Retry::UserApprovalRequired,
            vec![Action::new(
                "review-run",
                "Review rerun",
                "Review cost and inputs before creating a replacement provider request.",
            )],
        ),
        Code::RemoteUploadNotAllowed => (
            Category::Configuration,
            "Workspace policy does not allow the required remote upload.",
            Retry::AfterUserAction,
            vec![Action::new(
                "review-input",
                "Use a local route",
                "Select local execution or explicitly review the remote upload manifest.",
            )],
        ),
        Code::Oom => (
            Category::Resource,
            "Not enough memory. Close other GPU applications, reduce dimensions, or choose a smaller model, then retry.",
            Retry::AfterUserAction,
            vec![Action::new(
                "open-models",
                "Choose a smaller model",
                "Select a model that needs less memory.",
            )],
        ),
        Code::WorkerCrashed | Code::WorkerTimeout => (
            Category::Resource,
            "The isolated media worker did not complete successfully.",
            Retry::RetrySafe,
            vec![refresh],
        ),
        Code::UnsupportedDimensions
        | Code::UnsupportedFormat
        | Code::UnsupportedCapability
        | Code::UnsupportedHardware
        | Code::UnsupportedRuntimeVariant
        | Code::UnsupportedAdapter
        | Code::AdapterBaseModelMismatch
        | Code::UnsupportedOptimization
        | Code::OptimizationQualityDrift
        | Code::DriverRuntimeMismatch
        | Code::OptimizedEngineInvalid
        | Code::ContinuityConstraintFailed => (
            Category::Capability,
            "The selected media configuration is not supported.",
            Retry::AfterUserAction,
            vec![Action::new(
                "review-input",
                "Review compatibility",
                "Choose a compatible model, runtime, dimensions, format, or adapter set.",
            )],
        ),
        Code::SafetyRejectedInput | Code::SafetyRejectedOutput => (
            Category::Safety,
            "A safety policy rejected this media operation.",
            Retry::AfterUserAction,
            vec![Action::new(
                "review-input",
                "Review request",
                "Revise the input while preserving the safety decision in run history.",
            )],
        ),
        Code::ProvenanceAttachFailed
        | Code::ProvenanceVerifyFailed
        | Code::WatermarkDetectionFailed
        | Code::OutputValidationFailed => (
            Category::Integrity,
            "The output did not pass integrity verification.",
            Retry::RetrySafe,
            vec![refresh],
        ),
        Code::ExportFailed => (
            Category::Storage,
            "The verified media export could not be completed.",
            Retry::RetrySafe,
            vec![Action::new(
                "choose-location",
                "Choose another location",
                "Check destination permissions and choose another path if needed.",
            )],
        ),
        Code::CancelledByUser => (
            Category::Cancellation,
            "The media operation was canceled.",
            Retry::Never,
            Vec::new(),
        ),
        Code::ProviderModelDeprecated
        | Code::ProviderModelRemoved
        | Code::ProviderLifecycleUnknown
        | Code::ProviderRegionUnsupported
        | Code::ProviderFeatureUiOnly => (
            Category::Lifecycle,
            "The selected provider model is not currently runnable.",
            Retry::AfterUserAction,
            vec![Action::new(
                "open-models",
                "Review models",
                "Choose an active API model with a current capability snapshot.",
            )],
        ),
        Code::TrainingDatasetInvalid | Code::TrainingInterrupted => (
            Category::Validation,
            "The training operation needs review.",
            Retry::AfterUserAction,
            vec![Action::new(
                "review-input",
                "Review training data",
                "Validate the dataset and runtime before retrying.",
            )],
        ),
        Code::InternalError => (
            Category::Internal,
            "Media Studio could not complete the operation.",
            Retry::RetrySafe,
            vec![refresh],
        ),
    }
}

fn sanitize_diagnostic(diagnostic: &str) -> String {
    let mut result = diagnostic
        .split_whitespace()
        .map(|token| {
            if token.starts_with("https://") || token.starts_with("http://") {
                token.split(['?', '#']).next().unwrap_or("[redacted-url]")
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if result.chars().count() > 2_000 {
        result = result.chars().take(1_999).collect::<String>();
        result.push('…');
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn civitai_download_errors_keep_the_recovery_instruction() {
        let diagnostic = "Civitai denied this download. Save an API key with access to this model in Settings, then try again.";
        let error = super::MediaError::from_internal("media_download_civitai_resource", diagnostic);
        assert_eq!(error.code, super::MediaErrorCode::ModelAccessDenied);
        assert_eq!(error.message, diagnostic);
        let error = super::MediaError::from_internal(
            "media_download_civitai_resource",
            "The Media Studio model volume does not have enough free space",
        );
        assert_eq!(error.code, super::MediaErrorCode::DiskFull);
    }

    use super::*;

    #[test]
    fn gpu_memory_errors_offer_recovery_without_matching_unrelated_words() {
        for diagnostic in [
            "CUDA out of memory",
            "HIP out of memory",
            "MPS backend out of memory",
            "torch.OutOfMemoryError",
            "hipErrorOutOfMemory",
            "OOM",
        ] {
            let error = MediaError::from_internal("media_generate_images", diagnostic);
            assert_eq!(error.code, MediaErrorCode::Oom);
            assert_eq!(error.retryability, MediaErrorRetryability::AfterUserAction);
            assert!(error.message.contains("reduce dimensions"));
        }
        assert_ne!(
            MediaError::from_internal("media_generate_images", "Could not generate a room image")
                .code,
            MediaErrorCode::Oom
        );
    }

    #[test]
    fn startup_safety_notices_do_not_hide_generation_device_errors() {
        let error = MediaError::from_internal("media_generate_image", "Cannot generate a cpu:0 tensor from a generator of type cuda.\nWorker diagnostics (tail):\nYou have disabled the safety checker.");
        assert_eq!(error.code, MediaErrorCode::DriverRuntimeMismatch);
        let safety = MediaError::from_internal("media_generate_image", "safety rejected output");
        assert_eq!(safety.code, MediaErrorCode::SafetyRejectedOutput);
    }

    #[test]
    fn quality_gate_rejection_preserves_measurements_and_requires_review() {
        for diagnostic in [
            "Quality gate failed after 2 attempts: width is 512px; requires 1024px",
            "Quality gate stopped: width is 512px; requires 1024px",
        ] {
            let error = MediaError::from_internal("run_execution", diagnostic);
            assert_eq!(error.code, MediaErrorCode::QualityGateFailed);
            assert_eq!(error.category, MediaErrorCategory::Validation);
            assert_eq!(error.retryability, MediaErrorRetryability::AfterUserAction);
            assert!(error.message.contains("512px; requires 1024px"));
            assert!(error
                .message
                .ends_with("Review the image and gate settings."));
        }
    }

    #[test]
    fn classifies_paid_retry_as_reconcile_first() {
        let error = MediaError::from_internal(
            "media_resolve_provider_review",
            "retry would duplicate a paid remote charge after acceptance",
        );
        assert_eq!(error.code, MediaErrorCode::RemoteRetryCostRisk);
        assert_eq!(error.retryability, MediaErrorRetryability::ReconcileFirst);
        assert_eq!(error.suggested_actions[0].id, "review-run");
    }

    #[test]
    fn classifies_stale_flow_heads_as_reconcile_first() {
        let error = MediaError::from_internal(
            "media_save_flow_revision",
            "flow revision conflict: expected head old does not match current head new",
        );
        assert_eq!(error.code, MediaErrorCode::FlowRevisionConflict);
        assert_eq!(error.category, MediaErrorCategory::Integrity);
        assert_eq!(error.retryability, MediaErrorRetryability::ReconcileFirst);
        assert_eq!(error.suggested_actions[0].id, "refresh");
    }

    #[test]
    fn strips_signed_url_queries_and_bounds_diagnostics() {
        let long_tail = "x".repeat(2_100);
        let error = MediaError::from_internal(
            "media_import_image",
            format!("download failed at https://example.test/result.png?secret=token {long_tail}"),
        );
        assert!(!error.technical_diagnostic.contains("secret=token"));
        assert!(error.technical_diagnostic.chars().count() <= 2_000);
    }

    #[test]
    fn retains_explicit_run_partial_output_context() {
        let error = MediaError::from_internal("run_execution", "worker crashed")
            .with_run_id("run-1")
            .with_partial_outputs(true);
        assert_eq!(error.context.run_id.as_deref(), Some("run-1"));
        assert!(error.partial_outputs_exist);
    }

    #[test]
    fn serializes_the_versioned_ipc_error_contract() {
        let value = serde_json::to_value(MediaError::from_internal(
            "media_get_run_detail",
            "media run missing was not found",
        ))
        .unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["code"], "RESOURCE_NOT_FOUND");
        assert_eq!(value["context"]["nodeId"], serde_json::Value::Null);
        assert_eq!(value["context"]["operation"], "media_get_run_detail");
        assert_eq!(value["retryability"], "after-user-action");
        assert_eq!(value["partialOutputsExist"], false);
        assert_eq!(value["suggestedActions"][0]["id"], "refresh");
    }
}
