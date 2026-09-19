use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Instant,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter as _};

use super::{
    civitai_addon, civitai_compatibility, MediaLocalModelImportInspection,
    MediaModelAddonImportInspection, MediaResult,
};

static API_KEY: Mutex<Option<String>> = Mutex::new(None);
static DOWNLOADS: LazyLock<Mutex<HashMap<String, (bool, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn api_key() -> MediaResult<Option<String>> {
    API_KEY
        .lock()
        .map(|key| key.clone())
        .map_err(|_| "Civitai connection is unavailable".to_string())
}

pub(super) async fn connect(token: Option<String>) -> MediaResult<bool> {
    let token = token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = &token {
        if value.len() > 4096 || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err("Enter a valid Civitai API key".to_string());
        }
        let response = civitai_addon::metadata_client()?
            .get(civitai_addon::api_url("/api/v1/me")?)
            .bearer_auth(value)
            .send()
            .await
            .map_err(|_| "Could not connect to Civitai. Try again.".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "Civitai rejected the API key (HTTP {}). Check the key and try again.",
                response.status().as_u16()
            ));
        }
    }
    let connected = token.is_some();
    *API_KEY
        .lock()
        .map_err(|_| "Civitai connection is unavailable".to_string())? = token;
    Ok(connected)
}

fn deserialize_nsfw<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Bool(value) => value,
        Value::String(value) => {
            !matches!(value.to_ascii_lowercase().as_str(), "none" | "false" | "0")
        }
        Value::Number(value) => value.as_u64().map(|value| value > 1).unwrap_or(true),
        _ => true,
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiPreview {
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_nsfw")]
    pub nsfw: bool,
    pub nsfw_level: Option<u64>,
    #[serde(rename = "type")]
    pub media_type: Option<String>,
    pub meta: Option<CivitaiPreviewMeta>,
}

