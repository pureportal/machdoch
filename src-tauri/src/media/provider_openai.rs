use std::{io::Cursor, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::{ImageFormat, ImageReader, Limits};
use reqwest::{multipart, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::{
    flow::RemoteImageEditFlowPlan,
    subject_cutout::{self, SubjectCutoutSummary},
    transform, GenerateMediaImagesRequest, MediaProviderPolicySnapshot, MediaResult,
    MediaRuntimePaths,
};

const OPENAI_IMAGES_ENDPOINT: &str = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_EDITS_ENDPOINT: &str = "https://api.openai.com/v1/images/edits";
const OPENAI_IMAGE_MODEL: &str = "gpt-image-2-2026-04-21";
const ADAPTER_ID: &str = "openai.images";
const ADAPTER_VERSION: &str = "1.0.0";
const ENDPOINT_VERSION: &str = "gpt-image-2-2026-04-21";
const MAX_RESPONSE_BYTES: usize = 360 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_DIMENSION: u32 = 3_840;
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct GeneratedImageAsset {
    pub(crate) digest: String,
    pub(crate) relative_path: String,
    pub(crate) byte_size: u64,
    pub(crate) mime_type: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) output_index: u32,
    pub(crate) subject_cutout: Option<SubjectCutoutSummary>,
}

#[derive(Debug)]
pub(crate) struct GeneratedImageBatch {
    pub(crate) assets: Vec<GeneratedImageAsset>,
    pub(crate) provider_request_id: Option<String>,
}

#[derive(Debug)]
pub(crate) struct OpenAiGenerationFailure {
    pub(crate) diagnostic: String,
    pub(crate) acceptance_unknown: bool,
    pub(crate) provider_request_id: Option<String>,
}

impl OpenAiGenerationFailure {
    fn rejected(diagnostic: String, provider_request_id: Option<String>) -> Self {
        Self {
            diagnostic,
            acceptance_unknown: false,
            provider_request_id,
        }
    }

    fn unknown(diagnostic: String, provider_request_id: Option<String>) -> Self {
        Self {
            diagnostic,
            acceptance_unknown: true,
            provider_request_id,
        }
    }
}

#[derive(Debug, Serialize)]
struct OpenAiImageGenerationRequest<'a> {
    model: &'static str,
    prompt: String,
    n: u32,
    size: &'static str,
    quality: &'static str,
    output_format: &'a str,
    background: &'static str,
}

#[derive(Debug, Serialize)]
struct OpenAiImageEditDigestRequest<'a> {
    model: &'static str,
    prompt: &'a str,
    n: u32,
    size: &'static str,
    quality: &'static str,
    output_format: &'a str,
    background: &'static str,
    images: Vec<OpenAiImageEditDigestSource<'a>>,
}

