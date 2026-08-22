use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::{redirect::Policy, Client, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncWriteExt as _;

use super::{
    database, hardware, model_addon, model_import, MediaModelAddonImportInspection, MediaResult,
    MediaRuntimePaths,
};

const API_ORIGIN: &str = "https://civitai.com";
const MAX_API_RESPONSE_BYTES: usize = 8 * 1_024 * 1_024;
const MAX_ADDON_BYTES: u64 = 4 * 1_024 * 1_024 * 1_024;
const MAX_SOURCE_CHARS: usize = 2_048;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaCivitaiModelAddonFileInspection {
    id: u64,
    name: String,
    byte_size: u64,
    sha256: String,
    pickle_scan_result: String,
    virus_scan_result: String,
    scanned_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaCivitaiLicenseClaims {
    allow_no_credit: Option<bool>,
    allow_commercial_use: Option<Vec<String>>,
    allow_derivatives: Option<bool>,
    allow_different_license: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaCivitaiModelAddonInspection {
    schema_version: u32,
    can_download: bool,
    blocking_reason: Option<String>,
    review_token: String,
    observed_at: String,
    source_url: String,
    air: Option<String>,
    model_id: u64,
    version_id: u64,
    model_name: String,
    version_name: String,
    kind: Option<String>,
    base_model: Option<String>,
    suggested_architecture: Option<String>,
    trained_words: Vec<String>,
    creator: Option<String>,
    nsfw: bool,
    poi: bool,
    availability: Option<String>,
    status: Option<String>,
    file: Option<MediaCivitaiModelAddonFileInspection>,
    license_claims: MediaCivitaiLicenseClaims,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCivitaiSourceMetadata {
    provider: String,
    metadata: MediaCivitaiModelAddonInspection,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadMediaCivitaiModelAddonRequest {
    source: String,
    review_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceSelector {
    model_id: Option<u64>,
    version_id: Option<u64>,
    declared_kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CivitaiCreator {
    username: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CivitaiModelVersionSummary {
    id: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CivitaiModelResponse {
    id: u64,
    name: String,
    #[serde(rename = "type")]
    model_type: String,
    #[serde(default)]
    nsfw: bool,
    #[serde(default)]
    poi: bool,
    creator: Option<CivitaiCreator>,
    availability: Option<String>,
    allow_no_credit: Option<bool>,
    allow_commercial_use: Option<Value>,
    allow_derivatives: Option<bool>,
    allow_different_license: Option<bool>,
    #[serde(default)]
    model_versions: Vec<CivitaiModelVersionSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CivitaiFileMetadata {
    format: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
struct CivitaiFileHashes {
    sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CivitaiFile {
    id: u64,
    name: String,
    #[serde(rename = "type")]
    file_type: String,
    size_kb: f64,
    #[serde(default)]
    primary: bool,
    pickle_scan_result: Option<String>,
    virus_scan_result: Option<String>,
    scanned_at: Option<String>,
    metadata: Option<CivitaiFileMetadata>,
    hashes: Option<CivitaiFileHashes>,
    download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CivitaiModelVersionResponse {
    id: u64,
    model_id: u64,
    name: String,
    base_model: Option<String>,
    #[serde(default)]
    trained_words: Vec<String>,
    air: Option<String>,
    status: Option<String>,
    #[serde(default)]
    files: Vec<CivitaiFile>,
}

#[derive(Debug, Clone)]
struct SelectedFile {
    public: MediaCivitaiModelAddonFileInspection,
    download_url: Url,
}

#[derive(Debug, Clone)]
struct ResolvedInspection {
    public: MediaCivitaiModelAddonInspection,
    selected_file: Option<SelectedFile>,
}

fn parse_u64(value: &str, label: &str) -> MediaResult<u64> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("Civitai {label} must be a positive integer"))
}

fn parse_numeric_air(source: &str) -> MediaResult<Option<SourceSelector>> {
    if !source
        .chars()
        .all(|character| character.is_ascii_digit() || character == '@')
    {
        return Ok(None);
    }
    let values = source.split('@').collect::<Vec<_>>();
    match values.as_slice() {
        [model_id] => Ok(Some(SourceSelector {
            model_id: Some(parse_u64(model_id, "model id")?),
            version_id: None,
            declared_kind: None,
        })),
        [model_id, version_id] => Ok(Some(SourceSelector {
            model_id: Some(parse_u64(model_id, "model id")?),
            version_id: Some(parse_u64(version_id, "version id")?),
            declared_kind: None,
        })),
        _ => Err("Civitai AIR must be a model id or modelId@versionId".to_string()),
    }
}

fn parse_full_air(source: &str) -> MediaResult<Option<SourceSelector>> {
    if !source.to_ascii_lowercase().starts_with("urn:air:") {
        return Ok(None);
    }
    let parts = source.split(':').collect::<Vec<_>>();
    if parts.len() != 6
        || !parts[0].eq_ignore_ascii_case("urn")
        || !parts[1].eq_ignore_ascii_case("air")
    {
        return Err("The Civitai AIR identifier is malformed".to_string());
    }
    if !parts[4].eq_ignore_ascii_case("civitai") {
        return Err("Only Civitai AIR identifiers can be imported here".to_string());
    }
    let declared_kind = match parts[3].to_ascii_lowercase().as_str() {
        "lora" => Some("lora".to_string()),
        "embedding" | "textualinversion" | "textual-inversion" => {
            Some("textual-inversion".to_string())
        }
        _ => {
            return Err(
                "Only LoRA and textual-inversion Civitai AIR identifiers are supported".to_string(),
            )
        }
    };
    let ids = parts[5].split('@').collect::<Vec<_>>();
    if ids.len() != 2 {
        return Err("A full Civitai AIR must include modelId@versionId".to_string());
    }
    Ok(Some(SourceSelector {
        model_id: Some(parse_u64(ids[0], "model id")?),
        version_id: Some(parse_u64(ids[1], "version id")?),
        declared_kind,
    }))
}

fn query_version_id(url: &Url) -> MediaResult<Option<u64>> {
    url.query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("modelVersionId"))
        .map(|(_, value)| parse_u64(value.as_ref(), "version id"))
        .transpose()
}

fn parse_url_source(source: &str) -> MediaResult<SourceSelector> {
    let url = Url::parse(source).map_err(|_| {
        "Enter a Civitai model URL, model id, modelId@versionId, or full AIR identifier".to_string()
    })?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("civitai.com" | "www.civitai.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("Only canonical HTTPS URLs on civitai.com are accepted".to_string());
    }
    let segments = url
        .path_segments()
        .ok_or_else(|| "The Civitai URL has no path".to_string())?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let query_version = query_version_id(&url)?;

    let selector = match segments.as_slice() {
        ["models", model_id, remaining @ ..] => {
            let path_version = remaining
                .windows(2)
                .find(|window| window[0].eq_ignore_ascii_case("versions"))
                .map(|window| parse_u64(window[1], "version id"))
                .transpose()?;
            if path_version.is_some() && query_version.is_some() && path_version != query_version {
                return Err("The Civitai URL contains conflicting version ids".to_string());
            }
            SourceSelector {
                model_id: Some(parse_u64(model_id, "model id")?),
                version_id: path_version.or(query_version),
                declared_kind: None,
            }
        }
        ["model-versions", version_id]
        | ["api", "v1", "model-versions", version_id]
        | ["api", "download", "models", version_id] => SourceSelector {
            model_id: None,
            version_id: Some(parse_u64(version_id, "version id")?),
            declared_kind: None,
        },
        ["api", "v1", "models", model_id] => SourceSelector {
            model_id: Some(parse_u64(model_id, "model id")?),
            version_id: query_version,
            declared_kind: None,
        },
        _ => {
            return Err(
                "The URL must point to a Civitai model, model version, or model download"
                    .to_string(),
            )
        }
    };
    Ok(selector)
}

fn parse_source(source: &str) -> MediaResult<SourceSelector> {
    let source = source.trim();
    if source.is_empty() || source.chars().count() > MAX_SOURCE_CHARS {
        return Err("Civitai source must contain 1 to 2048 characters".to_string());
    }
    if let Some(selector) = parse_numeric_air(source)? {
        return Ok(selector);
    }
    if let Some(selector) = parse_full_air(source)? {
        return Ok(selector);
    }
    parse_url_source(source)
}

fn metadata_client() -> MediaResult<Client> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .user_agent("machdoch-media-studio/1.0")
        .build()
        .map_err(|error| format!("failed to prepare Civitai metadata client: {error}"))
}

async fn fetch_json<T: DeserializeOwned>(client: &Client, url: Url) -> MediaResult<T> {
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Civitai metadata request failed: {error}"))?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(
                "This Civitai item requires authentication or is not publicly downloadable. Download it from Civitai yourself, then use Import LoRA / embedding."
                    .to_string(),
            )
        }
        StatusCode::NOT_FOUND => return Err("The Civitai model or version was not found".to_string()),
        status if !status.is_success() => {
            return Err(format!("Civitai metadata request returned HTTP {status}"))
        }
        _ => {}
    }
    if response
        .content_length()
        .map(|size| size > MAX_API_RESPONSE_BYTES as u64)
        == Some(true)
    {
        return Err("The Civitai metadata response exceeded the 8 MiB safety limit".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("failed while reading Civitai metadata: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_API_RESPONSE_BYTES {
            return Err(
                "The Civitai metadata response exceeded the 8 MiB safety limit".to_string(),
            );
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Civitai returned malformed model metadata: {error}"))
}

fn api_url(path: &str) -> MediaResult<Url> {
    Url::parse(&format!("{API_ORIGIN}{path}"))
        .map_err(|error| format!("failed to build Civitai API URL: {error}"))
}

fn kind_for_model_type(model_type: &str) -> Option<String> {
    match model_type.to_ascii_lowercase().as_str() {
        "lora" => Some("lora".to_string()),
        "textualinversion" | "textual-inversion" | "embedding" => {
            Some("textual-inversion".to_string())
        }
        _ => None,
    }
}

fn architecture_for_base_model(base_model: Option<&str>) -> Option<String> {
    let value = base_model?.to_ascii_lowercase();
    if value.contains("flux.2") || value.contains("flux 2") {
        Some("flux-2".to_string())
    } else if value.contains("flux.1") || value.contains("flux 1") {
        Some("flux-1".to_string())
    } else if value.contains("sdxl")
        || value.contains("stable diffusion xl")
        || value.contains("pony")
        || value.contains("illustrious")
    {
        Some("stable-diffusion-xl".to_string())
    } else if value.contains("sd 3") || value.contains("stable diffusion 3") {
        Some("stable-diffusion-3".to_string())
    } else if value.contains("sd 2") || value.contains("stable diffusion 2") {
        Some("stable-diffusion-2".to_string())
    } else if value.contains("sd 1") || value.contains("stable diffusion 1") {
        Some("stable-diffusion-1".to_string())
    } else {
        None
    }
}

fn commercial_use_claim(value: Option<&Value>) -> Option<Vec<String>> {
    match value? {
        Value::String(value) => Some(vec![value.clone()]),
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect(),
        ),
        _ => None,
    }
}

fn expected_file_size(size_kb: f64) -> Option<u64> {
    let bytes = size_kb * 1_024.0;
    (bytes.is_finite() && bytes >= 1.0 && bytes <= MAX_ADDON_BYTES as f64)
        .then(|| bytes.round() as u64)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn validated_download_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && matches!(url.host_str(), Some("civitai.com" | "www.civitai.com"))
        && url.port().is_none()
        && url.path().starts_with("/api/download/models/"))
    .then_some(url)
}

fn safe_file(file: &CivitaiFile) -> Option<SelectedFile> {
    let byte_size = expected_file_size(file.size_kb)?;
    let sha256 = file
        .hashes
        .as_ref()?
        .sha256
        .as_deref()?
        .to_ascii_lowercase();
    let pickle_scan_result = file.pickle_scan_result.as_deref()?;
    let virus_scan_result = file.virus_scan_result.as_deref()?;
    let format = file.metadata.as_ref()?.format.as_deref()?;
    if !file.file_type.eq_ignore_ascii_case("Model")
        || !file.name.to_ascii_lowercase().ends_with(".safetensors")
        || !format.eq_ignore_ascii_case("SafeTensor")
        || !pickle_scan_result.eq_ignore_ascii_case("Success")
        || !virus_scan_result.eq_ignore_ascii_case("Success")
        || !is_sha256(&sha256)
    {
        return None;
    }
    Some(SelectedFile {
        public: MediaCivitaiModelAddonFileInspection {
            id: file.id,
            name: file.name.clone(),
            byte_size,
            sha256,
            pickle_scan_result: pickle_scan_result.to_string(),
            virus_scan_result: virus_scan_result.to_string(),
            scanned_at: file.scanned_at.clone(),
        },
        download_url: validated_download_url(&file.download_url)?,
    })
}

fn select_file(files: &[CivitaiFile]) -> MediaResult<SelectedFile> {
    let candidates = files
        .iter()
        .filter_map(|file| safe_file(file).map(|selected| (file.primary, selected)))
        .collect::<Vec<_>>();
    let primary = candidates
        .iter()
        .filter(|(is_primary, _)| *is_primary)
        .collect::<Vec<_>>();
    if primary.len() == 1 {
        return Ok(primary[0].1.clone());
    }
    if candidates.len() == 1 {
        return Ok(candidates[0].1.clone());
    }
    if candidates.is_empty() {
        return Err(
            "Civitai did not report a public .safetensors Model file with successful pickle and virus scans, a bounded size, and SHA-256 metadata"
                .to_string(),
        );
    }
    Err(
        "This Civitai version has multiple eligible files and no unique primary file. Choose and download the intended file on Civitai, then import it locally."
            .to_string(),
    )
}

fn review_token(
    model: &CivitaiModelResponse,
    version: &CivitaiModelVersionResponse,
    kind: Option<&str>,
    architecture: Option<&str>,
    file: Option<&SelectedFile>,
    license_claims: &MediaCivitaiLicenseClaims,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-civitai-addon-review-v1\0");
    let commercial_use = license_claims
        .allow_commercial_use
        .as_ref()
        .map(|values| values.join("\u{1f}"))
        .unwrap_or_default();
    let values = [
        model.id.to_string(),
        version.id.to_string(),
        model.name.clone(),
        version.name.clone(),
        kind.unwrap_or("unknown").to_string(),
        version.base_model.clone().unwrap_or_default(),
        architecture.unwrap_or("unknown").to_string(),
        version.trained_words.join("\u{1f}"),
        model.availability.clone().unwrap_or_default(),
        version.status.clone().unwrap_or_default(),
        file.map(|value| value.public.id.to_string())
            .unwrap_or_default(),
        file.map(|value| value.public.name.clone())
            .unwrap_or_default(),
        file.map(|value| value.public.byte_size.to_string())
            .unwrap_or_default(),
        file.map(|value| value.public.sha256.clone())
            .unwrap_or_default(),
        file.map(|value| value.public.pickle_scan_result.clone())
            .unwrap_or_default(),
        file.map(|value| value.public.virus_scan_result.clone())
            .unwrap_or_default(),
        file.map(|value| value.download_url.as_str().to_string())
            .unwrap_or_default(),
        license_claims
            .allow_no_credit
            .map(|value| value.to_string())
            .unwrap_or_default(),
        commercial_use,
        license_claims
            .allow_derivatives
            .map(|value| value.to_string())
            .unwrap_or_default(),
        license_claims
            .allow_different_license
            .map(|value| value.to_string())
            .unwrap_or_default(),
    ];
    for value in values {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

fn build_inspection(
    selector: &SourceSelector,
    model: CivitaiModelResponse,
    version: CivitaiModelVersionResponse,
) -> ResolvedInspection {
    let kind = kind_for_model_type(&model.model_type);
    let architecture = architecture_for_base_model(version.base_model.as_deref());
    let license_claims = MediaCivitaiLicenseClaims {
        allow_no_credit: model.allow_no_credit,
        allow_commercial_use: commercial_use_claim(model.allow_commercial_use.as_ref()),
        allow_derivatives: model.allow_derivatives,
        allow_different_license: model.allow_different_license,
    };
    let selected_file_result = select_file(&version.files);
    let selected_file = selected_file_result.as_ref().ok().cloned();
    let mut blocking_reason = selected_file_result.err();
    if kind.is_none() {
        blocking_reason = Some(format!(
            "Civitai reports this item as {}, not a LoRA or textual-inversion embedding",
            model.model_type
        ));
    } else if selector.declared_kind.as_deref().is_some()
        && selector.declared_kind.as_deref() != kind.as_deref()
    {
        blocking_reason =
            Some("The AIR add-on kind does not match Civitai's current model metadata".to_string());
    } else if architecture.is_none() {
        blocking_reason = Some(
            "This Civitai base model is not mapped to a supported SD or FLUX family. Download the file yourself and use local import only if you can confirm compatibility."
                .to_string(),
        );
    } else if kind.as_deref() == Some("textual-inversion")
        && !matches!(
            architecture.as_deref(),
            Some("stable-diffusion-1" | "stable-diffusion-2" | "stable-diffusion-xl" | "flux-1")
        )
    {
        blocking_reason = Some(format!(
            "{} textual-inversion embeddings are not supported by the managed Diffusers runtime",
            version.base_model.as_deref().unwrap_or("This base model")
        ));
    } else if model
        .availability
        .as_deref()
        .map(|value| !value.eq_ignore_ascii_case("Public"))
        .unwrap_or(true)
    {
        blocking_reason = Some(
            "This Civitai item is not publicly available. Download it while signed in, then import the local safetensors file."
                .to_string(),
        );
    } else if version
        .status
        .as_deref()
        .map(|value| !value.eq_ignore_ascii_case("Published"))
        .unwrap_or(true)
    {
        blocking_reason = Some("This Civitai version is not published".to_string());
    }

    let mut warnings = vec![
        "Civitai scan results and publisher metadata are external claims; the downloaded bytes are independently SHA-256 verified and inspected as safetensors before import."
            .to_string(),
        "The Civitai base-model label is an advisory compatibility hint, not proof that the add-on works with every fine-tuned checkpoint in that family."
            .to_string(),
        "Civitai publisher permissions are not automatically treated as a license. Review the publisher page and confirm your rights in the final import step."
            .to_string(),
    ];
    if model.nsfw {
        warnings.push("Civitai marks this model as NSFW.".to_string());
    }
    if model.poi {
        warnings.push("Civitai marks this model as depicting a real person (POI).".to_string());
    }
    let source_url = format!(
        "https://civitai.com/models/{}?modelVersionId={}",
        model.id, version.id
    );
    let token = review_token(
        &model,
        &version,
        kind.as_deref(),
        architecture.as_deref(),
        selected_file.as_ref(),
        &license_claims,
    );
    ResolvedInspection {
        public: MediaCivitaiModelAddonInspection {
            schema_version: 1,
            can_download: blocking_reason.is_none(),
            blocking_reason,
            review_token: token,
            observed_at: database::now(),
            source_url,
            air: version.air.clone(),
            model_id: model.id,
            version_id: version.id,
            model_name: model.name,
            version_name: version.name,
            kind,
            base_model: version.base_model,
            suggested_architecture: architecture,
            trained_words: version.trained_words,
            creator: model.creator.map(|creator| creator.username),
            nsfw: model.nsfw,
            poi: model.poi,
            availability: model.availability,
            status: version.status,
            file: selected_file.as_ref().map(|file| file.public.clone()),
            license_claims,
            warnings,
        },
        selected_file,
    }
}

async fn resolve_source(source: &str) -> MediaResult<ResolvedInspection> {
    let selector = parse_source(source)?;
    let client = metadata_client()?;
    let mut model = if let Some(model_id) = selector.model_id {
        Some(
            fetch_json::<CivitaiModelResponse>(
                &client,
                api_url(&format!("/api/v1/models/{model_id}"))?,
            )
            .await?,
        )
    } else {
        None
    };
    let version_id = selector.version_id.or_else(|| {
        model
            .as_ref()
            .and_then(|value| value.model_versions.first())
            .map(|value| value.id)
    });
    let version_id = version_id.ok_or_else(|| {
        "The Civitai model has no published version available for review".to_string()
    })?;
    let version = fetch_json::<CivitaiModelVersionResponse>(
        &client,
        api_url(&format!("/api/v1/model-versions/{version_id}"))?,
    )
    .await?;
    if version.id != version_id {
        return Err("Civitai returned a different model version than requested".to_string());
    }
    if let Some(model_id) = selector.model_id {
        if version.model_id != model_id {
            return Err(
                "The requested Civitai model and version do not belong together".to_string(),
            );
        }
    }
    if model.is_none() {
        model = Some(
            fetch_json::<CivitaiModelResponse>(
                &client,
                api_url(&format!("/api/v1/models/{}", version.model_id))?,
            )
            .await?,
        );
    }
    let model = model.expect("model metadata is populated above");
    if model.id != version.model_id {
        return Err("Civitai returned inconsistent model metadata".to_string());
    }
    Ok(build_inspection(&selector, model, version))
}

pub(crate) async fn inspect_source(source: &str) -> MediaResult<MediaCivitaiModelAddonInspection> {
    resolve_source(source).await.map(|resolved| resolved.public)
}

fn is_allowed_download_redirect(url: &Url) -> bool {
    if url.scheme() != "https" || url.port().is_some() {
        return false;
    }
    match url.host_str() {
        Some("civitai.com" | "www.civitai.com") => true,
        Some(host) => {
            host.starts_with("civitai-delivery-worker-prod.")
                && host.ends_with(".r2.cloudflarestorage.com")
        }
        None => false,
    }
}

fn download_client() -> MediaResult<Client> {
    Client::builder()
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || !is_allowed_download_redirect(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30 * 60))
        .user_agent("machdoch-media-studio/1.0")
        .build()
        .map_err(|error| format!("failed to prepare Civitai download client: {error}"))
}

async fn download_selected(
    paths: &MediaRuntimePaths,
    selected: &SelectedFile,
) -> MediaResult<String> {
    let models_root = paths.models_root()?;
    let imports_root = models_root.join("civitai-imports");
    tokio::fs::create_dir_all(&imports_root)
        .await
        .map_err(|error| format!("failed to prepare Civitai import storage: {error}"))?;
    let required_bytes = selected.public.byte_size.saturating_mul(105).div_ceil(100);
    if hardware::available_storage_bytes(&imports_root).map(|available| available < required_bytes)
        == Some(true)
    {
        return Err("The Media Studio model volume does not have enough free space".to_string());
    }
    let destination_root = imports_root.join("sha256").join(&selected.public.sha256);
    let destination = destination_root.join("addon.safetensors");
    if destination.exists() {
        let destination_for_hash = destination.clone();
        let (bytes, digest) = tauri::async_runtime::spawn_blocking(move || {
            model_import::hash_file(&destination_for_hash)
        })
        .await
        .map_err(|error| format!("Civitai cache verification worker failed: {error}"))??;
        if bytes == selected.public.byte_size && digest == selected.public.sha256 {
            return Ok(destination.to_string_lossy().into_owned());
        }
        return Err(
            "The managed Civitai download cache conflicts with the reviewed SHA-256".to_string(),
        );
    }

    let import_id = model_import::new_import_id()?;
    let staging_root = imports_root.join("staging");
    tokio::fs::create_dir_all(&staging_root)
        .await
        .map_err(|error| format!("failed to prepare Civitai download staging: {error}"))?;
    let partial = staging_root.join(format!("{import_id}.safetensors.part"));
    let client = download_client()?;
    let mut response = client
        .get(selected.download_url.clone())
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|error| format!("Civitai add-on download failed: {error}"))?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(
                "Civitai requires a signed-in account for this download. Download it in your browser, then use Import LoRA / embedding."
                    .to_string(),
            )
        }
        status if !status.is_success() => {
            return Err(format!("Civitai add-on download returned HTTP {status}"))
        }
        _ => {}
    }
    if !is_allowed_download_redirect(response.url()) {
        return Err("Civitai redirected the download to an unapproved host".to_string());
    }
    if response
        .content_length()
        .map(|value| value != selected.public.byte_size)
        == Some(true)
    {
        return Err("Civitai download size does not match the reviewed file metadata".to_string());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .await
        .map_err(|error| format!("failed to create Civitai download staging file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut byte_size = 0_u64;
    let download_result: MediaResult<()> = async {
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("failed while streaming Civitai add-on bytes: {error}"))?
        {
            byte_size = byte_size.saturating_add(chunk.len() as u64);
            if byte_size > selected.public.byte_size || byte_size > MAX_ADDON_BYTES {
                return Err("The Civitai download exceeded the reviewed size limit".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("failed to write Civitai add-on staging data: {error}"))?;
        }
        file.flush()
            .await
            .map_err(|error| format!("failed to flush Civitai add-on staging data: {error}"))?;
        file.sync_all().await.map_err(|error| {
            format!("failed to synchronize Civitai add-on staging data: {error}")
        })?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = download_result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    let digest = format!("{:x}", hasher.finalize());
    if byte_size != selected.public.byte_size || digest != selected.public.sha256 {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(
            "The downloaded Civitai bytes failed SHA-256 or byte-size verification".to_string(),
        );
    }
    tokio::fs::create_dir_all(&destination_root)
        .await
        .map_err(|error| format!("failed to prepare verified Civitai cache entry: {error}"))?;
    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|error| format!("failed to publish verified Civitai download: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

pub(crate) async fn download_reviewed(
    paths: &MediaRuntimePaths,
    request: &DownloadMediaCivitaiModelAddonRequest,
) -> MediaResult<MediaModelAddonImportInspection> {
    let resolved = resolve_source(&request.source).await?;
    if request.review_token != resolved.public.review_token {
        return Err(
            "The Civitai model metadata changed after review. Inspect the URL or AIR again before downloading."
                .to_string(),
        );
    }
    if !resolved.public.can_download {
        return Err(resolved.public.blocking_reason.clone().unwrap_or_else(|| {
            "This Civitai add-on is not eligible for managed download".to_string()
        }));
    }
    let selected = resolved
        .selected_file
        .ok_or_else(|| "The reviewed Civitai file is no longer available".to_string())?;
    let source_path = download_selected(paths, &selected).await?;
    let inspection_path = source_path.clone();
    let inspection =
        tauri::async_runtime::spawn_blocking(move || model_addon::inspect(&inspection_path))
            .await
            .map_err(|error| format!("downloaded add-on inspection worker failed: {error}"))??;
    if inspection.detected_kind.as_deref() != resolved.public.kind.as_deref() {
        return Err(
            "The downloaded tensor structure does not match Civitai's reported add-on type"
                .to_string(),
        );
    }
    write_staged_source_metadata(paths, &source_path, &resolved.public).await?;
    Ok(inspection)
}

fn staged_source_entry(
    paths: &MediaRuntimePaths,
    source_path: &str,
) -> MediaResult<Option<(PathBuf, String)>> {
    let cache_root = paths.models_root()?.join("civitai-imports").join("sha256");
    let Ok(canonical_source) = Path::new(source_path).canonicalize() else {
        return Ok(None);
    };
    let Ok(canonical_root) = cache_root.canonicalize() else {
        return Ok(None);
    };
    let Ok(relative) = canonical_source.strip_prefix(&canonical_root) else {
        return Ok(None);
    };
    let components = relative.components().collect::<Vec<_>>();
    let digest = components
        .first()
        .and_then(|component| component.as_os_str().to_str())
        .map(ToOwned::to_owned);
    if components.len() != 2
        || relative.file_name().and_then(|value| value.to_str()) != Some("addon.safetensors")
        || digest.as_deref().map(is_sha256) != Some(true)
    {
        return Ok(None);
    }
    Ok(Some((canonical_source, digest.unwrap_or_default())))
}

async fn write_staged_source_metadata(
    paths: &MediaRuntimePaths,
    source_path: &str,
    metadata: &MediaCivitaiModelAddonInspection,
) -> MediaResult<()> {
    let Some((canonical_source, digest)) = staged_source_entry(paths, source_path)? else {
        return Err("The verified Civitai file is outside managed staging".to_string());
    };
    if metadata.file.as_ref().map(|file| file.sha256.as_str()) != Some(digest.as_str()) {
        return Err(
            "Civitai source metadata does not match the verified download digest".to_string(),
        );
    }
    let stored = StoredCivitaiSourceMetadata {
        provider: "civitai".to_string(),
        metadata: metadata.clone(),
    };
    let encoded = serde_json::to_vec(&stored)
        .map_err(|error| format!("failed to encode Civitai source metadata: {error}"))?;
    if encoded.len() > 256 * 1_024 {
        return Err("Civitai source metadata exceeded the 256 KiB safety limit".to_string());
    }
    let metadata_path = canonical_source
        .parent()
        .ok_or_else(|| "Civitai staging path has no parent directory".to_string())?
        .join("source.json");
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&metadata_path)
        .await
        .map_err(|error| format!("failed to create Civitai source metadata: {error}"))?;
    file.write_all(&encoded)
        .await
        .map_err(|error| format!("failed to write Civitai source metadata: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("failed to synchronize Civitai source metadata: {error}"))
}

pub(crate) fn read_staged_source_metadata(
    paths: &MediaRuntimePaths,
    source_path: &str,
) -> MediaResult<Option<Value>> {
    let Some((canonical_source, digest)) = staged_source_entry(paths, source_path)? else {
        return Ok(None);
    };
    let metadata_path = canonical_source
        .parent()
        .ok_or_else(|| "Civitai staging path has no parent directory".to_string())?
        .join("source.json");
    let bytes = std::fs::read(&metadata_path)
        .map_err(|error| format!("failed to read reviewed Civitai source metadata: {error}"))?;
    if bytes.len() > 256 * 1_024 {
        return Err("Civitai source metadata exceeded the 256 KiB safety limit".to_string());
    }
    let stored = serde_json::from_slice::<StoredCivitaiSourceMetadata>(&bytes)
        .map_err(|error| format!("reviewed Civitai source metadata is invalid: {error}"))?;
    if stored.provider != "civitai"
        || stored
            .metadata
            .file
            .as_ref()
            .map(|file| file.sha256.as_str())
            != Some(digest.as_str())
    {
        return Err("reviewed Civitai source metadata does not match the staged file".to_string());
    }
    serde_json::to_value(stored)
        .map(Some)
        .map_err(|error| format!("failed to preserve Civitai source metadata: {error}"))
}

pub(crate) fn remove_staged_source_after_import(
    paths: &MediaRuntimePaths,
    source_path: &str,
) -> MediaResult<()> {
    let Some((canonical_source, _)) = staged_source_entry(paths, source_path)? else {
        return Ok(());
    };
    std::fs::remove_file(&canonical_source)
        .map_err(|error| format!("failed to clean imported Civitai staging file: {error}"))?;
    if let Some(parent) = canonical_source.parent() {
        let _ = std::fs::remove_file(parent.join("source.json"));
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_file(id: u64, primary: bool) -> CivitaiFile {
        CivitaiFile {
            id,
            name: "detail.safetensors".to_string(),
            file_type: "Model".to_string(),
            size_kb: 2_048.0,
            primary,
            pickle_scan_result: Some("Success".to_string()),
            virus_scan_result: Some("Success".to_string()),
            scanned_at: Some("2026-07-15T00:00:00Z".to_string()),
            metadata: Some(CivitaiFileMetadata {
                format: Some("SafeTensor".to_string()),
            }),
            hashes: Some(CivitaiFileHashes {
                sha256: Some("a".repeat(64)),
            }),
            download_url: format!("https://civitai.com/api/download/models/{id}"),
        }
    }

    fn fixture_inspection() -> MediaCivitaiModelAddonInspection {
        build_inspection(
            &SourceSelector {
                model_id: Some(122_359),
                version_id: Some(135_867),
                declared_kind: Some("lora".to_string()),
            },
            CivitaiModelResponse {
                id: 122_359,
                name: "Detail Tweaker XL".to_string(),
                model_type: "LORA".to_string(),
                nsfw: false,
                poi: false,
                creator: Some(CivitaiCreator {
                    username: "publisher".to_string(),
                }),
                availability: Some("Public".to_string()),
                allow_no_credit: Some(false),
                allow_commercial_use: Some(serde_json::json!(["Image"])),
                allow_derivatives: Some(true),
                allow_different_license: Some(false),
                model_versions: vec![CivitaiModelVersionSummary { id: 135_867 }],
            },
            CivitaiModelVersionResponse {
                id: 135_867,
                model_id: 122_359,
                name: "Detail Tweaker XL".to_string(),
                base_model: Some("SDXL 1.0".to_string()),
                trained_words: vec!["add_detail".to_string()],
                air: Some("urn:air:sdxl:lora:civitai:122359@135867".to_string()),
                status: Some("Published".to_string()),
                files: vec![fixture_file(135_867, true)],
            },
        )
        .public
    }

    #[test]
    fn parses_canonical_urls_and_air_identifiers() {
        assert_eq!(
            parse_source("https://civitai.com/models/122359/detail?modelVersionId=135867")
                .expect("Civitai URL should parse"),
            SourceSelector {
                model_id: Some(122_359),
                version_id: Some(135_867),
                declared_kind: None,
            }
        );
        assert_eq!(
            parse_source("urn:air:sdxl:lora:civitai:122359@135867").expect("AIR should parse"),
            SourceSelector {
                model_id: Some(122_359),
                version_id: Some(135_867),
                declared_kind: Some("lora".to_string()),
            }
        );
        assert!(parse_source("https://example.com/models/122359").is_err());
    }

    #[test]
    fn selects_only_scanned_safetensors_model_files() {
        let selected = select_file(&[fixture_file(135_867, true)])
            .expect("safe primary file should be selected");
        assert_eq!(selected.public.byte_size, 2_097_152);

        let mut unsafe_file = fixture_file(135_867, true);
        unsafe_file.pickle_scan_result = Some("Danger".to_string());
        assert!(select_file(&[unsafe_file]).is_err());
    }

    #[test]
    fn requires_unique_primary_when_multiple_safe_files_exist() {
        assert!(select_file(&[fixture_file(1, false), fixture_file(2, false)]).is_err());
        let selected = select_file(&[fixture_file(1, true), fixture_file(2, false)])
            .expect("unique primary should win");
        assert_eq!(selected.public.id, 1);
    }

    #[test]
    fn maps_current_supported_base_families_conservatively() {
        assert_eq!(
            architecture_for_base_model(Some("Pony")),
            Some("stable-diffusion-xl".to_string())
        );
        assert_eq!(
            architecture_for_base_model(Some("Flux.1 D")),
            Some("flux-1".to_string())
        );
        assert_eq!(architecture_for_base_model(Some("Unknown Lab Model")), None);
    }

    #[test]
    fn only_allows_civitai_and_pinned_delivery_redirect_hosts() {
        assert!(is_allowed_download_redirect(
            &Url::parse("https://civitai.com/api/download/models/1").expect("valid URL")
        ));
        assert!(is_allowed_download_redirect(
            &Url::parse(
                "https://civitai-delivery-worker-prod.example.r2.cloudflarestorage.com/file"
            )
            .expect("valid URL")
        ));
        assert!(!is_allowed_download_redirect(
            &Url::parse("https://example.com/file").expect("valid URL")
        ));
    }

    #[test]
    fn preserves_only_digest_bound_managed_source_metadata() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("machdoch-civitai-source-{unique}"));
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        };
        let entry = root
            .join("models")
            .join("civitai-imports")
            .join("sha256")
            .join("a".repeat(64));
        std::fs::create_dir_all(&entry).expect("cache entry should be created");
        let source = entry.join("addon.safetensors");
        std::fs::write(&source, b"fixture").expect("fixture should be written");
        let stored = StoredCivitaiSourceMetadata {
            provider: "civitai".to_string(),
            metadata: fixture_inspection(),
        };
        std::fs::write(
            entry.join("source.json"),
            serde_json::to_vec(&stored).expect("metadata should encode"),
        )
        .expect("metadata should be written");

        let value = read_staged_source_metadata(&paths, source.to_string_lossy().as_ref())
            .expect("managed metadata should be read")
            .expect("managed source should be recognized");
        assert_eq!(value["provider"], "civitai");

        let mut tampered = stored;
        tampered
            .metadata
            .file
            .as_mut()
            .expect("fixture file should exist")
            .sha256 = "b".repeat(64);
        std::fs::write(
            entry.join("source.json"),
            serde_json::to_vec(&tampered).expect("metadata should encode"),
        )
        .expect("tampered metadata should be written");
        assert!(read_staged_source_metadata(&paths, source.to_string_lossy().as_ref()).is_err());

        std::fs::remove_dir_all(root).expect("fixture should be cleaned");
    }
}