impl CivitaiPreview {
    pub(super) fn is_valid(&self) -> bool {
        reqwest::Url::parse(&self.url).ok().is_some_and(|url| {
            url.scheme() == "https"
                && matches!(
                    url.host_str(),
                    Some("image.civitai.com" | "imagecache.civitai.com")
                )
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
        }) && self.media_type.as_deref() != Some("video")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiPreviewMeta {
    pub prompt: Option<String>,
    pub negative_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CivitaiSearchRequest {
    pub query: String,
    pub model_type: String,
    pub base_model: String,
    pub sort: String,
    pub period: String,
    pub tag: String,
    pub username: String,
    pub nsfw: bool,
    pub favorites: bool,
    pub cursor: Option<String>,
}

fn search_url(request: &CivitaiSearchRequest) -> MediaResult<reqwest::Url> {
    if (!request.model_type.is_empty()
        && !civitai_compatibility::MODEL_TYPES.contains(&request.model_type.as_str()))
        || (!request.base_model.is_empty()
            && !civitai_compatibility::MODEL_TYPES.iter().any(|model_type| {
                (request.model_type.is_empty() || request.model_type == *model_type)
                    && civitai_compatibility::supports_resource(
                        model_type,
                        Some(&request.base_model),
                    )
            }))
        || !["Highest Rated", "Most Downloaded", "Newest"].contains(&request.sort.as_str())
        || !["AllTime", "Year", "Month", "Week", "Day"].contains(&request.period.as_str())
    {
        return Err("Choose a valid Civitai filter".to_string());
    }
    let mut url = civitai_addon::api_url("/api/v1/models")?;
    let mut pairs = url.query_pairs_mut();
    pairs
        .append_pair("limit", "24")
        .append_pair("sort", &request.sort)
        .append_pair("period", &request.period)
        .append_pair("nsfw", if request.nsfw { "true" } else { "false" });
    for (key, value, limit) in [
        ("query", request.query.as_str(), 512),
        ("tag", request.tag.as_str(), 128),
        ("username", request.username.as_str(), 128),
        ("cursor", request.cursor.as_deref().unwrap_or(""), 2048),
    ] {
        if value.len() > limit {
            return Err(format!("Civitai {key} is too long"));
        }
        if !value.trim().is_empty() {
            pairs.append_pair(key, value.trim());
        }
    }
    for model_type in civitai_compatibility::MODEL_TYPES {
        if request.model_type.is_empty() || request.model_type == *model_type {
            pairs.append_pair("types", model_type);
        }
    }
    for (base_model, _) in civitai_compatibility::BASE_MODELS {
        if (request.base_model.is_empty() || request.base_model.eq_ignore_ascii_case(base_model))
            && civitai_compatibility::MODEL_TYPES.iter().any(|model_type| {
                (request.model_type.is_empty() || request.model_type == *model_type)
                    && civitai_compatibility::supports_resource(model_type, Some(base_model))
            })
        {
            pairs.append_pair("baseModels", base_model);
        }
    }
    if request.favorites {
        pairs.append_pair("favorites", "true");
    }
    drop(pairs);
    Ok(url)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiSearchPage {
    items: Vec<CivitaiCatalogModel>,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiCatalogModel {
    pub id: u64,
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub matched_version_id: Option<u64>,
    #[serde(rename = "type")]
    pub model_type: String,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    pub creator: Option<CivitaiCreator>,
    #[serde(default)]
    pub model_versions: Vec<CivitaiCatalogVersion>,
    pub stats: Option<CivitaiStats>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct CivitaiCreator {
    pub username: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiStats {
    pub download_count: Option<u64>,
    pub thumbs_up_count: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiCatalogVersion {
    pub id: u64,
    pub name: String,
    pub base_model: Option<String>,
    pub base_model_type: Option<String>,
    pub published_at: Option<String>,
    #[serde(default)]
    pub trained_words: Vec<String>,
    #[serde(default)]
    pub files: Vec<CivitaiCatalogFile>,
    #[serde(default)]
    pub images: Vec<CivitaiPreview>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiCatalogFile {
    pub id: u64,
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String,
    #[serde(rename = "sizeKB")]
    pub size_kb: f64,
    #[serde(default)]
    pub primary: bool,
    pub hashes: Option<CivitaiHashes>,
    pub metadata: Option<CivitaiFileFormat>,
    pub pickle_scan_result: Option<String>,
    pub virus_scan_result: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct CivitaiHashes {
    #[serde(rename = "SHA256")]
    pub sha256: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct CivitaiFileFormat {
    pub format: Option<String>,
    pub fp: Option<String>,
    pub size: Option<String>,
}

fn filter_previews(model: &mut CivitaiCatalogModel, nsfw: bool) {
    for version in &mut model.model_versions {
        version.images.retain(|image| {
            image.is_valid()
                && (nsfw || (!model.nsfw && !image.nsfw && image.nsfw_level.unwrap_or(1) <= 1))
        });
        version.images.truncate(12);
    }
}

fn filter_resources(model: &mut CivitaiCatalogModel, base_model: &str) {
    model.model_versions.retain_mut(|version| {
        if !civitai_compatibility::supports_resource(
            &model.model_type,
            version.base_model.as_deref(),
        ) || !civitai_compatibility::supports_version_type(version.base_model_type.as_deref())
            || (!base_model.is_empty()
                && !version
                    .base_model
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(base_model)))
        {
            return false;
        }
        version.files.retain(|file| {
            civitai_compatibility::supports_file(
                &file.file_type,
                &file.name,
                file.metadata
                    .as_ref()
                    .and_then(|metadata| metadata.format.as_deref()),
                file.metadata
                    .as_ref()
                    .and_then(|metadata| metadata.fp.as_deref()),
            )
        });
        !version.files.is_empty()
    });
}

pub(super) async fn search(request: &CivitaiSearchRequest) -> MediaResult<CivitaiSearchPage> {
    if request.favorites && api_key()?.is_none() {
        return Err("Connect a Civitai API key to browse your favorites".to_string());
    }
    let response: Value =
        civitai_addon::fetch_json(&civitai_addon::metadata_client()?, search_url(request)?).await?;
    let mut items: Vec<CivitaiCatalogModel> =
        serde_json::from_value(response.get("items").cloned().unwrap_or(Value::Null))
            .map_err(|error| format!("Civitai returned invalid search results: {error}"))?;
    items.retain(|model| request.nsfw || !model.nsfw);
    for model in &mut items {
        filter_resources(model, &request.base_model);
        filter_previews(model, request.nsfw);
    }
    items.retain(|model| {
        !model.model_versions.is_empty()
            && (request.model_type.is_empty() || model.model_type == request.model_type)
    });
    let next_cursor = response
        .pointer("/metadata/nextCursor")
        .and_then(|value| match value {
            Value::String(value) if !value.is_empty() => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        });
    Ok(CivitaiSearchPage { items, next_cursor })
}

pub(super) async fn get_model(source: &str, nsfw: bool) -> MediaResult<CivitaiCatalogModel> {
    let client = civitai_addon::metadata_client()?;
    let (model_id, matched_version_id) =
        if source.len() == 64 && source.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            let version: Value = civitai_addon::fetch_json(
                &client,
                civitai_addon::api_url(&format!("/api/v1/model-versions/by-hash/{source}"))?,
            )
            .await?;
            (
                version
                    .get("modelId")
                    .and_then(Value::as_u64)
                    .ok_or("Civitai returned an invalid model ID")?,
                version.get("id").and_then(Value::as_u64),
            )
        } else {
            civitai_addon::source_ids(source).await?
        };
    let mut model: CivitaiCatalogModel = civitai_addon::fetch_json(
        &client,
        civitai_addon::api_url(&format!("/api/v1/models/{model_id}"))?,
    )
    .await?;
    if model.nsfw && !nsfw {
        return Err("Enable mature content to view this model".to_string());
    }
    model.matched_version_id = matched_version_id;
    if matched_version_id
        .is_some_and(|id| !model.model_versions.iter().any(|version| version.id == id))
    {
        return Err("The requested version is no longer available".to_string());
    }
    filter_resources(&mut model, "");
    if model.model_versions.is_empty()
        || matched_version_id
            .is_some_and(|id| !model.model_versions.iter().any(|version| version.id == id))
    {
        return Err("This Civitai model or version cannot be used in Machdoch. Choose another model or version.".to_string());
    }
    filter_previews(&mut model, nsfw);
    Ok(model)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiDownloadedResource {
    pub model: Option<MediaLocalModelImportInspection>,
    pub addon: Option<MediaModelAddonImportInspection>,
    pub metadata: civitai_addon::MediaCivitaiModelAddonInspection,
}

pub(super) fn begin_download(operation_id: &str) -> MediaResult<()> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("Invalid download ID".to_string());
    }
    let mut downloads = DOWNLOADS
        .lock()
        .map_err(|_| "Download state is unavailable")?;
    if downloads.contains_key(operation_id) {
        return Err("This download is already running".to_string());
    }
    downloads.insert(operation_id.to_string(), (false, Instant::now()));
    Ok(())
}

pub(super) fn finish_download(operation_id: &str) {
    if let Ok(mut downloads) = DOWNLOADS.lock() {
        downloads.remove(operation_id);
    }
}

pub(super) fn cancel_download(operation_id: &str) -> MediaResult<()> {
    let mut downloads = DOWNLOADS
        .lock()
        .map_err(|_| "Download state is unavailable")?;
    if let Some(download) = downloads.get_mut(operation_id) {
        download.0 = true;
    }
    Ok(())
}

pub(super) fn report_progress(
    app: &AppHandle,
    operation_id: &str,
    received: u64,
    total: u64,
) -> MediaResult<()> {
    let mut downloads = DOWNLOADS
        .lock()
        .map_err(|_| "Download state is unavailable")?;
    if let Some((cancelled, last_update)) = downloads.get_mut(operation_id) {
        if *cancelled {
            return Err("Download cancelled".to_string());
        }
        if last_update.elapsed().as_millis() >= 200 || received == total {
            app.emit("media-civitai-download-progress", serde_json::json!({"operationId": operation_id, "received": received, "total": total}))
                .map_err(|error| format!("Could not report download progress: {error}"))?;
            *last_update = Instant::now();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_model() -> CivitaiCatalogModel {
        serde_json::from_value(serde_json::json!({
            "id": 1, "name": "Mixed families", "type": "LORA",
            "modelVersions": [
                {"id": 10, "name": "Unsupported", "baseModel": "Flux.1 Kontext", "files": [
                    {"id": 100, "name": "model.safetensors", "type": "Model", "sizeKB": 100, "metadata": {"format": "SafeTensor"}}
                ]},
                {"id": 11, "name": "Pony", "baseModel": "Pony", "files": [
                    {"id": 101, "name": "model.safetensors", "type": "Model", "sizeKB": 100, "metadata": {"format": "SafeTensor", "fp": "fp16"}},
                    {"id": 102, "name": "model.ckpt", "type": "Model", "sizeKB": 100, "metadata": {"format": "PickleTensor"}},
                    {"id": 103, "name": "model.safetensors", "type": "Model", "sizeKB": 100, "metadata": {"format": "SafeTensor", "fp": "nf4"}},
                    {"id": 104, "name": "vae.safetensors", "type": "VAE", "sizeKB": 100, "metadata": {"format": "SafeTensor"}}
                ]},
                {"id": 12, "name": "SDXL", "baseModel": "SDXL 1.0", "files": [
                    {"id": 105, "name": "model.safetensors", "type": "Model", "sizeKB": 100, "metadata": {"format": "SafeTensor"}}
                ]},
                {"id": 13, "name": "Refiner", "baseModel": "SDXL 1.0", "baseModelType": "Refiner", "files": [
                    {"id": 106, "name": "model.safetensors", "type": "Model", "sizeKB": 100, "metadata": {"format": "SafeTensor"}}
                ]}
            ]
        })).unwrap()
    }

    #[test]
    fn removes_unsupported_versions_files_and_resource_types() {
        let mut model = fixture_model();
        filter_resources(&mut model, "");
        assert_eq!(
            model
                .model_versions
                .iter()
                .map(|version| version.id)
                .collect::<Vec<_>>(),
            vec![11, 12]
        );
        assert_eq!(model.model_versions[0].files.len(), 1);
        assert_eq!(model.model_versions[0].files[0].id, 101);
        filter_resources(&mut model, "SDXL 1.0");
        assert_eq!(model.model_versions.len(), 1);
        assert_eq!(model.model_versions[0].id, 12);
        model.model_type = "Controlnet".into();
        filter_resources(&mut model, "");
        assert!(model.model_versions.is_empty());
    }

    #[test]
    fn filters_live_enums_using_type_specific_support() {
        let options = supported_options(CivitaiEnums {
            model_types: [
                "Checkpoint",
                "LORA",
                "DoRA",
                "TextualInversion",
                "VAE",
                "Other",
            ]
            .map(str::to_string)
            .to_vec(),
            base_models: [
                "Pony",
                "Pony V7",
                "NoobAI",
                "Krea 2",
                "Wan Video 2.2 TI2V-5B",
                "Flux.1 Kontext",
                "Future Model",
            ]
            .map(str::to_string)
            .to_vec(),
        });
        assert_eq!(
            options.model_types,
            vec!["Checkpoint", "LORA", "DoRA", "TextualInversion"]
        );
        assert_eq!(
            options.base_models,
            vec!["Pony", "NoobAI", "Krea 2", "Wan Video 2.2 TI2V-5B"]
        );
        assert_eq!(
            options.base_models_by_type["TextualInversion"],
            vec!["Pony", "NoobAI"]
        );
        assert!(!options.base_models_by_type["Checkpoint"]
            .contains(&"Wan Video 2.2 TI2V-5B".to_string()));
    }

    #[test]
    fn all_filters_still_restrict_the_upstream_search() {
        let mut request = CivitaiSearchRequest {
            query: "".into(),
            model_type: "".into(),
            base_model: "".into(),
            sort: "Newest".into(),
            period: "Month".into(),
            tag: "".into(),
            username: "".into(),
            nsfw: false,
            favorites: false,
            cursor: None,
        };
        let url = search_url(&request).unwrap();
        let types: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "types")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(types, civitai_compatibility::MODEL_TYPES);
        assert!(!url.query_pairs().any(|(_, value)| value == "Pony V7"));
        request.model_type = "VAE".into();
        assert!(search_url(&request).is_err());
        request.model_type = "TextualInversion".into();
        request.base_model = "Krea 2".into();
        assert!(search_url(&request).is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn civitai_live_public_api_smoke() {
        let enums = options().await.unwrap();
        assert!(enums.model_types.contains(&"LORA".to_string()));
        assert!(enums.base_models.contains(&"SDXL 1.0".to_string()));
        assert!(enums.base_models.contains(&"NoobAI".to_string()));
        assert!(enums.base_models.contains(&"Krea 2".to_string()));
        assert!(!enums.base_models.contains(&"Pony V7".to_string()));
        assert!(!enums.model_types.contains(&"VAE".to_string()));
        let model = get_model(
            "https://civitai.red/models/122359?modelVersionId=135867",
            false,
        )
        .await
        .unwrap();
        assert_eq!(model.id, 122359);
        assert_eq!(model.matched_version_id, Some(135867));
        let version = model
            .model_versions
            .iter()
            .find(|version| version.id == 135867)
            .unwrap();
        let file = version.files.iter().find(|file| file.primary).unwrap();
        let inspection = civitai_addon::inspect_file("122359@135867", file.id)
            .await
            .unwrap();
        let encoded = serde_json::to_value(&inspection).unwrap();
        assert_eq!(encoded["canDownload"], true);
        assert_eq!(encoded["canEnrich"], true);
        assert!(encoded["file"]["byteSize"].as_u64().unwrap() > 0);
        let request = CivitaiSearchRequest {
            query: "".into(),
            model_type: "LORA".into(),
            base_model: "SDXL 1.0".into(),
            sort: "Most Downloaded".into(),
            period: "AllTime".into(),
            tag: "".into(),
            username: "".into(),
            nsfw: false,
            favorites: false,
            cursor: None,
        };
        let page = search(&request).await.unwrap();
        assert!(!page.items.is_empty());
        assert!(page.items.iter().all(|item| !item.nsfw));
        let page = search(&CivitaiSearchRequest {
            model_type: "".into(),
            base_model: "".into(),
            ..request
        })
        .await
        .unwrap();
        assert!(!page.items.is_empty());
        assert!(page
            .items
            .iter()
            .all(|item| item.model_versions.iter().all(|version| {
                civitai_compatibility::supports_resource(
                    &item.model_type,
                    version.base_model.as_deref(),
                ) && !version.files.is_empty()
            })));
    }

    #[test]
    fn search_encodes_cursor_and_never_combines_query_with_page() {
        let request = CivitaiSearchRequest {
            query: "ink & wash".into(),
            model_type: "LORA".into(),
            base_model: "SDXL 1.0".into(),
            sort: "Newest".into(),
            period: "Month".into(),
            tag: "".into(),
            username: "".into(),
            nsfw: true,
            favorites: false,
            cursor: Some("12|34".into()),
        };
        let url = search_url(&request).unwrap();
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["query"], "ink & wash");
        assert_eq!(pairs["cursor"], "12|34");
        assert_eq!(pairs["nsfw"], "true");
        assert!(!pairs.contains_key("page"));
        assert!(!pairs.contains_key("token"));
    }

    #[tokio::test]
    #[ignore]
    async fn civitai_live_age_search_finds_compatible_slider_loras() {
        for query in ["Age", "age slider"] {
            let page = search(&CivitaiSearchRequest {
                query: query.into(),
                model_type: "".into(),
                base_model: "".into(),
                sort: "Most Downloaded".into(),
                period: "AllTime".into(),
                tag: "".into(),
                username: "".into(),
                nsfw: false,
                favorites: false,
                cursor: None,
            })
            .await
            .unwrap();
            let sliders = page
                .items
                .iter()
                .filter(|model| {
                    model.model_type == "LORA" && model.name.to_lowercase().contains("age slider")
                })
                .count();
            assert!(sliders > 0, "{query} must find age slider LoRAs");
            assert!(page.items.iter().all(|model| !model.nsfw
                && !model.model_versions.is_empty()
                && model.model_versions.iter().all(|version| {
                    civitai_compatibility::supports_resource(
                        &model.model_type,
                        version.base_model.as_deref(),
                    ) && !version.files.is_empty()
                })));
            println!(
                "{query}: {} compatible models, {sliders} age slider LoRAs",
                page.items.len()
            );
        }
    }

    #[test]
    fn preview_validation_rejects_remote_hosts_and_marks_mature_labels() {
        let preview: CivitaiPreview = serde_json::from_value(
            serde_json::json!({"url": "https://image.civitai.com/example.jpeg", "nsfw": "Mature"}),
        )
        .unwrap();
        assert!(preview.nsfw);
        assert!(preview.is_valid());
        let preview: CivitaiPreview = serde_json::from_value(
            serde_json::json!({"url": "https://image.civitai.com.evil.test/a", "nsfw": false}),
        )
        .unwrap();
        assert!(!preview.is_valid());
    }
}

#[derive(Debug, Deserialize)]
struct CivitaiEnums {
    #[serde(rename = "ModelType")]
    model_types: Vec<String>,
    #[serde(rename = "BaseModel")]
    base_models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiOptions {
    model_types: Vec<String>,
    base_models: Vec<String>,
    base_models_by_type: HashMap<String, Vec<String>>,
}

fn supported_options(enums: CivitaiEnums) -> CivitaiOptions {
    let model_types: Vec<_> = enums
        .model_types
        .into_iter()
        .filter(|value| civitai_compatibility::MODEL_TYPES.contains(&value.as_str()))
        .collect();
    let base_models: Vec<_> = enums
        .base_models
        .into_iter()
        .filter(|value| {
            model_types
                .iter()
                .any(|model_type| civitai_compatibility::supports_resource(model_type, Some(value)))
        })
        .collect();
    let base_models_by_type = model_types
        .iter()
        .map(|model_type| {
            (
                model_type.clone(),
                base_models
                    .iter()
                    .filter(|base_model| {
                        civitai_compatibility::supports_resource(model_type, Some(base_model))
                    })
                    .cloned()
                    .collect(),
            )
        })
        .collect();
    CivitaiOptions {
        model_types,
        base_models,
        base_models_by_type,
    }
}

pub(super) async fn options() -> MediaResult<CivitaiOptions> {
    let enums = civitai_addon::fetch_json(
        &civitai_addon::metadata_client()?,
        civitai_addon::api_url("/api/v1/enums")?,
    )
    .await?;
    Ok(supported_options(enums))
}