#[derive(Debug, Serialize)]
struct OpenAiImageEditDigestSource<'a> {
    upload_digest: &'a str,
    upload_byte_size: u64,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageGenerationResponse {
    #[serde(default)]
    data: Vec<OpenAiImageData>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageData {
    b64_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorEnvelope {
    error: OpenAiErrorBody,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorBody {
    message: String,
}

pub(crate) async fn generate(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaImagesRequest,
    api_key: &str,
) -> Result<GeneratedImageBatch, OpenAiGenerationFailure> {
    let client = create_client()?;
    let response = client
        .post(OPENAI_IMAGES_ENDPOINT)
        .bearer_auth(api_key)
        .json(&provider_request(request))
        .send()
        .await;
    ingest_response(
        paths,
        response,
        request.output_count,
        &request.output_format,
        request.transparent_background,
        &request.subject_cutout_model_priority,
    )
    .await
}

pub(crate) async fn edit(
    paths: &MediaRuntimePaths,
    plan: &mut RemoteImageEditFlowPlan,
    api_key: &str,
) -> Result<GeneratedImageBatch, OpenAiGenerationFailure> {
    let client = create_client()?;
    let mut form = multipart::Form::new()
        .text("model", OPENAI_IMAGE_MODEL)
        .text("prompt", plan.provider_prompt.clone())
        .text("n", plan.output_count.to_string())
        .text("size", image_size(&plan.aspect_ratio))
        .text("quality", image_quality(&plan.model_policy))
        .text("output_format", plan.output_format.clone())
        .text("background", "opaque");
    for (index, source) in plan.sources.iter_mut().enumerate() {
        let filename = format!("reference-{:02}-{}.png", index + 1, source.role);
        let bytes = std::mem::take(&mut source.upload_bytes);
        let part = multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str("image/png")
            .map_err(|error| {
                OpenAiGenerationFailure::rejected(
                    format!("failed to prepare OpenAI image edit upload: {error}"),
                    None,
                )
            })?;
        form = form.part("image[]", part);
    }
    let response = client
        .post(OPENAI_IMAGE_EDITS_ENDPOINT)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await;
    ingest_response(
        paths,
        response,
        plan.output_count,
        &plan.output_format,
        plan.transparent_background,
        &plan.subject_cutout_model_priority,
    )
    .await
}

fn create_client() -> Result<Client, OpenAiGenerationFailure> {
    Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| {
            OpenAiGenerationFailure::rejected(
                format!("failed to create OpenAI image client: {error}"),
                None,
            )
        })
}

async fn ingest_response(
    paths: &MediaRuntimePaths,
    response: Result<Response, reqwest::Error>,
    output_count: u32,
    output_format: &str,
    transparent_background: bool,
    subject_cutout_model_priority: &[String],
) -> Result<GeneratedImageBatch, OpenAiGenerationFailure> {
    let response = response.map_err(classify_submission_error)?;

    let status = response.status();
    let provider_request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if !status.is_success() {
        let diagnostic = read_provider_error(response, status).await;
        return Err(if status.is_server_error() {
            OpenAiGenerationFailure::unknown(diagnostic, provider_request_id)
        } else {
            OpenAiGenerationFailure::rejected(diagnostic, provider_request_id)
        });
    }

    let response_bytes = read_response_bytes(response, MAX_RESPONSE_BYTES)
        .await
        .map_err(|diagnostic| {
            OpenAiGenerationFailure::unknown(diagnostic, provider_request_id.clone())
        })?;
    let parsed = serde_json::from_slice::<OpenAiImageGenerationResponse>(&response_bytes).map_err(
        |error| {
            OpenAiGenerationFailure::unknown(
                format!("OpenAI provider failed to return a valid image response: {error}"),
                provider_request_id.clone(),
            )
        },
    )?;
    if parsed.data.len() != output_count as usize {
        return Err(OpenAiGenerationFailure::unknown(
            format!(
                "OpenAI provider failed to return the requested image count: received {} after requesting {}",
                parsed.data.len(),
                output_count
            ),
            provider_request_id,
        ));
    }

    let mut assets = Vec::with_capacity(parsed.data.len());
    for (index, image) in parsed.data.into_iter().enumerate() {
        let encoded = image
            .b64_json
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                OpenAiGenerationFailure::unknown(
                    format!(
                        "OpenAI provider failed to return image data for output {}",
                        index + 1
                    ),
                    provider_request_id.clone(),
                )
            })?;
        if encoded.len() > max_base64_len(MAX_IMAGE_BYTES) {
            return Err(OpenAiGenerationFailure::unknown(
                format!(
                    "OpenAI provider failed output validation: output {} exceeds the {} MB image limit",
                    index + 1,
                    MAX_IMAGE_BYTES / 1024 / 1024
                ),
                provider_request_id,
            ));
        }
        let mut bytes = BASE64_STANDARD.decode(encoded).map_err(|error| {
            OpenAiGenerationFailure::unknown(
                format!(
                    "OpenAI provider failed output validation for image {}: {error}",
                    index + 1
                ),
                provider_request_id.clone(),
            )
        })?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(OpenAiGenerationFailure::unknown(
                format!(
                    "OpenAI provider failed output validation: output {} has an invalid encoded size",
                    index + 1
                ),
                provider_request_id,
            ));
        }
        validate_image(&bytes, output_format, index).map_err(|diagnostic| {
            OpenAiGenerationFailure::unknown(diagnostic, provider_request_id.clone())
        })?;
        let subject_cutout = if transparent_background {
            let cutout_paths = paths.clone();
            let cutout_source = std::mem::take(&mut bytes);
            let cutout_format = output_format.to_string();
            let model_priority = subject_cutout_model_priority.to_vec();
            let transparent = tauri::async_runtime::spawn_blocking(move || {
                subject_cutout::cutout_encoded(
                    &cutout_paths,
                    &cutout_source,
                    &cutout_format,
                    &model_priority,
                )
            })
            .await
            .map_err(|error| {
                OpenAiGenerationFailure::unknown(
                    format!(
                        "OpenAI output {} subject-cutout worker failed: {error}",
                        index + 1
                    ),
                    provider_request_id.clone(),
                )
            })?
            .map_err(|diagnostic| {
                    OpenAiGenerationFailure::unknown(
                        format!(
                            "OpenAI output {} could not be converted to a transparent image: {diagnostic}",
                            index + 1
                        ),
                        provider_request_id.clone(),
                    )
                })?;
            bytes = transparent.bytes;
            Some(transparent.summary)
        } else {
            None
        };
        let validated = validate_image(&bytes, output_format, index).map_err(|diagnostic| {
            OpenAiGenerationFailure::unknown(diagnostic, provider_request_id.clone())
        })?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative_path = transform::cas_relative_path(&digest);
        transform::publish_cas_bytes(paths, &relative_path, &digest, &bytes).map_err(
            |diagnostic| OpenAiGenerationFailure::unknown(diagnostic, provider_request_id.clone()),
        )?;
        assets.push(GeneratedImageAsset {
            digest,
            relative_path: relative_path.to_string_lossy().into_owned(),
            byte_size: bytes.len() as u64,
            mime_type: validated.mime_type,
            width: validated.width,
            height: validated.height,
            output_index: index as u32,
            subject_cutout,
        });
    }

    Ok(GeneratedImageBatch {
        assets,
        provider_request_id,
    })
}

fn classify_submission_error(error: reqwest::Error) -> OpenAiGenerationFailure {
    let diagnostic = if error.is_connect() {
        format!("OpenAI could not be reached before the request was accepted: {error}")
    } else {
        format!(
            "OpenAI request acceptance is unknown; retry could create a duplicate provider charge: {error}"
        )
    };
    if error.is_connect() {
        OpenAiGenerationFailure::rejected(diagnostic, None)
    } else {
        OpenAiGenerationFailure::unknown(diagnostic, None)
    }
}

fn provider_request(request: &GenerateMediaImagesRequest) -> OpenAiImageGenerationRequest<'_> {
    OpenAiImageGenerationRequest {
        model: OPENAI_IMAGE_MODEL,
        prompt: request.prompt.clone(),
        n: request.output_count,
        size: image_size(&request.aspect_ratio),
        quality: image_quality(&request.model_policy),
        output_format: &request.output_format,
        background: "opaque",
    }
}

pub(crate) fn request_digest(request: &GenerateMediaImagesRequest) -> MediaResult<String> {
    let encoded = serde_json::to_vec(&serde_json::json!({
        "providerRequest": provider_request(request),
        "subjectCutout": request.transparent_background,
        "subjectCutoutModelPriority": &request.subject_cutout_model_priority,
    }))
    .map_err(|error| format!("failed to canonicalize OpenAI image request: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(crate) fn edit_request_digest(plan: &RemoteImageEditFlowPlan) -> MediaResult<String> {
    let encoded = serde_json::to_vec(&serde_json::json!({
        "providerRequest": edit_digest_request(plan),
        "subjectCutoutModelPriority": &plan.subject_cutout_model_priority,
    }))
    .map_err(|error| format!("failed to canonicalize OpenAI image edit request: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn edit_digest_request(plan: &RemoteImageEditFlowPlan) -> OpenAiImageEditDigestRequest<'_> {
    OpenAiImageEditDigestRequest {
        model: OPENAI_IMAGE_MODEL,
        prompt: &plan.provider_prompt,
        n: plan.output_count,
        size: image_size(&plan.aspect_ratio),
        quality: image_quality(&plan.model_policy),
        output_format: &plan.output_format,
        background: "opaque",
        images: plan
            .sources
            .iter()
            .map(|source| OpenAiImageEditDigestSource {
                upload_digest: &source.upload_digest,
                upload_byte_size: source.upload_byte_size,
            })
            .collect(),
    }
}

pub(crate) fn policy_snapshot() -> MediaProviderPolicySnapshot {
    MediaProviderPolicySnapshot {
        adapter_id: ADAPTER_ID.to_string(),
        adapter_version: ADAPTER_VERSION.to_string(),
        endpoint_version: ENDPOINT_VERSION.to_string(),
        region: "OpenAI-managed".to_string(),
        idempotency_mode: "none".to_string(),
        retry_policy: "The Images API does not document an idempotency key or request lookup for this operation. Possible acceptance is quarantined for explicit review and never resubmitted automatically.".to_string(),
        cancellation_semantics: "The synchronous Images API request cannot be cancelled after provider acceptance; a completed response is ingested immediately.".to_string(),
        input_retention_seconds: None,
        output_retention_seconds: None,
        output_visibility: "inline-base64-response".to_string(),
        public_links: false,
        no_store_requested: false,
        upload_asset_count: 0,
        upload_bytes: 0,
        contains_personal_data: false,
        remote_upload_allowed: true,
    }
}

pub(crate) fn edit_policy_snapshot(plan: &RemoteImageEditFlowPlan) -> MediaProviderPolicySnapshot {
    let mut policy = policy_snapshot();
    policy.upload_asset_count = plan.sources.len() as u32;
    policy.upload_bytes = plan.upload_bytes;
    policy
}

pub(crate) struct ValidatedImage {
    pub(crate) mime_type: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn validate_image(
    bytes: &[u8],
    output_format: &str,
    output_index: usize,
) -> MediaResult<ValidatedImage> {
    let expected_format = match output_format {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        "webp" => ImageFormat::WebP,
        _ => {
            return Err("OpenAI provider failed: image output format is not supported".to_string())
        }
    };
    let guessed = image::guess_format(bytes).map_err(|error| {
        format!(
            "OpenAI provider failed output validation: output {} is not a recognized image: {error}",
            output_index + 1
        )
    })?;
    if guessed != expected_format {
        return Err(format!(
            "OpenAI provider failed output validation: output {} did not match the requested format",
            output_index + 1
        ));
    }

    let mut reader = ImageReader::with_format(Cursor::new(bytes), expected_format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|error| {
        format!(
            "OpenAI provider failed bounded image validation for output {}: {error}",
            output_index + 1
        )
    })?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err(format!(
            "OpenAI provider failed output validation: output {} has invalid dimensions",
            output_index + 1
        ));
    }
    Ok(ValidatedImage {
        mime_type: match expected_format {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
            _ => unreachable!(),
        },
        width,
        height,
    })
}

fn image_size(aspect_ratio: &str) -> &'static str {
    match aspect_ratio {
        "4:5" => "1024x1280",
        "16:9" => "1536x864",
        "9:16" => "864x1536",
        _ => "1024x1024",
    }
}

fn image_quality(model_policy: &str) -> &'static str {
    match model_policy {
        "fast" => "low",
        "quality" => "high",
        _ => "medium",
    }
}

fn max_base64_len(decoded_size: usize) -> usize {
    decoded_size.div_ceil(3).saturating_mul(4)
}

async fn read_response_bytes(mut response: Response, max_bytes: usize) -> MediaResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(
            "OpenAI provider failed: response exceeds the bounded download limit".to_string(),
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("failed to read OpenAI provider response: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(
                "OpenAI provider failed: response exceeds the bounded download limit".to_string(),
            );
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_provider_error(response: Response, status: StatusCode) -> String {
    let raw = read_response_bytes(response, MAX_ERROR_BYTES)
        .await
        .unwrap_or_default();
    let message = serde_json::from_slice::<OpenAiErrorEnvelope>(&raw)
        .map(|parsed| parsed.error.message)
        .unwrap_or_else(|_| String::from_utf8_lossy(&raw).trim().to_string());
    let message = if message.is_empty() {
        status.to_string()
    } else {
        format!("{status}: {message}")
    };

    if status == StatusCode::TOO_MANY_REQUESTS {
        if message.to_ascii_lowercase().contains("quota") {
            return format!("OpenAI provider quota exceeded: {message}");
        }
        return format!("OpenAI provider rate limit reached: {message}");
    }
    if status.is_server_error() {
        return format!(
            "OpenAI request acceptance is unknown; retry could create a duplicate provider charge: {message}"
        );
    }
    format!("OpenAI provider rejected the image request: {message}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::media::{
        flow::{RemoteImageEditFlowPlan, RemoteImageEditSource},
        MediaRunPlanNodeSnapshot, MediaRunPlanSnapshot, MediaRunPlanStepSnapshot,
    };

    fn request() -> GenerateMediaImagesRequest {
        GenerateMediaImagesRequest {
            schema_version: 1,
            run_id: "run:test".to_string(),
            flow_id: "flow:test".to_string(),
            flow_revision_id: "revision:test".to_string(),
            flow_name: "Test flow".to_string(),
            plan_id: "plan:test".to_string(),
            prompt: "A precise architectural model".to_string(),
            model_id: "openai:gpt-image-2".to_string(),
            model_label: "GPT Image 2".to_string(),
            output_count: 3,
            diagnostic_count: 0,
            aspect_ratio: "16:9".to_string(),
            output_format: "webp".to_string(),
            model_policy: "quality".to_string(),
            model_addons: Vec::new(),
            transparent_background: false,
            subject_cutout_model_priority: Vec::new(),
            plan_snapshot: MediaRunPlanSnapshot {
                schema_version: 1,
                plan_id: "plan:test".to_string(),
                flow_id: "flow:test".to_string(),
                flow_fingerprint: "digest".to_string(),
                compiled_at: "2026-07-14T00:00:00.000Z".to_string(),
                nodes: vec![MediaRunPlanNodeSnapshot {
                    id: "generate".to_string(),
                    r#type: "task.generate-image".to_string(),
                    label: "Generate".to_string(),
                    layer: "task".to_string(),
                }],
                steps: vec![MediaRunPlanStepSnapshot {
                    id: "provider.generate".to_string(),
                    source_node_id: "generate".to_string(),
                    kind: "provider-request".to_string(),
                    label: "Generate".to_string(),
                    target: "remote".to_string(),
                    cacheable: false,
                    side_effect: None,
                    review: None,
                }],
            },
        }
    }

    #[test]
    fn maps_gpt_image_2_request_without_hidden_shape_conversion() {
        let request = request();
        let mapped = serde_json::to_value(provider_request(&request)).unwrap();
        assert_eq!(
            mapped,
            json!({
                "model": "gpt-image-2-2026-04-21",
                "prompt": "A precise architectural model",
                "n": 3,
                "size": "1536x864",
                "quality": "high",
                "output_format": "webp",
                "background": "opaque"
            })
        );
        assert_eq!(image_size("4:5"), "1024x1280");
        assert_eq!(image_size("9:16"), "864x1536");
        assert_eq!(image_quality("fast"), "low");
        assert_eq!(image_quality("balanced"), "medium");
    }

    #[test]
    fn rejects_model_addons_before_openai_submission() {
        let mut request = request();
        request.model_addons = vec![crate::media::MediaModelAddonSelection::Lora {
            addon_id: "addon:lora:test".to_string(),
            enabled: true,
            model_strength: 1.0,
            text_encoder_strength: None,
            denoising_schedule: None,
        }];

        assert!(request
            .validate()
            .expect_err("OpenAI add-ons must be rejected")
            .contains("does not accept LoRA"));
    }

    #[test]
    fn transparent_output_keeps_the_user_prompt_and_changes_the_replay_digest() {
        let opaque = request();
        let mut transparent = opaque.clone();
        transparent.transparent_background = true;
        transparent.subject_cutout_model_priority = vec![
            subject_cutout::BIREFNET_MODEL_ID.to_string(),
            subject_cutout::BORDER_MATTE_MODEL_ID.to_string(),
        ];

        let mapped = serde_json::to_value(provider_request(&transparent)).unwrap();
        assert_eq!(mapped["background"], "opaque");
        assert_eq!(mapped["prompt"], opaque.prompt.as_str());
        assert_ne!(
            request_digest(&opaque).unwrap(),
            request_digest(&transparent).unwrap()
        );
    }

    #[test]
    fn request_digest_is_replay_stable_and_covers_billed_parameters() {
        let original = request();
        let mut changed = original.clone();
        changed.output_count = 4;
        assert_eq!(
            request_digest(&original).unwrap(),
            request_digest(&original).unwrap()
        );
        assert_ne!(
            request_digest(&original).unwrap(),
            request_digest(&changed).unwrap()
        );
    }

    fn edit_plan() -> RemoteImageEditFlowPlan {
        RemoteImageEditFlowPlan {
            flow_id: "flow:edit".to_string(),
            flow_name: "Edit".to_string(),
            revision_id: "revision:edit".to_string(),
            prompt: "Place the subject in the base scene".to_string(),
            provider_prompt: "Place the subject in the base scene\n\nMachdoch reference guidance"
                .to_string(),
            task_node_id: "edit".to_string(),
            model_id: "openai:gpt-image-2".to_string(),
            model_label: "GPT Image 2".to_string(),
            output_count: 2,
            aspect_ratio: "4:5".to_string(),
            output_format: "png".to_string(),
            model_policy: "balanced".to_string(),
            transparent_background: false,
            subject_cutout_model_priority: Vec::new(),
            edit_strength: 0.65,
            sources: vec![
                RemoteImageEditSource {
                    node_id: "base".to_string(),
                    asset_id: "asset:base".to_string(),
                    role: "base".to_string(),
                    influence: 1.0,
                    source_digest: "a".repeat(64),
                    upload_digest: "b".repeat(64),
                    upload_byte_size: 12,
                    upload_bytes: vec![1; 12],
                    width: 64,
                    height: 64,
                },
                RemoteImageEditSource {
                    node_id: "style".to_string(),
                    asset_id: "asset:style".to_string(),
                    role: "style".to_string(),
                    influence: 0.4,
                    source_digest: "c".repeat(64),
                    upload_digest: "d".repeat(64),
                    upload_byte_size: 8,
                    upload_bytes: vec![2; 8],
                    width: 32,
                    height: 32,
                },
            ],
            upload_bytes: 20,
        }
    }

    #[test]
    fn maps_gpt_image_2_edit_without_unsupported_fidelity_or_private_bytes() {
        let plan = edit_plan();
        let mapped = serde_json::to_value(edit_digest_request(&plan)).unwrap();
        assert_eq!(
            mapped,
            json!({
                "model": "gpt-image-2-2026-04-21",
                "prompt": plan.provider_prompt.clone(),
                "n": 2,
                "size": "1024x1280",
                "quality": "medium",
                "output_format": "png",
                "background": "opaque",
                "images": [
                    {"upload_digest": "b".repeat(64), "upload_byte_size": 12},
                    {"upload_digest": "d".repeat(64), "upload_byte_size": 8}
                ]
            })
        );
        assert!(mapped.get("input_fidelity").is_none());
        assert!(!serde_json::to_string(&mapped)
            .unwrap()
            .contains("asset:base"));
        let policy = edit_policy_snapshot(&plan);
        assert_eq!(policy.upload_asset_count, 2);
        assert_eq!(policy.upload_bytes, 20);
        assert_eq!(policy.input_retention_seconds, None);
        assert_eq!(policy.output_retention_seconds, None);
    }

    #[test]
    fn edit_digest_changes_with_ordered_upload_bytes_and_paid_output_count() {
        let original = edit_plan();
        let mut reordered = original.clone();
        reordered.sources.swap(0, 1);
        let mut more_outputs = original.clone();
        more_outputs.output_count = 3;
        assert_eq!(
            edit_request_digest(&original).unwrap(),
            edit_request_digest(&original).unwrap()
        );
        assert_ne!(
            edit_request_digest(&original).unwrap(),
            edit_request_digest(&reordered).unwrap()
        );
        assert_ne!(
            edit_request_digest(&original).unwrap(),
            edit_request_digest(&more_outputs).unwrap()
        );
    }
}
