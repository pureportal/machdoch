use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fmt, fs,
    path::{Path, PathBuf},
};

use rusqlite::{params, Connection, OptionalExtension as _, TransactionBehavior};
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{json, Map, Value};
use sha2::{Digest as _, Sha256};

use super::{
    database, subject_cutout, transform, EnqueueFixtureRunRequest, MediaHumanReviewContract,
    MediaResult, MediaRunPlanNodeSnapshot, MediaRunPlanSnapshot, MediaRunPlanStepSnapshot,
    MediaRuntimePaths, RalphMediaFlowRunRequest,
};

const MAX_FLOW_NODES: usize = 64;
const MAX_FLOW_EDGES: usize = 128;
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const MAX_HISTORY_REVISIONS: usize = 100;
const MAX_FLOW_BUNDLE_BYTES: u64 = 2 * 1024 * 1024;
const FLOW_BUNDLE_KIND: &str = "machdoch.media-flow";
const FLOW_BUNDLE_SCHEMA_URI: &str = "https://machdoch.app/schemas/media-flow-bundle/v1";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowNode {
    id: String,
    r#type: String,
    version: u32,
    label: String,
    layer: String,
    config: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowEdge {
    id: String,
    from_node_id: String,
    from_port_id: String,
    to_node_id: String,
    to_port_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowVariableConstraints {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    options: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowVariable {
    id: String,
    name: String,
    description: String,
    r#type: String,
    required: bool,
    default_value: Option<Value>,
    constraints: MediaFlowVariableConstraints,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowPreset {
    id: String,
    name: String,
    description: String,
    values: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowDocument {
    schema_version: u32,
    id: String,
    name: String,
    description: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    variables: Vec<MediaFlowVariable>,
    #[serde(default)]
    variable_bindings: Map<String, Value>,
    #[serde(default)]
    presets: Vec<MediaFlowPreset>,
    #[serde(default)]
    active_preset_id: Option<String>,
    nodes: Vec<MediaFlowNode>,
    edges: Vec<MediaFlowEdge>,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalImageFlowPlan {
    pub(crate) flow_id: String,
    pub(crate) flow_name: String,
    pub(crate) revision_id: String,
    pub(crate) nodes: Vec<LocalImageFlowNode>,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalImageFlowNode {
    pub(crate) id: String,
    pub(crate) inputs: Vec<LocalImageFlowInput>,
    pub(crate) operation: LocalImageFlowOperation,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalImageFlowInput {
    pub(crate) node_id: String,
    pub(crate) port_id: String,
}

#[derive(Debug, Clone)]
pub(crate) enum LocalImageFlowOperation {
    Source {
        asset_id: String,
    },
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
    Convert {
        output_format: String,
        quality: u8,
        jpeg_background: Option<String>,
    },
    MetadataStrip {
        preserve_color_profile: bool,
        apply_orientation: bool,
    },
    AutoTag {
        profile: String,
    },
    SubjectCutout {
        model_priority: Vec<String>,
        output_matte: bool,
    },
    AlphaMatte {
        invert: bool,
    },
    Composite {
        fit: String,
        opacity_percent: u8,
    },
    ContactSheet {
        columns: u32,
        cell_width: u32,
        cell_height: u32,
        gap: u32,
        background: String,
        label_mode: String,
    },
    Output {
        output_format: String,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteImageEditFlowPlan {
    pub(crate) flow_id: String,
    pub(crate) flow_name: String,
    pub(crate) revision_id: String,
    pub(crate) prompt: String,
    pub(crate) provider_prompt: String,
    pub(crate) task_node_id: String,
    pub(crate) model_id: String,
    pub(crate) model_label: String,
    pub(crate) output_count: u32,
    pub(crate) aspect_ratio: String,
    pub(crate) output_format: String,
    pub(crate) model_policy: String,
    pub(crate) transparent_background: bool,
    pub(crate) subject_cutout_model_priority: Vec<String>,
    pub(crate) edit_strength: f64,
    pub(crate) sources: Vec<RemoteImageEditSource>,
    pub(crate) upload_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteImageEditSource {
    pub(crate) node_id: String,
    pub(crate) asset_id: String,
    pub(crate) role: String,
    pub(crate) influence: f64,
    pub(crate) source_digest: String,
    pub(crate) upload_digest: String,
    pub(crate) upload_byte_size: u64,
    pub(crate) upload_bytes: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowNodeLayout {
    node_id: String,
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowLayoutGroup {
    id: String,
    label: String,
    color: String,
    collapsed: bool,
    node_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowLayoutComment {
    id: String,
    body: String,
    color: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowLayoutDocument {
    schema_version: u32,
    flow_id: String,
    nodes: Vec<MediaFlowNodeLayout>,
    #[serde(default)]
    groups: Vec<MediaFlowLayoutGroup>,
    #[serde(default)]
    comments: Vec<MediaFlowLayoutComment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveMediaFlowRevisionRequest {
    schema_version: u32,
    idempotency_key: String,
    expected_head_revision_id: Option<String>,
    change_summary: String,
    flow: MediaFlowDocument,
    layout: MediaFlowLayoutDocument,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFlowHead {
    schema_version: u32,
    flow_id: String,
    name: String,
    description: String,
    head_revision_id: String,
    head_revision_number: u32,
    created_at: String,
    updated_at: String,
    document_digest: String,
    execution_digest: String,
    layout_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFlowRevision {
    schema_version: u32,
    revision_id: String,
    flow_id: String,
    revision_number: u32,
    parent_revision_id: Option<String>,
    created_at: String,
    change_summary: String,
    document_digest: String,
    execution_digest: String,
    layout_digest: String,
    node_count: u32,
    edge_count: u32,
    is_head: bool,
    flow: MediaFlowDocument,
    layout: MediaFlowLayoutDocument,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFlowHistory {
    schema_version: u32,
    flow_id: String,
    head: Option<MediaFlowHead>,
    revisions: Vec<MediaFlowRevision>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMediaFlowRevisionResult {
    schema_version: u32,
    created: bool,
    head: MediaFlowHead,
    revision: MediaFlowRevision,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportMediaFlowRevisionRequest {
    schema_version: u32,
    idempotency_key: String,
    revision_id: String,
    destination_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFlowExportResult {
    schema_version: u32,
    revision_id: String,
    file_name: String,
    byte_size: u64,
    bundle_digest: String,
    exported_at: String,
    requirement_count: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectMediaFlowImportRequest {
    schema_version: u32,
    source_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportMediaFlowRequest {
    schema_version: u32,
    idempotency_key: String,
    source_path: String,
    review_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaFlowImportStatus {
    Ready,
    InspectOnly,
    Invalid,
}

impl MediaFlowImportStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::InspectOnly => "inspect-only",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaFlowNodeRequirement {
    node_type: String,
    version: u32,
    supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFlowImportIssue {
    severity: &'static str,
    code: String,
    message: String,
    node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFlowUnknownNodeTombstone {
    schema_version: u32,
    node_id: String,
    node_type: String,
    version: Option<u32>,
    original_node: Value,
    connected_edges: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFlowImportInspection {
    schema_version: u32,
    status: MediaFlowImportStatus,
    can_import: bool,
    review_token: String,
    source_display_name: String,
    bundle_digest: String,
    bundle_schema_version: Option<u32>,
    source_flow_id: Option<String>,
    source_flow_name: Option<String>,
    source_revision_id: Option<String>,
    proposed_flow_id: Option<String>,
    node_count: u32,
    edge_count: u32,
    document_digest: Option<String>,
    execution_digest: Option<String>,
    layout_digest: Option<String>,
    requirements: Vec<MediaFlowNodeRequirement>,
    issues: Vec<MediaFlowImportIssue>,
    unknown_nodes: Vec<MediaFlowUnknownNodeTombstone>,
    import_mutations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportMediaFlowResult {
    schema_version: u32,
    created: bool,
    bundle_digest: String,
    source_flow_id: String,
    source_revision_id: String,
    target_flow_id: String,
    import_mutations: Vec<String>,
    head: MediaFlowHead,
    revision: MediaFlowRevision,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaFlowBundleSource {
    flow_id: String,
    revision_id: String,
    revision_number: u32,
    document_digest: String,
    execution_digest: String,
    layout_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaFlowBundleRequirements {
    flow_schema_version: u32,
    layout_schema_version: u32,
    node_types: Vec<MediaFlowBundleNodeRequirement>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaFlowBundleNodeRequirement {
    node_type: String,
    version: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaFlowBundle {
    #[serde(rename = "$schema")]
    schema_uri: String,
    kind: String,
    schema_version: u32,
    exported_at: String,
    source: MediaFlowBundleSource,
    requirements: MediaFlowBundleRequirements,
    flow: Value,
    layout: Value,
}

struct ReviewedFlowBundle {
    bytes: Vec<u8>,
    inspection: MediaFlowImportInspection,
    bundle: Option<MediaFlowBundle>,
    flow: Option<MediaFlowDocument>,
    layout: Option<MediaFlowLayoutDocument>,
}

pub(crate) fn list(paths: &MediaRuntimePaths) -> MediaResult<Vec<MediaFlowHead>> {
    database::ensure_initialized(paths)?;
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, description, head_revision_id, head_revision_number, created_at,
                    updated_at, document_digest, execution_digest, layout_digest
             FROM flows ORDER BY updated_at DESC, id ASC LIMIT 100",
        )
        .map_err(|error| format!("failed to prepare flow catalog query: {error}"))?;
    let heads = statement
        .query_map([], read_head_row)
        .map_err(|error| format!("failed to query flow catalog: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode flow catalog: {error}"))?;
    Ok(heads)
}

pub(crate) fn get(paths: &MediaRuntimePaths, flow_id: &str) -> MediaResult<MediaFlowHistory> {
    database::ensure_initialized(paths)?;
    validate_text("flowId", flow_id, 128, false)?;
    let connection = database::open(paths)?;
    let head = read_head(&connection, flow_id)?;
    let Some(head) = head else {
        return Ok(MediaFlowHistory {
            schema_version: 1,
            flow_id: flow_id.to_string(),
            head: None,
            revisions: Vec::new(),
        });
    };
    let mut statement = connection
        .prepare(
            "SELECT revision_id, flow_id, revision_number, parent_revision_id, created_at,
                    change_summary, document_digest, execution_digest, layout_digest,
                    node_count, edge_count, flow_json, layout_json
             FROM flow_revisions WHERE flow_id = ?1
             ORDER BY revision_number DESC LIMIT ?2",
        )
        .map_err(|error| format!("failed to prepare flow history query: {error}"))?;
    let revisions = statement
        .query_map(params![flow_id, MAX_HISTORY_REVISIONS as u32], |row| {
            read_revision_row(row, &head.head_revision_id)
        })
        .map_err(|error| format!("failed to query flow history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode flow history: {error}"))?;
    Ok(MediaFlowHistory {
        schema_version: 1,
        flow_id: flow_id.to_string(),
        head: Some(head),
        revisions,
    })
}

pub(crate) fn compile_local_image_flow(
    paths: &MediaRuntimePaths,
    flow_id: &str,
    revision_id: &str,
    snapshot: &MediaRunPlanSnapshot,
) -> MediaResult<LocalImageFlowPlan> {
    database::ensure_initialized(paths)?;
    validate_text("flowId", flow_id, 128, false)?;
    validate_text("flowRevisionId", revision_id, 128, false)?;
    let connection = database::open(paths)?;
    let revision = read_revision_by_id(&connection, revision_id)?;
    if revision.flow_id != flow_id {
        return Err("local image flow identity does not match the pinned revision".to_string());
    }
    revision.flow.validate()?;

    let supported = [
        "source.image",
        "operation.crop",
        "operation.resize",
        "operation.format-convert",
        "operation.metadata-strip",
        "operation.auto-tag",
        "operation.subject-cutout",
        "operation.alpha-matte",
        "operation.composite",
        "operation.contact-sheet",
        "output.asset",
    ];
    if let Some(node) = revision
        .flow
        .nodes
        .iter()
        .find(|node| !supported.contains(&node.r#type.as_str()))
    {
        return Err(format!(
            "node {} ({}) requires a model or runtime that the local image utility executor does not provide",
            node.label, node.r#type
        ));
    }

    let output_nodes = revision
        .flow
        .nodes
        .iter()
        .filter(|node| node.r#type == "output.asset")
        .collect::<Vec<_>>();
    if output_nodes.len() != 1 {
        return Err("local image utility flows require exactly one Save asset output".to_string());
    }

    let mut incoming_count = revision
        .flow
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0_u32))
        .collect::<HashMap<_, _>>();
    let mut outgoing = HashMap::<&str, Vec<&str>>::new();
    for edge in &revision.flow.edges {
        *incoming_count
            .get_mut(edge.to_node_id.as_str())
            .ok_or_else(|| "local image flow contains an unknown edge target".to_string())? += 1;
        outgoing
            .entry(edge.from_node_id.as_str())
            .or_default()
            .push(edge.to_node_id.as_str());
    }
    let mut ready = revision
        .flow
        .nodes
        .iter()
        .filter(|node| incoming_count.get(node.id.as_str()) == Some(&0))
        .map(|node| node.id.as_str())
        .collect::<VecDeque<_>>();
    let nodes_by_id = revision
        .flow
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let mut ordered_nodes = Vec::with_capacity(revision.flow.nodes.len());
    while let Some(node_id) = ready.pop_front() {
        ordered_nodes.push(
            *nodes_by_id
                .get(node_id)
                .ok_or_else(|| "local image flow topology is inconsistent".to_string())?,
        );
        if let Some(next_nodes) = outgoing.get(node_id) {
            for next_node_id in next_nodes {
                let count = incoming_count
                    .get_mut(next_node_id)
                    .ok_or_else(|| "local image flow topology is inconsistent".to_string())?;
                *count -= 1;
                if *count == 0 {
                    ready.push_back(next_node_id);
                }
            }
        }
    }
    if ordered_nodes.len() != revision.flow.nodes.len() {
        return Err("local image utility flow must be acyclic".to_string());
    }

    let mut resolved_nodes = Vec::with_capacity(ordered_nodes.len());
    for node in ordered_nodes {
        let mut resolved = node.clone();
        resolved.config = revision.flow.resolve_node_config(&node.config)?;
        validate_node_config(&resolved)?;
        resolved_nodes.push(resolved);
    }

    let snapshot_nodes = snapshot
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.r#type.as_str()))
        .collect::<HashSet<_>>();
    let resolved_node_set = resolved_nodes
        .iter()
        .map(|node| (node.id.as_str(), node.r#type.as_str()))
        .collect::<HashSet<_>>();
    if snapshot_nodes != resolved_node_set {
        return Err("compiled plan nodes do not match the pinned flow revision".to_string());
    }
    let expected_steps = create_ralph_plan_steps(&resolved_nodes)?;
    let expected_step_identity = expected_steps
        .iter()
        .map(|step| (step.source_node_id.as_str(), step.kind.as_str()))
        .collect::<Vec<_>>();
    let actual_step_identity = snapshot
        .steps
        .iter()
        .map(|step| (step.source_node_id.as_str(), step.kind.as_str()))
        .collect::<Vec<_>>();
    if expected_step_identity != actual_step_identity {
        return Err("compiled plan steps do not match the pinned local utility flow".to_string());
    }

    let nodes = resolved_nodes
        .into_iter()
        .map(|node| {
            let inputs = revision
                .flow
                .edges
                .iter()
                .filter(|edge| edge.to_node_id == node.id)
                .map(|edge| LocalImageFlowInput {
                    node_id: edge.from_node_id.clone(),
                    port_id: edge.to_port_id.clone(),
                })
                .collect::<Vec<_>>();
            let operation = match node.r#type.as_str() {
                "source.image" => LocalImageFlowOperation::Source {
                    asset_id: local_string_config(&node, "assetId")?,
                },
                "operation.crop" => LocalImageFlowOperation::Crop {
                    x: local_u32_config(&node, "x")?,
                    y: local_u32_config(&node, "y")?,
                    width: local_u32_config(&node, "width")?,
                    height: local_u32_config(&node, "height")?,
                },
                "operation.resize" => LocalImageFlowOperation::Resize {
                    width: local_u32_config(&node, "width")?,
                    height: local_u32_config(&node, "height")?,
                    fit: local_string_config(&node, "fit")?,
                },
                "operation.format-convert" => LocalImageFlowOperation::Convert {
                    output_format: local_string_config(&node, "outputFormat")?,
                    quality: u8::try_from(local_u32_config(&node, "quality")?)
                        .map_err(|_| format!("flow node {} quality is invalid", node.id))?,
                    jpeg_background: node
                        .config
                        .get("jpegBackground")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
                "operation.metadata-strip" => LocalImageFlowOperation::MetadataStrip {
                    preserve_color_profile: local_bool_config(&node, "preserveColorProfile")?,
                    apply_orientation: local_bool_config(&node, "applyOrientation")?,
                },
                "operation.auto-tag" => LocalImageFlowOperation::AutoTag {
                    profile: local_string_config(&node, "profile")?,
                },
                "operation.subject-cutout" => LocalImageFlowOperation::SubjectCutout {
                    model_priority: local_subject_cutout_model_priority(&node)?,
                    output_matte: local_bool_config(&node, "outputMatte")?,
                },
                "operation.alpha-matte" => LocalImageFlowOperation::AlphaMatte {
                    invert: local_bool_config(&node, "invert")?,
                },
                "operation.composite" => LocalImageFlowOperation::Composite {
                    fit: local_string_config(&node, "fit")?,
                    opacity_percent: u8::try_from(local_u32_config(&node, "opacityPercent")?)
                        .map_err(|_| format!("flow node {} opacity is invalid", node.id))?,
                },
                "operation.contact-sheet" => LocalImageFlowOperation::ContactSheet {
                    columns: local_u32_config(&node, "columns")?,
                    cell_width: local_u32_config(&node, "cellWidth")?,
                    cell_height: local_u32_config(&node, "cellHeight")?,
                    gap: local_u32_config(&node, "gap")?,
                    background: local_string_config(&node, "background")?,
                    label_mode: local_string_config(&node, "labelMode")?,
                },
                "output.asset" => {
                    if local_u32_config(&node, "outputCount")? != 1 {
                        return Err(
                            "local image utility flows publish exactly one output".to_string()
                        );
                    }
                    LocalImageFlowOperation::Output {
                        output_format: local_string_config(&node, "format")?,
                    }
                }
                _ => unreachable!("supported local node type was checked above"),
            };
            Ok(LocalImageFlowNode {
                id: node.id,
                inputs,
                operation,
            })
        })
        .collect::<MediaResult<Vec<_>>>()?;

    Ok(LocalImageFlowPlan {
        flow_id: revision.flow_id,
        flow_name: revision.flow.name,
        revision_id: revision.revision_id,
        nodes,
    })
}

pub(crate) fn compile_remote_image_edit_flow(
    paths: &MediaRuntimePaths,
    flow_id: &str,
    revision_id: &str,
    snapshot: &MediaRunPlanSnapshot,
) -> MediaResult<RemoteImageEditFlowPlan> {
    const MAX_UPLOAD_IMAGE_BYTES: usize = 50 * 1024 * 1024;
    const MAX_UPLOAD_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

    database::ensure_initialized(paths)?;
    validate_text("flowId", flow_id, 128, false)?;
    validate_text("flowRevisionId", revision_id, 128, false)?;
    let connection = database::open(paths)?;
    let revision = read_revision_by_id(&connection, revision_id)?;
    if revision.flow_id != flow_id {
        return Err("remote image edit identity does not match the pinned revision".to_string());
    }
    revision.flow.validate()?;

    let supported = [
        "source.prompt",
        "source.image",
        "task.edit-image",
        "operation.subject-cutout",
        "output.asset",
    ];
    if let Some(node) = revision
        .flow
        .nodes
        .iter()
        .find(|node| !supported.contains(&node.r#type.as_str()))
    {
        return Err(format!(
            "node {} ({}) is not supported by the one-shot GPT Image 2 edit executor",
            node.label, node.r#type
        ));
    }

    let resolved_nodes = resolve_ordered_flow_nodes(&revision.flow)?;
    validate_remote_edit_snapshot(snapshot, &resolved_nodes)?;
    let prompts = resolved_nodes
        .iter()
        .filter(|node| node.r#type == "source.prompt")
        .collect::<Vec<_>>();
    let tasks = resolved_nodes
        .iter()
        .filter(|node| node.r#type == "task.edit-image")
        .collect::<Vec<_>>();
    let outputs = resolved_nodes
        .iter()
        .filter(|node| node.r#type == "output.asset")
        .collect::<Vec<_>>();
    let source_nodes = resolved_nodes
        .iter()
        .filter(|node| node.r#type == "source.image")
        .collect::<Vec<_>>();
    let subject_cutout_nodes = resolved_nodes
        .iter()
        .filter(|node| node.r#type == "operation.subject-cutout")
        .collect::<Vec<_>>();
    if prompts.len() != 1 || tasks.len() != 1 || outputs.len() != 1 {
        return Err(
            "remote image edits require exactly one prompt, edit task, and Save assets output"
                .to_string(),
        );
    }
    if !(1..=8).contains(&source_nodes.len()) {
        return Err(
            "remote image edits require between one and eight image references".to_string(),
        );
    }
    if subject_cutout_nodes.len() > 1 {
        return Err("remote image edits support at most one subject-cutout step".to_string());
    }

    let prompt_node = prompts[0];
    let task_node = tasks[0];
    let output_node = outputs[0];
    let subject_cutout_node = subject_cutout_nodes.first().copied();
    let expected_edge_count = source_nodes.len() + 2 + usize::from(subject_cutout_node.is_some());
    let has_valid_output_path = subject_cutout_node.map_or_else(
        || {
            has_exact_edge(
                &revision.flow,
                &task_node.id,
                "image",
                &output_node.id,
                "image",
            )
        },
        |subject_cutout| {
            has_exact_edge(
                &revision.flow,
                &task_node.id,
                "image",
                &subject_cutout.id,
                "image",
            ) && has_exact_edge(
                &revision.flow,
                &subject_cutout.id,
                "image",
                &output_node.id,
                "image",
            )
        },
    );
    if revision.flow.edges.len() != expected_edge_count
        || !has_exact_edge(
            &revision.flow,
            &prompt_node.id,
            "prompt",
            &task_node.id,
            "prompt",
        )
        || !has_valid_output_path
        || source_nodes.iter().any(|source| {
            !has_exact_edge(&revision.flow, &source.id, "image", &task_node.id, "image")
        })
    {
        return Err(
            "remote image edits currently require every reference to connect directly to one edit task and one output"
                .to_string(),
        );
    }

    let provider_policy = local_string_config(task_node, "providerPolicy")?;
    if !matches!(provider_policy.as_str(), "auto" | "remote") {
        return Err("the GPT Image 2 edit executor requires remote provider policy".to_string());
    }
    let model_id = task_node
        .config
        .get("modelId")
        .and_then(Value::as_str)
        .ok_or_else(|| "the remote edit task requires a pinned modelId".to_string())?
        .to_string();
    if model_id != "openai:gpt-image-2" {
        return Err("remote image edit execution currently requires GPT Image 2".to_string());
    }
    if task_node
        .config
        .get("modelAddons")
        .and_then(Value::as_array)
        .is_some_and(|addons| {
            addons.iter().any(|addon| {
                addon
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        })
    {
        return Err(
            "GPT Image 2 does not accept LoRA adapters or textual-inversion embeddings".to_string(),
        );
    }
    let output_count = local_u32_config(task_node, "outputCount")?;
    let aspect_ratio = local_string_config(task_node, "aspectRatio")?;
    let output_format = local_string_config(task_node, "outputFormat")?;
    let model_policy = local_string_config(task_node, "modelPolicy")?;
    let edit_strength = task_node
        .config
        .get("editStrength")
        .and_then(Value::as_f64)
        .ok_or_else(|| "the remote edit task requires numeric editStrength".to_string())?;
    if local_u32_config(output_node, "outputCount")? != output_count
        || local_string_config(output_node, "format")? != output_format
    {
        return Err("the remote edit task and output node settings do not match".to_string());
    }
    let transparent_background = subject_cutout_node.is_some();
    let subject_cutout_model_priority = subject_cutout_node
        .map(local_subject_cutout_model_priority)
        .transpose()?
        .unwrap_or_default();
    if transparent_background && output_format == "jpeg" {
        return Err(
            "remote transparent image edits require PNG or WebP output because JPEG has no alpha channel"
                .to_string(),
        );
    }
    let prompt = local_string_config(prompt_node, "prompt")?;

    let mut role_count = HashMap::<String, usize>::new();
    let mut asset_ids = HashSet::new();
    let mut prepared = Vec::with_capacity(source_nodes.len());
    for source in source_nodes {
        let asset_id = local_string_config(source, "assetId")?;
        if !asset_ids.insert(asset_id.clone()) {
            return Err(format!(
                "image asset {asset_id} is connected more than once; remove duplicate paid uploads"
            ));
        }
        let role = local_string_config(source, "referenceRole")?;
        *role_count.entry(role.clone()).or_default() += 1;
        let influence = source
            .config
            .get("influence")
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("flow node {} requires numeric influence", source.id))?;
        let (asset, decoded) = transform::read_asset_image_with_profile(paths, &asset_id)?;
        let width = decoded.image.width();
        let height = decoded.image.height();
        let upload_bytes = transform::encode_metadata_stripped_png(
            &decoded.image,
            decoded.icc_profile.as_deref(),
        )?;
        if upload_bytes.len() > MAX_UPLOAD_IMAGE_BYTES {
            return Err(format!(
                "metadata-stripped upload for {asset_id} exceeds the 50 MB provider safety limit"
            ));
        }
        let upload_digest = format!("{:x}", Sha256::digest(&upload_bytes));
        let upload_byte_size = upload_bytes.len() as u64;
        prepared.push(RemoteImageEditSource {
            node_id: source.id.clone(),
            asset_id,
            role,
            influence,
            source_digest: asset.digest,
            upload_digest,
            upload_byte_size,
            upload_bytes,
            width,
            height,
        });
    }
    if role_count.get("base") != Some(&1) {
        return Err(
            "remote image edits require exactly one reference with the base role".to_string(),
        );
    }
    prepared.sort_by_key(|source| if source.role == "base" { 0_u8 } else { 1_u8 });
    let upload_bytes = prepared.iter().try_fold(0_u64, |total, source| {
        total
            .checked_add(source.upload_bytes.len() as u64)
            .ok_or_else(|| "remote edit upload byte count overflowed".to_string())
    })?;
    if upload_bytes > MAX_UPLOAD_TOTAL_BYTES {
        return Err("remote image edit uploads exceed the 128 MB run safety limit".to_string());
    }
    let mut provider_prompt = create_remote_edit_provider_prompt(&prompt, edit_strength, &prepared);
    if transparent_background {
        provider_prompt.push_str(
            "\n\nTransparent-output preparation: isolate the requested subject against a single, uniform white studio background. Keep the subject away from every image edge and do not add scenery, shadows that touch the frame, borders, or background texture.",
        );
    }

    Ok(RemoteImageEditFlowPlan {
        flow_id: revision.flow_id,
        flow_name: revision.flow.name,
        revision_id: revision.revision_id,
        prompt,
        provider_prompt,
        task_node_id: task_node.id.clone(),
        model_id,
        model_label: "GPT Image 2".to_string(),
        output_count,
        aspect_ratio,
        output_format,
        model_policy,
        transparent_background,
        subject_cutout_model_priority,
        edit_strength,
        sources: prepared,
        upload_bytes,
    })
}

fn resolve_ordered_flow_nodes(flow: &MediaFlowDocument) -> MediaResult<Vec<MediaFlowNode>> {
    let mut incoming_count = flow
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0_u32))
        .collect::<HashMap<_, _>>();
    let mut outgoing = HashMap::<&str, Vec<&str>>::new();
    for edge in &flow.edges {
        *incoming_count
            .get_mut(edge.to_node_id.as_str())
            .ok_or_else(|| "flow contains an unknown edge target".to_string())? += 1;
        outgoing
            .entry(edge.from_node_id.as_str())
            .or_default()
            .push(edge.to_node_id.as_str());
    }
    let mut ready = flow
        .nodes
        .iter()
        .filter(|node| incoming_count.get(node.id.as_str()) == Some(&0))
        .map(|node| node.id.as_str())
        .collect::<VecDeque<_>>();
    let nodes_by_id = flow
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::with_capacity(flow.nodes.len());
    while let Some(node_id) = ready.pop_front() {
        let node = nodes_by_id
            .get(node_id)
            .ok_or_else(|| "flow topology is inconsistent".to_string())?;
        let mut resolved = (*node).clone();
        resolved.config = flow.resolve_node_config(&node.config)?;
        validate_node_config(&resolved)?;
        ordered.push(resolved);
        if let Some(next_nodes) = outgoing.get(node_id) {
            for next_node_id in next_nodes {
                let count = incoming_count
                    .get_mut(next_node_id)
                    .ok_or_else(|| "flow topology is inconsistent".to_string())?;
                *count -= 1;
                if *count == 0 {
                    ready.push_back(next_node_id);
                }
            }
        }
    }
    if ordered.len() != flow.nodes.len() {
        return Err("flow must be acyclic".to_string());
    }
    Ok(ordered)
}

fn validate_remote_edit_snapshot(
    snapshot: &MediaRunPlanSnapshot,
    nodes: &[MediaFlowNode],
) -> MediaResult<()> {
    let snapshot_nodes = snapshot
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.r#type.as_str()))
        .collect::<HashSet<_>>();
    let resolved_nodes = nodes
        .iter()
        .map(|node| (node.id.as_str(), node.r#type.as_str()))
        .collect::<HashSet<_>>();
    if snapshot_nodes != resolved_nodes {
        return Err("compiled plan nodes do not match the pinned remote edit revision".to_string());
    }

    let expected = create_ralph_plan_steps(nodes)?;
    if expected.len() != snapshot.steps.len() {
        return Err("compiled plan steps do not match the pinned remote edit flow".to_string());
    }
    for (expected, actual) in expected.iter().zip(&snapshot.steps) {
        if expected.source_node_id != actual.source_node_id || expected.kind != actual.kind {
            return Err("compiled plan steps do not match the pinned remote edit flow".to_string());
        }
        let (target, cacheable, side_effect) = match actual.kind.as_str() {
            "normalize-prompt" | "resolve-asset" => ("orchestrator", true, None),
            "resolve-model" => ("orchestrator", false, None),
            "edit-image" => ("remote", false, Some("paid-request")),
            "ingest-asset" => ("orchestrator", false, Some("asset-write")),
            _ => return Err("compiled remote edit plan contains an unsupported step".to_string()),
        };
        if actual.target != target
            || actual.cacheable != cacheable
            || actual.side_effect.as_deref() != side_effect
        {
            return Err(
                "compiled remote edit plan does not disclose its execution target and side effects"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn has_exact_edge(
    flow: &MediaFlowDocument,
    from_node_id: &str,
    from_port_id: &str,
    to_node_id: &str,
    to_port_id: &str,
) -> bool {
    flow.edges.iter().any(|edge| {
        edge.from_node_id == from_node_id
            && edge.from_port_id == from_port_id
            && edge.to_node_id == to_node_id
            && edge.to_port_id == to_port_id
    })
}

fn create_remote_edit_provider_prompt(
    prompt: &str,
    edit_strength: f64,
    sources: &[RemoteImageEditSource],
) -> String {
    let mut instructions = vec![
        prompt.to_string(),
        String::new(),
        "Machdoch reference guidance (images are uploaded in this exact order):".to_string(),
    ];
    for (index, source) in sources.iter().enumerate() {
        instructions.push(format!(
            "- Image {}: {} reference; relative influence {:.3}.",
            index + 1,
            source.role,
            source.influence
        ));
    }
    instructions.push(format!(
        "Apply an overall edit strength of {:.3}; preserve unspecified details from the base image.",
        edit_strength
    ));
    instructions.join("\n")
}

fn local_string_config(node: &MediaFlowNode, key: &str) -> MediaResult<String> {
    node.config
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("flow node {} requires string config {key}", node.id))
}

fn local_u32_config(node: &MediaFlowNode, key: &str) -> MediaResult<u32> {
    node.config
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("flow node {} requires integer config {key}", node.id))
}

fn local_bool_config(node: &MediaFlowNode, key: &str) -> MediaResult<bool> {
    node.config
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("flow node {} requires boolean config {key}", node.id))
}

fn local_subject_cutout_model_priority(node: &MediaFlowNode) -> MediaResult<Vec<String>> {
    let mut model_priority = match node.config.get("modelPriority") {
        None => vec![subject_cutout::BIREFNET_MODEL_ID.to_string()],
        Some(Value::Array(entries)) => entries
            .iter()
            .map(|entry| {
                entry.as_str().map(str::to_string).ok_or_else(|| {
                    format!("flow node {} modelPriority must contain strings", node.id)
                })
            })
            .collect::<MediaResult<Vec<_>>>()?,
        Some(_) => {
            return Err(format!(
                "flow node {} modelPriority must be an ordered string array",
                node.id
            ))
        }
    };
    subject_cutout::validate_model_priority(&mut model_priority)?;
    Ok(model_priority)
}

fn resolve_ralph_config_value(flow: &MediaFlowDocument, value: &Value) -> MediaResult<Value> {
    match value {
        Value::String(text) => {
            if exact_variable_token(text).is_some() {
                return flow.resolve_config_value(value);
            }
            let mut resolved = text.clone();
            for variable in &flow.variables {
                let token = format!("{{{{{}}}}}", variable.id);
                if !resolved.contains(&token) {
                    continue;
                }
                let value = flow
                    .variable_bindings
                    .get(&variable.id)
                    .or(variable.default_value.as_ref())
                    .ok_or_else(|| format!("Ralph media input {} requires a value", variable.id))?;
                let replacement = match value {
                    Value::String(value) => value.clone(),
                    Value::Number(value) => value.to_string(),
                    Value::Bool(value) => value.to_string(),
                    _ => {
                        return Err(format!(
                            "Ralph media input {} cannot be interpolated into text",
                            variable.id
                        ))
                    }
                };
                resolved = resolved.replace(&token, &replacement);
            }
            Ok(Value::String(resolved))
        }
        Value::Array(entries) => entries
            .iter()
            .map(|entry| resolve_ralph_config_value(flow, entry))
            .collect::<MediaResult<Vec<_>>>()
            .map(Value::Array),
        Value::Object(entries) => entries
            .iter()
            .map(|(key, entry)| {
                resolve_ralph_config_value(flow, entry).map(|resolved| (key.clone(), resolved))
            })
            .collect::<MediaResult<Map<_, _>>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

fn create_ralph_plan_steps(nodes: &[MediaFlowNode]) -> MediaResult<Vec<MediaRunPlanStepSnapshot>> {
    let mut steps = Vec::new();
    for node in nodes {
        let create_step = |suffix: &str,
                           kind: &str,
                           label: String,
                           target: &str,
                           cacheable: bool,
                           side_effect: Option<&str>,
                           review: Option<MediaHumanReviewContract>| {
            MediaRunPlanStepSnapshot {
                id: format!("{suffix}:{}", node.id),
                source_node_id: node.id.clone(),
                kind: kind.to_string(),
                label,
                target: target.to_string(),
                cacheable,
                side_effect: side_effect.map(str::to_string),
                review,
            }
        };
        match node.r#type.as_str() {
            "source.prompt" => steps.push(create_step(
                "normalize-prompt",
                "normalize-prompt",
                "Normalize prompt and pinned Ralph bindings".to_string(),
                "orchestrator",
                true,
                None,
                None,
            )),
            "source.image" => steps.push(create_step(
                "resolve-asset",
                "resolve-asset",
                "Resolve immutable source image and verify workspace access".to_string(),
                "orchestrator",
                true,
                None,
                None,
            )),
            "task.generate-image" => {
                steps.push(create_step(
                    "resolve-model",
                    "resolve-model",
                    "Resolve the pinned Media Studio execution policy".to_string(),
                    "orchestrator",
                    false,
                    None,
                    None,
                ));
                if is_svg_vectorization_node(node) {
                    let target = if node
                        .config
                        .get("modelId")
                        .and_then(Value::as_str)
                        .is_some_and(|model_id| model_id.starts_with("local-svg:"))
                    {
                        "local"
                    } else {
                        "remote"
                    };
                    steps.push(create_step(
                        "vectorize-svg",
                        "vectorize-svg",
                        "Vectorize the audited source into verified SVG geometry".to_string(),
                        target,
                        target == "local",
                        (target == "remote").then_some("paid-request"),
                        None,
                    ));
                } else {
                    steps.push(create_step(
                        "generate-image",
                        "generate-image",
                        "Generate with the deterministic pinned-revision fixture".to_string(),
                        "local",
                        true,
                        None,
                        None,
                    ));
                }
            }
            "task.edit-image" => {
                steps.push(create_step(
                    "resolve-model",
                    "resolve-model",
                    "Resolve the pinned Media Studio edit policy".to_string(),
                    "orchestrator",
                    false,
                    None,
                    None,
                ));
                steps.push(create_step(
                    "edit-image",
                    "edit-image",
                    "Edit with the deterministic pinned-revision fixture".to_string(),
                    "local",
                    true,
                    None,
                    None,
                ));
            }
            "operation.crop" => steps.push(create_step(
                "crop-image",
                "crop-image",
                "Validate bounds and crop immutable source pixels".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.resize" => steps.push(create_step(
                "resize-image",
                "resize-image",
                "Resize with the explicit target box and fit policy".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.format-convert" => steps.push(create_step(
                "convert-image",
                "convert-image",
                "Re-encode pixels and verify output metadata".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.metadata-strip" => steps.push(create_step(
                "strip-metadata",
                "strip-metadata",
                "Apply orientation and remove private image metadata".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.auto-tag" => steps.push(create_step(
                "auto-tag",
                "auto-tag",
                "Apply deterministic format, shape, resolution, and asset-role tags".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.contact-sheet" => steps.push(create_step(
                "create-contact-sheet",
                "create-contact-sheet",
                "Compose the bounded image collection into a comparison sheet".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.subject-cutout" => {
                let model_priority = local_subject_cutout_model_priority(node)?;
                steps.push(create_step(
                    "cutout-subject",
                    "cutout-subject",
                    format!(
                        "Cut out subject · {}",
                        subject_cutout::format_model_priority(&model_priority)
                    ),
                    "local",
                    true,
                    None,
                    None,
                ));
            }
            "operation.alpha-matte" => steps.push(create_step(
                "extract-alpha-matte",
                "extract-alpha-matte",
                "Extract the exact 8-bit alpha channel as a grayscale matte".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.composite" => steps.push(create_step(
                "composite-image",
                "composite-image",
                "Scale, center, and alpha-blend foreground over background".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "operation.quality-analyze" => steps.push(create_step(
                "analyze-quality",
                "analyze-quality",
                "Measure deterministic technical quality".to_string(),
                "local",
                true,
                None,
                None,
            )),
            "control.quality-gate" => steps.push(create_step(
                "evaluate-gate",
                "evaluate-gate",
                "Evaluate the pinned quality profile".to_string(),
                "orchestrator",
                true,
                None,
                None,
            )),
            "control.human-review" => {
                let instructions = node
                    .config
                    .get("instructions")
                    .and_then(Value::as_str)
                    .unwrap_or("Review the generated candidates before publication.")
                    .to_string();
                let max_selections = node
                    .config
                    .get("maxSelections")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(1);
                let require_comment = node
                    .config
                    .get("requireComment")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                steps.push(create_step(
                    "wait-for-review",
                    "wait-for-review",
                    format!("Pause for human review · approve up to {max_selections}"),
                    "orchestrator",
                    false,
                    None,
                    Some(MediaHumanReviewContract {
                        instructions,
                        max_selections,
                        require_comment,
                    }),
                ));
            }
            "output.asset" => steps.push(create_step(
                "ingest-asset",
                "ingest-asset",
                "Validate, hash, and publish immutable assets".to_string(),
                "orchestrator",
                false,
                Some("asset-write"),
                None,
            )),
            _ => {
                return Err(format!(
                    "Ralph media bridge cannot compile node type {}",
                    node.r#type
                ))
            }
        }
    }
    Ok(steps)
}

pub(crate) fn create_ralph_fixture_run_request(
    paths: &MediaRuntimePaths,
    request: &RalphMediaFlowRunRequest,
) -> MediaResult<EnqueueFixtureRunRequest> {
    database::ensure_initialized(paths)?;
    let connection = database::open(paths)?;
    let revision = read_revision_by_id(&connection, &request.revision_id)?;
    if revision.flow_id != request.flow_id {
        return Err("Ralph media flowId does not match the pinned revision".to_string());
    }

    let mut flow = revision.flow.clone();
    for (variable_id, binding) in &request.input_bindings {
        let variable = flow
            .variables
            .iter()
            .find(|variable| variable.id == *variable_id)
            .ok_or_else(|| {
                format!("Ralph media binding {variable_id} is not declared by the pinned flow")
            })?;
        variable.validate_value(&binding.value)?;
        flow.variable_bindings
            .insert(variable_id.clone(), binding.value.clone());
    }
    for variable in &flow.variables {
        if variable.required
            && !flow.variable_bindings.contains_key(&variable.id)
            && variable.default_value.is_none()
        {
            return Err(format!(
                "Ralph media input {} is required by the pinned flow",
                variable.id
            ));
        }
    }
    flow.validate()?;

    let mut resolved_nodes = flow.nodes.clone();
    for node in &mut resolved_nodes {
        node.config = node
            .config
            .iter()
            .map(|(key, value)| {
                resolve_ralph_config_value(&flow, value).map(|resolved| (key.clone(), resolved))
            })
            .collect::<MediaResult<Map<_, _>>>()?;
    }
    let prompt_node = resolved_nodes
        .iter()
        .find(|node| node.r#type == "source.prompt")
        .ok_or_else(|| "Pinned Ralph media flow has no prompt source".to_string())?;
    let prompt = prompt_node
        .config
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pinned Ralph media flow prompt is invalid".to_string())?
        .to_string();
    let image_task_node = resolved_nodes
        .iter()
        .find(|node| {
            matches!(
                node.r#type.as_str(),
                "task.generate-image" | "task.edit-image"
            )
        })
        .ok_or_else(|| "Pinned Ralph media flow has no supported image task".to_string())?;
    if image_task_node.r#type == "task.edit-image" {
        let source_asset_id = resolved_nodes
            .iter()
            .find(|node| node.r#type == "source.image")
            .and_then(|node| node.config.get("assetId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Pinned Ralph image edit requires a stable Media Studio source asset".to_string()
            })?;
        validate_text("flow.node.config.assetId", source_asset_id, 256, false)?;
    }
    let output_count = image_task_node
        .config
        .get("outputCount")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "Pinned Ralph media flow outputCount is invalid".to_string())?;
    let aspect_ratio = image_task_node
        .config
        .get("aspectRatio")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pinned Ralph media flow aspectRatio is invalid".to_string())?
        .to_string();

    let sorted_bindings = request
        .input_bindings
        .iter()
        .map(|(key, binding)| (key.clone(), &binding.value))
        .collect::<BTreeMap<_, _>>();
    let plan_digest = digest_value(&json!({
        "flowId": request.flow_id,
        "revisionId": request.revision_id,
        "bindings": sorted_bindings,
    }))?;
    let plan_id = format!("ralph-plan:{}", &plan_digest[..48]);
    let compiled_at = chrono::Utc::now().to_rfc3339();
    let plan_snapshot = MediaRunPlanSnapshot {
        schema_version: 1,
        plan_id: plan_id.clone(),
        flow_id: flow.id.clone(),
        flow_fingerprint: revision.execution_digest.clone(),
        compiled_at,
        nodes: resolved_nodes
            .iter()
            .map(|node| MediaRunPlanNodeSnapshot {
                id: node.id.clone(),
                r#type: node.r#type.clone(),
                label: node.label.clone(),
                layer: node.layer.clone(),
            })
            .collect(),
        steps: create_ralph_plan_steps(&resolved_nodes)?,
    };

    Ok(EnqueueFixtureRunRequest {
        run_id: request.run_id.clone(),
        flow_id: flow.id,
        flow_revision_id: Some(revision.revision_id),
        flow_name: flow.name,
        plan_id,
        prompt,
        model_label: "Deterministic fixture · pinned Media Studio revision".to_string(),
        target: Some("local".to_string()),
        output_count,
        diagnostic_count: 0,
        aspect_ratio,
        plan_snapshot: Some(plan_snapshot),
    })
}

pub(crate) fn save(
    paths: &MediaRuntimePaths,
    request: &SaveMediaFlowRevisionRequest,
) -> MediaResult<SaveMediaFlowRevisionResult> {
    database::ensure_initialized(paths)?;
    request.validate()?;

    let document_digest = digest_value(&document_projection(&request.flow)?)?;
    let execution_digest = digest_value(&execution_projection(&request.flow))?;
    let layout_digest = digest_value(&layout_projection(&request.layout))?;
    let request_digest = digest_value(&json!({
        "schemaVersion": request.schema_version,
        "expectedHeadRevisionId": request.expected_head_revision_id,
        "changeSummary": request.change_summary,
        "flow": request.flow,
        "layout": request.layout,
    }))?;

    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to lock flow revision head: {error}"))?;

    if let Some((saved_request_digest, revision_id)) = transaction
        .query_row(
            "SELECT request_digest, revision_id FROM flow_save_requests
             WHERE flow_id = ?1 AND idempotency_key = ?2",
            params![request.flow.id, request.idempotency_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to inspect flow save idempotency key: {error}"))?
    {
        if saved_request_digest != request_digest {
            return Err(
                "flow revision conflict: idempotency key was reused with a different request"
                    .to_string(),
            );
        }
        let head = read_head(&transaction, &request.flow.id)?
            .ok_or_else(|| "flow revision storage is inconsistent: head is missing".to_string())?;
        let revision = read_revision(&transaction, &revision_id, &head.head_revision_id)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to finish idempotent flow save: {error}"))?;
        return Ok(SaveMediaFlowRevisionResult {
            schema_version: 1,
            created: false,
            head,
            revision,
        });
    }

    let current_head = read_head(&transaction, &request.flow.id)?;
    let actual_head_revision_id = current_head
        .as_ref()
        .map(|head| head.head_revision_id.as_str());
    if request.expected_head_revision_id.as_deref() != actual_head_revision_id {
        return Err(format!(
            "flow revision conflict: expected head {:?} does not match current head {:?}",
            request.expected_head_revision_id, actual_head_revision_id
        ));
    }

    if let Some(head) = current_head.as_ref().filter(|head| {
        head.document_digest == document_digest
            && head.execution_digest == execution_digest
            && head.layout_digest == layout_digest
    }) {
        transaction
            .execute(
                "INSERT INTO flow_save_requests(
                   flow_id, idempotency_key, request_digest, revision_id, created_revision, created_at
                 ) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![
                    request.flow.id,
                    request.idempotency_key,
                    request_digest,
                    head.head_revision_id,
                    database::now(),
                ],
            )
            .map_err(|error| format!("failed to record no-op flow save: {error}"))?;
        let revision = read_revision(&transaction, &head.head_revision_id, &head.head_revision_id)?;
        let head = head.clone();
        transaction
            .commit()
            .map_err(|error| format!("failed to commit no-op flow save: {error}"))?;
        return Ok(SaveMediaFlowRevisionResult {
            schema_version: 1,
            created: false,
            head,
            revision,
        });
    }

    let parent_revision_id = current_head
        .as_ref()
        .map(|head| head.head_revision_id.clone());
    let revision_number = current_head
        .as_ref()
        .map_or(1, |head| head.head_revision_number + 1);
    let created_at = database::now();
    let revision_id =
        create_revision_id(&request.flow.id, &request.idempotency_key, &request_digest);
    let artifact_relative_path = artifact_relative_path(&request.flow.id, &revision_id);
    write_revision_artifact(
        paths,
        &artifact_relative_path,
        json!({
            "schemaVersion": 1,
            "revisionId": revision_id,
            "flowId": request.flow.id,
            "revisionNumber": revision_number,
            "parentRevisionId": parent_revision_id,
            "createdAt": created_at,
            "changeSummary": request.change_summary,
            "documentDigest": document_digest,
            "executionDigest": execution_digest,
            "layoutDigest": layout_digest,
            "flow": request.flow,
            "layout": request.layout,
        }),
    )?;
    let flow_json = serde_json::to_string(&request.flow)
        .map_err(|error| format!("failed to encode flow revision: {error}"))?;
    let layout_json = serde_json::to_string(&request.layout)
        .map_err(|error| format!("failed to encode flow layout revision: {error}"))?;

    transaction
        .execute(
            "INSERT INTO flow_revisions(
               revision_id, flow_id, revision_number, parent_revision_id, created_at,
               change_summary, document_digest, execution_digest, layout_digest,
               node_count, edge_count, flow_json, layout_json, artifact_relative_path
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                revision_id,
                request.flow.id,
                revision_number,
                parent_revision_id,
                created_at,
                request.change_summary,
                document_digest,
                execution_digest,
                layout_digest,
                request.flow.nodes.len() as u32,
                request.flow.edges.len() as u32,
                flow_json,
                layout_json,
                artifact_relative_path,
            ],
        )
        .map_err(|error| format!("failed to append immutable flow revision: {error}"))?;
    transaction
        .execute(
            "INSERT INTO flows(
               id, name, description, head_revision_id, head_revision_number, created_at,
               updated_at, document_digest, execution_digest, layout_digest
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               head_revision_id = excluded.head_revision_id,
               head_revision_number = excluded.head_revision_number,
               updated_at = excluded.updated_at,
               document_digest = excluded.document_digest,
               execution_digest = excluded.execution_digest,
               layout_digest = excluded.layout_digest",
            params![
                request.flow.id,
                request.flow.name,
                request.flow.description,
                revision_id,
                revision_number,
                request.flow.created_at,
                created_at,
                document_digest,
                execution_digest,
                layout_digest,
            ],
        )
        .map_err(|error| format!("failed to advance flow revision head: {error}"))?;
    transaction
        .execute(
            "INSERT INTO flow_save_requests(
               flow_id, idempotency_key, request_digest, revision_id, created_revision, created_at
             ) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            params![
                request.flow.id,
                request.idempotency_key,
                request_digest,
                revision_id,
                created_at,
            ],
        )
        .map_err(|error| format!("failed to record flow save idempotency key: {error}"))?;

    let head = read_head(&transaction, &request.flow.id)?.ok_or_else(|| {
        "flow revision storage is inconsistent: updated head is missing".to_string()
    })?;
    let revision = read_revision(&transaction, &revision_id, &head.head_revision_id)?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit immutable flow revision: {error}"))?;
    Ok(SaveMediaFlowRevisionResult {
        schema_version: 1,
        created: true,
        head,
        revision,
    })
}

pub(crate) fn export_revision(
    paths: &MediaRuntimePaths,
    request: &ExportMediaFlowRevisionRequest,
) -> MediaResult<MediaFlowExportResult> {
    database::ensure_initialized(paths)?;
    request.validate()?;
    let destination = validate_flow_export_destination(&request.destination_path)?;
    let connection = database::open(paths)?;
    let revision = read_revision_by_id(&connection, &request.revision_id)?;
    let exported_at = database::now();
    let requirements = node_requirements(&revision.flow.nodes);
    let bundle = MediaFlowBundle {
        schema_uri: FLOW_BUNDLE_SCHEMA_URI.to_string(),
        kind: FLOW_BUNDLE_KIND.to_string(),
        schema_version: 1,
        exported_at: exported_at.clone(),
        source: MediaFlowBundleSource {
            flow_id: revision.flow_id.clone(),
            revision_id: revision.revision_id.clone(),
            revision_number: revision.revision_number,
            document_digest: revision.document_digest.clone(),
            execution_digest: revision.execution_digest.clone(),
            layout_digest: revision.layout_digest.clone(),
        },
        requirements: MediaFlowBundleRequirements {
            flow_schema_version: revision.flow.schema_version,
            layout_schema_version: revision.layout.schema_version,
            node_types: requirements
                .iter()
                .map(|requirement| MediaFlowBundleNodeRequirement {
                    node_type: requirement.node_type.clone(),
                    version: requirement.version,
                })
                .collect(),
        },
        flow: serde_json::to_value(&revision.flow)
            .map_err(|error| format!("failed to encode exported flow: {error}"))?,
        layout: serde_json::to_value(&revision.layout)
            .map_err(|error| format!("failed to encode exported flow layout: {error}"))?,
    };
    let mut bytes = serde_json::to_vec_pretty(&bundle)
        .map_err(|error| format!("failed to encode portable flow bundle: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_FLOW_BUNDLE_BYTES {
        return Err(format!(
            "Portable flow bundle exceeds the {} MB encoded-byte limit",
            MAX_FLOW_BUNDLE_BYTES / 1024 / 1024
        ));
    }
    let bundle_digest = prefixed_bytes_digest(&bytes);
    crate::atomic_file::write_file_atomic(
        &destination,
        &bytes,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("failed to atomically export portable flow bundle: {error}"))?;
    let verified = fs::read(&destination)
        .map_err(|error| format!("failed to verify exported portable flow bundle: {error}"))?;
    if prefixed_bytes_digest(&verified) != bundle_digest {
        return Err("Exported portable flow bundle failed SHA-256 verification".to_string());
    }
    Ok(MediaFlowExportResult {
        schema_version: 1,
        revision_id: revision.revision_id,
        file_name: destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("media-flow.json")
            .to_string(),
        byte_size: bytes.len() as u64,
        bundle_digest,
        exported_at,
        requirement_count: requirements.len() as u32,
    })
}

pub(crate) fn inspect_import(
    paths: &MediaRuntimePaths,
    request: &InspectMediaFlowImportRequest,
) -> MediaResult<MediaFlowImportInspection> {
    database::ensure_initialized(paths)?;
    if request.schema_version != 1 {
        return Err("flow import inspection schemaVersion must be 1".to_string());
    }
    Ok(review_flow_bundle(paths, &request.source_path)?.inspection)
}

pub(crate) fn import_reviewed(
    paths: &MediaRuntimePaths,
    request: &ImportMediaFlowRequest,
) -> MediaResult<ImportMediaFlowResult> {
    database::ensure_initialized(paths)?;
    if request.schema_version != 1 {
        return Err("flow import schemaVersion must be 1".to_string());
    }
    validate_text("idempotencyKey", &request.idempotency_key, 128, false)?;
    validate_text("reviewToken", &request.review_token, 128, false)?;

    let reviewed = review_flow_bundle(paths, &request.source_path)?;
    if reviewed.inspection.review_token != request.review_token {
        return Err(
            "Flow import review is stale; inspect the selected file again before importing"
                .to_string(),
        );
    }
    if reviewed.inspection.status != MediaFlowImportStatus::Ready {
        return Err(
            "Flow import is inspect-only and cannot create a runnable revision".to_string(),
        );
    }
    let bundle = reviewed
        .bundle
        .ok_or_else(|| "Validated flow bundle envelope is missing".to_string())?;
    let mut flow = reviewed
        .flow
        .ok_or_else(|| "Validated flow bundle document is missing".to_string())?;
    let mut layout = reviewed
        .layout
        .ok_or_else(|| "Validated flow bundle layout is missing".to_string())?;
    let target_flow_id = reviewed
        .inspection
        .proposed_flow_id
        .clone()
        .ok_or_else(|| "Flow import review did not produce a safe target identity".to_string())?;
    flow.id = target_flow_id.clone();
    layout.flow_id = target_flow_id.clone();
    flow.validate()?;
    layout.validate(&flow)?;

    let current_head = read_head(&database::open(paths)?, &target_flow_id)?;
    let save_result = save(
        paths,
        &SaveMediaFlowRevisionRequest {
            schema_version: 1,
            idempotency_key: create_import_idempotency_key(
                &request.idempotency_key,
                &reviewed.inspection.bundle_digest,
            ),
            expected_head_revision_id: current_head.map(|head| head.head_revision_id),
            change_summary: format!(
                "Imported isolated copy from {}",
                reviewed.inspection.source_display_name
            ),
            flow,
            layout,
        },
    )?;

    let artifact_relative_path = import_artifact_relative_path(
        &save_result.revision.revision_id,
        &reviewed.inspection.bundle_digest,
    );
    write_import_artifact(paths, &artifact_relative_path, &reviewed.bytes)?;
    let report_json = serde_json::to_string(&reviewed.inspection)
        .map_err(|error| format!("failed to encode flow import report: {error}"))?;
    let connection = database::open(paths)?;
    connection
        .execute(
            "INSERT INTO flow_revision_imports(
               revision_id, bundle_digest, source_flow_id, source_revision_id,
               source_display_name, review_token, imported_at, report_json,
               bundle_artifact_relative_path
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(revision_id) DO NOTHING",
            params![
                save_result.revision.revision_id,
                reviewed.inspection.bundle_digest,
                bundle.source.flow_id,
                bundle.source.revision_id,
                reviewed.inspection.source_display_name,
                reviewed.inspection.review_token,
                database::now(),
                report_json,
                artifact_relative_path,
            ],
        )
        .map_err(|error| format!("failed to record immutable flow import provenance: {error}"))?;

    Ok(ImportMediaFlowResult {
        schema_version: 1,
        created: save_result.created,
        bundle_digest: reviewed.inspection.bundle_digest,
        source_flow_id: bundle.source.flow_id,
        source_revision_id: bundle.source.revision_id,
        target_flow_id,
        import_mutations: reviewed.inspection.import_mutations,
        head: save_result.head,
        revision: save_result.revision,
    })
}

impl ExportMediaFlowRevisionRequest {
    fn validate(&self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("flow export schemaVersion must be 1".to_string());
        }
        validate_text("idempotencyKey", &self.idempotency_key, 128, false)?;
        validate_text("revisionId", &self.revision_id, 128, false)
    }
}

fn review_flow_bundle(
    paths: &MediaRuntimePaths,
    source_path: &str,
) -> MediaResult<ReviewedFlowBundle> {
    let (source_path, source_display_name) = validate_flow_import_source(source_path)?;
    let bytes = fs::read(&source_path)
        .map_err(|error| format!("failed to read selected flow bundle: {error}"))?;
    let bundle_digest = prefixed_bytes_digest(&bytes);
    let mut inspection = empty_import_inspection(&source_display_name, &bundle_digest);
    let value = match parse_strict_json(&bytes) {
        Ok(value) => value,
        Err(error) => {
            inspection.issues.push(import_issue(
                "error",
                "MALFORMED_BUNDLE",
                format!("The selected file is not strict portable-flow JSON: {error}"),
                None,
            ));
            finalize_inspection(&mut inspection);
            return Ok(ReviewedFlowBundle {
                bytes,
                inspection,
                bundle: None,
                flow: None,
                layout: None,
            });
        }
    };
    let bundle = match serde_json::from_value::<MediaFlowBundle>(value) {
        Ok(bundle) => bundle,
        Err(error) => {
            inspection.issues.push(import_issue(
                "error",
                "INVALID_BUNDLE_ENVELOPE",
                format!(
                    "The portable-flow envelope is incomplete or contains unknown fields: {error}"
                ),
                None,
            ));
            finalize_inspection(&mut inspection);
            return Ok(ReviewedFlowBundle {
                bytes,
                inspection,
                bundle: None,
                flow: None,
                layout: None,
            });
        }
    };

    inspection.bundle_schema_version = Some(bundle.schema_version);
    inspection.source_flow_id = Some(bundle.source.flow_id.clone());
    inspection.source_revision_id = Some(bundle.source.revision_id.clone());
    inspection.document_digest = Some(bundle.source.document_digest.clone());
    inspection.execution_digest = Some(bundle.source.execution_digest.clone());
    inspection.layout_digest = Some(bundle.source.layout_digest.clone());
    inspect_bundle_envelope(&bundle, &mut inspection);

    let (node_count, edge_count, requirements, tombstones) =
        inspect_raw_graph(&bundle.flow, &mut inspection.issues);
    inspection.node_count = node_count;
    inspection.edge_count = edge_count;
    inspection.requirements = requirements;
    inspection.unknown_nodes = tombstones;
    inspection.source_flow_name = bundle
        .flow
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);

    validate_bundle_requirements(&bundle, &mut inspection);
    validate_bundle_identity_and_digests(&bundle, &mut inspection);

    if bundle.schema_version != 1
        || bundle.requirements.flow_schema_version != 1
        || bundle.requirements.layout_schema_version != 1
        || !inspection.unknown_nodes.is_empty()
    {
        if inspection.status != MediaFlowImportStatus::Invalid {
            inspection.status = MediaFlowImportStatus::InspectOnly;
        }
        if bundle.schema_version != 1 {
            inspection.issues.push(import_issue(
                "warning",
                "NEWER_BUNDLE_SCHEMA",
                format!(
                    "Bundle schema {} is not runnable by this app version.",
                    bundle.schema_version
                ),
                None,
            ));
        }
        if bundle.requirements.flow_schema_version != 1
            || bundle.requirements.layout_schema_version != 1
        {
            inspection.issues.push(import_issue(
                "warning",
                "NEWER_FLOW_SCHEMA",
                "The flow or layout schema needs an explicit migration before it can run."
                    .to_string(),
                None,
            ));
        }
    }

    let mut flow = None;
    let mut layout = None;
    if inspection.status == MediaFlowImportStatus::Ready {
        match (
            serde_json::from_value::<MediaFlowDocument>(bundle.flow.clone()),
            serde_json::from_value::<MediaFlowLayoutDocument>(bundle.layout.clone()),
        ) {
            (Ok(candidate_flow), Ok(candidate_layout)) => {
                if let Err(error) = candidate_flow
                    .validate()
                    .and_then(|_| candidate_layout.validate(&candidate_flow))
                {
                    inspection.status = MediaFlowImportStatus::Invalid;
                    inspection.issues.push(import_issue(
                        "error",
                        "INVALID_FLOW_GRAPH",
                        error,
                        None,
                    ));
                } else if digest_value(&execution_projection(&candidate_flow))?
                    != bundle.source.execution_digest
                {
                    inspection.status = MediaFlowImportStatus::Invalid;
                    inspection.issues.push(import_issue(
                        "error",
                        "EXECUTION_DIGEST_MISMATCH",
                        "The bundle execution digest does not match its validated graph."
                            .to_string(),
                        None,
                    ));
                } else {
                    let proposed = select_import_target(
                        paths,
                        &bundle.source.flow_id,
                        &bundle_digest,
                        &candidate_flow,
                        &candidate_layout,
                    )?;
                    inspection.import_mutations.push(format!(
                        "Flow identity is isolated from {} to {} so existing work cannot be overwritten.",
                        bundle.source.flow_id, proposed
                    ));
                    inspection.proposed_flow_id = Some(proposed);
                    flow = Some(candidate_flow);
                    layout = Some(candidate_layout);
                }
            }
            (Err(error), _) | (_, Err(error)) => {
                inspection.status = MediaFlowImportStatus::Invalid;
                inspection.issues.push(import_issue(
                    "error",
                    "INVALID_FLOW_DOCUMENT",
                    format!("The flow document does not match schema version 1: {error}"),
                    None,
                ));
            }
        }
    }

    finalize_inspection(&mut inspection);
    Ok(ReviewedFlowBundle {
        bytes,
        inspection,
        bundle: Some(bundle),
        flow,
        layout,
    })
}

fn empty_import_inspection(
    source_display_name: &str,
    bundle_digest: &str,
) -> MediaFlowImportInspection {
    MediaFlowImportInspection {
        schema_version: 1,
        status: MediaFlowImportStatus::Ready,
        can_import: false,
        review_token: String::new(),
        source_display_name: source_display_name.to_string(),
        bundle_digest: bundle_digest.to_string(),
        bundle_schema_version: None,
        source_flow_id: None,
        source_flow_name: None,
        source_revision_id: None,
        proposed_flow_id: None,
        node_count: 0,
        edge_count: 0,
        document_digest: None,
        execution_digest: None,
        layout_digest: None,
        requirements: Vec::new(),
        issues: Vec::new(),
        unknown_nodes: Vec::new(),
        import_mutations: Vec::new(),
    }
}

fn inspect_bundle_envelope(bundle: &MediaFlowBundle, inspection: &mut MediaFlowImportInspection) {
    if bundle.kind != FLOW_BUNDLE_KIND {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.issues.push(import_issue(
            "error",
            "UNSUPPORTED_BUNDLE_KIND",
            format!("Expected bundle kind {FLOW_BUNDLE_KIND}."),
            None,
        ));
    }
    if bundle.schema_version == 1 && bundle.schema_uri != FLOW_BUNDLE_SCHEMA_URI {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.issues.push(import_issue(
            "error",
            "SCHEMA_URI_MISMATCH",
            "The bundle schema URI does not match schema version 1.".to_string(),
            None,
        ));
    }
    if validate_timestamp("bundle.exportedAt", &bundle.exported_at).is_err() {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.issues.push(import_issue(
            "error",
            "INVALID_EXPORT_TIMESTAMP",
            "The bundle export timestamp must be RFC 3339.".to_string(),
            None,
        ));
    }
    if bundle.source.revision_number == 0
        || validate_text("bundle.source.flowId", &bundle.source.flow_id, 128, false).is_err()
        || validate_text(
            "bundle.source.revisionId",
            &bundle.source.revision_id,
            128,
            false,
        )
        .is_err()
        || !is_sha256_digest(&bundle.source.document_digest)
        || !is_sha256_digest(&bundle.source.execution_digest)
        || !is_sha256_digest(&bundle.source.layout_digest)
    {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.issues.push(import_issue(
            "error",
            "INVALID_SOURCE_IDENTITY",
            "The bundle source identity or digest fields are invalid.".to_string(),
            None,
        ));
    }
}

fn inspect_raw_graph(
    flow: &Value,
    issues: &mut Vec<MediaFlowImportIssue>,
) -> (
    u32,
    u32,
    Vec<MediaFlowNodeRequirement>,
    Vec<MediaFlowUnknownNodeTombstone>,
) {
    let Some(flow_object) = flow.as_object() else {
        issues.push(import_issue(
            "error",
            "INVALID_FLOW_DOCUMENT",
            "The bundle flow must be a JSON object.".to_string(),
            None,
        ));
        return (0, 0, Vec::new(), Vec::new());
    };
    let Some(nodes) = flow_object.get("nodes").and_then(Value::as_array) else {
        issues.push(import_issue(
            "error",
            "INVALID_FLOW_NODES",
            "The bundle flow requires a nodes array.".to_string(),
            None,
        ));
        return (0, 0, Vec::new(), Vec::new());
    };
    let edges = flow_object
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if nodes.is_empty() || nodes.len() > MAX_FLOW_NODES || edges.len() > MAX_FLOW_EDGES {
        issues.push(import_issue(
            "error",
            "FLOW_BOUNDS_EXCEEDED",
            format!(
                "Portable flows support 1–{MAX_FLOW_NODES} nodes and at most {MAX_FLOW_EDGES} edges."
            ),
            None,
        ));
    }

    let mut requirements = Vec::new();
    let mut tombstones = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        let node_id = node
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("unknown-node-{index}"));
        let node_type = node
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let version = node
            .get("version")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok());
        let supported = version.is_some_and(|version| is_supported_node(&node_type, version));
        if let Some(version) = version {
            requirements.push(MediaFlowNodeRequirement {
                node_type: node_type.clone(),
                version,
                supported,
            });
        }
        if !supported {
            let connected_edges = edges
                .iter()
                .filter(|edge| {
                    edge.get("fromNodeId").and_then(Value::as_str) == Some(node_id.as_str())
                        || edge.get("toNodeId").and_then(Value::as_str) == Some(node_id.as_str())
                })
                .cloned()
                .collect();
            tombstones.push(MediaFlowUnknownNodeTombstone {
                schema_version: 1,
                node_id: node_id.clone(),
                node_type: node_type.clone(),
                version,
                original_node: node.clone(),
                connected_edges,
            });
            issues.push(import_issue(
                "warning",
                "UNKNOWN_NODE_VERSION",
                format!(
                    "Node {node_id} requires {node_type}@{} and is preserved as a read-only tombstone.",
                    version.map_or_else(|| "unknown".to_string(), |value| value.to_string())
                ),
                Some(node_id),
            ));
        }
    }
    requirements.sort_by(|left, right| {
        (&left.node_type, left.version).cmp(&(&right.node_type, right.version))
    });
    requirements
        .dedup_by(|left, right| left.node_type == right.node_type && left.version == right.version);
    (
        nodes.len() as u32,
        edges.len() as u32,
        requirements,
        tombstones,
    )
}

fn validate_bundle_requirements(
    bundle: &MediaFlowBundle,
    inspection: &mut MediaFlowImportInspection,
) {
    let flow_schema = bundle.flow.get("schemaVersion").and_then(Value::as_u64);
    let layout_schema = bundle.layout.get("schemaVersion").and_then(Value::as_u64);
    let declared = bundle
        .requirements
        .node_types
        .iter()
        .map(|entry| (&entry.node_type, entry.version))
        .collect::<Vec<_>>();
    let actual = inspection
        .requirements
        .iter()
        .map(|entry| (&entry.node_type, entry.version))
        .collect::<Vec<_>>();
    if flow_schema != Some(u64::from(bundle.requirements.flow_schema_version))
        || layout_schema != Some(u64::from(bundle.requirements.layout_schema_version))
        || declared != actual
    {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.issues.push(import_issue(
            "error",
            "REQUIREMENT_MANIFEST_MISMATCH",
            "The declared flow, layout, or node requirements do not match the bundled documents."
                .to_string(),
            None,
        ));
    }
}

fn validate_bundle_identity_and_digests(
    bundle: &MediaFlowBundle,
    inspection: &mut MediaFlowImportInspection,
) {
    let flow_id = bundle.flow.get("id").and_then(Value::as_str);
    let layout_flow_id = bundle.layout.get("flowId").and_then(Value::as_str);
    if flow_id != Some(bundle.source.flow_id.as_str()) || layout_flow_id != flow_id {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.issues.push(import_issue(
            "error",
            "FLOW_IDENTITY_MISMATCH",
            "The bundle source, flow, and layout identities do not match.".to_string(),
            None,
        ));
    }
    let document_digest =
        raw_document_projection(&bundle.flow).and_then(|value| digest_value(&value));
    let layout_digest =
        raw_layout_projection(&bundle.layout).and_then(|value| digest_value(&value));
    if document_digest.as_deref() != Ok(bundle.source.document_digest.as_str())
        || layout_digest.as_deref() != Ok(bundle.source.layout_digest.as_str())
    {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.issues.push(import_issue(
            "error",
            "DOCUMENT_DIGEST_MISMATCH",
            "The bundle flow or layout digest does not match its source manifest.".to_string(),
            None,
        ));
    }
}

fn raw_document_projection(flow: &Value) -> MediaResult<Value> {
    let mut projection = flow
        .as_object()
        .cloned()
        .ok_or_else(|| "flow document must be a JSON object".to_string())?;
    for field in ["variables", "presets"] {
        if projection
            .get(field)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            projection.remove(field);
        }
    }
    if projection
        .get("variableBindings")
        .and_then(Value::as_object)
        .is_some_and(Map::is_empty)
    {
        projection.remove("variableBindings");
    }
    if projection.get("activePresetId").is_some_and(Value::is_null) {
        projection.remove("activePresetId");
    }
    Ok(Value::Object(projection))
}

fn raw_layout_projection(layout: &Value) -> MediaResult<Value> {
    let schema_version = layout
        .get("schemaVersion")
        .cloned()
        .ok_or_else(|| "flow layout is missing schemaVersion".to_string())?;
    let flow_id = layout
        .get("flowId")
        .cloned()
        .ok_or_else(|| "flow layout is missing flowId".to_string())?;
    let mut nodes = layout
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "flow layout is missing nodes".to_string())?;
    nodes.sort_by(|left, right| {
        left.get("nodeId")
            .and_then(Value::as_str)
            .cmp(&right.get("nodeId").and_then(Value::as_str))
    });
    let mut projection = json!({
        "schemaVersion": schema_version,
        "flowId": flow_id,
        "nodes": nodes,
    });
    if let Some(groups) = layout.get("groups").and_then(Value::as_array) {
        if !groups.is_empty() {
            let mut groups = groups.clone();
            groups.sort_by(|left, right| {
                left.get("id")
                    .and_then(Value::as_str)
                    .cmp(&right.get("id").and_then(Value::as_str))
            });
            for group in &mut groups {
                if let Some(node_ids) = group.get_mut("nodeIds").and_then(Value::as_array_mut) {
                    node_ids.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
                }
            }
            projection["groups"] = json!(groups);
        }
    }
    if let Some(comments) = layout.get("comments").and_then(Value::as_array) {
        if !comments.is_empty() {
            let mut comments = comments.clone();
            comments.sort_by(|left, right| {
                left.get("id")
                    .and_then(Value::as_str)
                    .cmp(&right.get("id").and_then(Value::as_str))
            });
            projection["comments"] = json!(comments);
        }
    }
    Ok(projection)
}

fn finalize_inspection(inspection: &mut MediaFlowImportInspection) {
    if inspection
        .issues
        .iter()
        .any(|issue| issue.severity == "error")
    {
        inspection.status = MediaFlowImportStatus::Invalid;
        inspection.proposed_flow_id = None;
        inspection.import_mutations.clear();
    }
    inspection.can_import = inspection.status == MediaFlowImportStatus::Ready;
    inspection.review_token = create_review_token(
        &inspection.bundle_digest,
        inspection.status,
        inspection.proposed_flow_id.as_deref(),
    );
}

fn import_issue(
    severity: &'static str,
    code: impl Into<String>,
    message: impl Into<String>,
    node_id: Option<String>,
) -> MediaFlowImportIssue {
    MediaFlowImportIssue {
        severity,
        code: code.into(),
        message: message.into(),
        node_id,
    }
}

fn node_requirements(nodes: &[MediaFlowNode]) -> Vec<MediaFlowNodeRequirement> {
    let mut requirements = nodes
        .iter()
        .map(|node| MediaFlowNodeRequirement {
            node_type: node.r#type.clone(),
            version: node.version,
            supported: is_supported_node(&node.r#type, node.version),
        })
        .collect::<Vec<_>>();
    requirements.sort_by(|left, right| {
        (&left.node_type, left.version).cmp(&(&right.node_type, right.version))
    });
    requirements
        .dedup_by(|left, right| left.node_type == right.node_type && left.version == right.version);
    requirements
}

fn is_supported_node(node_type: &str, version: u32) -> bool {
    version == 1
        && matches!(
            node_type,
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
                | "operation.composite"
                | "operation.quality-analyze"
                | "control.quality-gate"
                | "control.human-review"
                | "output.asset"
        )
}

fn select_import_target(
    paths: &MediaRuntimePaths,
    source_flow_id: &str,
    bundle_digest: &str,
    flow: &MediaFlowDocument,
    layout: &MediaFlowLayoutDocument,
) -> MediaResult<String> {
    let suffix = &bundle_digest["sha256:".len()..][..12];
    let max_base_chars = 128_usize.saturating_sub("-import-".len() + suffix.len());
    let base_source = source_flow_id
        .chars()
        .take(max_base_chars)
        .collect::<String>();
    let base = format!("{base_source}-import-{suffix}");
    let connection = database::open(paths)?;
    for index in 1..=99 {
        let candidate = if index == 1 {
            base.clone()
        } else {
            let tail = format!("-{index}");
            let trimmed = base
                .chars()
                .take(128_usize.saturating_sub(tail.len()))
                .collect::<String>();
            format!("{trimmed}{tail}")
        };
        let Some(head) = read_head(&connection, &candidate)? else {
            return Ok(candidate);
        };
        let mut imported_flow = flow.clone();
        let mut imported_layout = layout.clone();
        imported_flow.id = candidate.clone();
        imported_layout.flow_id = candidate.clone();
        if head.document_digest == digest_value(&document_projection(&imported_flow)?)?
            && head.execution_digest == digest_value(&execution_projection(&imported_flow))?
            && head.layout_digest == digest_value(&layout_projection(&imported_layout))?
        {
            return Ok(candidate);
        }
    }
    Err("No collision-free isolated flow identity is available for this bundle".to_string())
}

fn create_review_token(
    bundle_digest: &str,
    status: MediaFlowImportStatus,
    proposed_flow_id: Option<&str>,
) -> String {
    let digest = Sha256::digest(
        format!(
            "machdoch-flow-import-review-v1\0{bundle_digest}\0{}\0{}",
            status.as_str(),
            proposed_flow_id.unwrap_or("")
        )
        .as_bytes(),
    );
    format!("mfir-{}", &format!("{digest:x}")[..32])
}

fn create_import_idempotency_key(idempotency_key: &str, bundle_digest: &str) -> String {
    let digest = Sha256::digest(
        format!("machdoch-flow-import-save-v1\0{idempotency_key}\0{bundle_digest}").as_bytes(),
    );
    format!("mfi-{}", &format!("{digest:x}")[..32])
}

fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn validate_flow_import_source(source_path: &str) -> MediaResult<(PathBuf, String)> {
    if source_path.is_empty() || source_path.len() > 32_768 || source_path.contains('\0') {
        return Err("Flow import path is invalid".to_string());
    }
    let requested = PathBuf::from(source_path);
    if !requested.is_absolute() {
        return Err("Flow import path must be absolute".to_string());
    }
    let metadata = fs::symlink_metadata(&requested)
        .map_err(|error| format!("failed to inspect selected flow bundle: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(
            "Selected flow bundle must be a regular file, not a link or device".to_string(),
        );
    }
    if metadata.len() == 0 || metadata.len() > MAX_FLOW_BUNDLE_BYTES {
        return Err(format!(
            "Selected flow bundle must contain 1 byte to {} MB",
            MAX_FLOW_BUNDLE_BYTES / 1024 / 1024
        ));
    }
    if requested
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err("Selected flow bundle must use the .json extension".to_string());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("failed to resolve selected flow bundle: {error}"))?;
    let display_name = safe_display_file_name(&canonical);
    Ok((canonical, display_name))
}

fn validate_flow_export_destination(destination_path: &str) -> MediaResult<PathBuf> {
    if destination_path.is_empty()
        || destination_path.len() > 32_768
        || destination_path.contains('\0')
    {
        return Err("Flow export destination is invalid".to_string());
    }
    let requested = PathBuf::from(destination_path);
    if !requested.is_absolute() {
        return Err("Flow export destination must be absolute".to_string());
    }
    let file_name = requested
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Flow export destination requires a file name".to_string())?;
    if requested
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err("Flow export destination must use the .json extension".to_string());
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "Flow export destination requires a parent directory".to_string())?;
    if !fs::metadata(parent)
        .map_err(|error| format!("failed to inspect flow export directory: {error}"))?
        .is_dir()
    {
        return Err("Flow export parent must be a directory".to_string());
    }
    let destination = parent
        .canonicalize()
        .map_err(|error| format!("failed to resolve flow export directory: {error}"))?
        .join(file_name);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Existing flow export destination must be a regular file".to_string());
        }
    }
    Ok(destination)
}

fn safe_display_file_name(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("media-flow.json");
    let sanitized = name
        .chars()
        .filter(|character| !character.is_control())
        .take(256)
        .collect::<String>();
    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        "media-flow.json".to_string()
    } else {
        sanitized.to_string()
    }
}

fn prefixed_bytes_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

struct StrictJsonValue(Value);

impl<'de> Deserialize<'de> for StrictJsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictJsonVisitor)
    }
}

struct StrictJsonVisitor;

impl<'de> Visitor<'de> for StrictJsonVisitor {
    type Value = StrictJsonValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("strict I-JSON")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Number(value.into())))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Number(value.into())))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let number = serde_json::Number::from_f64(value)
            .ok_or_else(|| E::custom("non-finite JSON number"))?;
        Ok(StrictJsonValue(Value::Number(number)))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.visit_string(value.to_string())
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<StrictJsonValue>()? {
            values.push(value.0);
        }
        Ok(StrictJsonValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate object key {key:?}"
                )));
            }
            let value = object.next_value::<StrictJsonValue>()?;
            values.insert(key, value.0);
        }
        Ok(StrictJsonValue(Value::Object(values)))
    }
}

fn parse_strict_json(bytes: &[u8]) -> MediaResult<Value> {
    serde_json::from_slice::<StrictJsonValue>(bytes)
        .map(|value| value.0)
        .map_err(|error| error.to_string())
}

impl SaveMediaFlowRevisionRequest {
    fn validate(&self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("flow revision schemaVersion must be 1".to_string());
        }
        validate_text("idempotencyKey", &self.idempotency_key, 128, false)?;
        validate_text("changeSummary", &self.change_summary, 256, false)?;
        if let Some(expected) = &self.expected_head_revision_id {
            validate_text("expectedHeadRevisionId", expected, 128, false)?;
        }
        self.flow.validate()?;
        self.layout.validate(&self.flow)?;
        Ok(())
    }
}

impl MediaFlowDocument {
    fn validate(&self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("flow.schemaVersion must be 1".to_string());
        }
        validate_text("flow.id", &self.id, 128, false)?;
        validate_text("flow.name", &self.name, 256, false)?;
        validate_text("flow.description", &self.description, 2_000, true)?;
        validate_timestamp("flow.createdAt", &self.created_at)?;
        validate_timestamp("flow.updatedAt", &self.updated_at)?;
        self.validate_variables()?;
        if self.nodes.is_empty() || self.nodes.len() > MAX_FLOW_NODES {
            return Err(format!(
                "flow.nodes must contain between 1 and {MAX_FLOW_NODES} entries"
            ));
        }
        if self.edges.len() > MAX_FLOW_EDGES {
            return Err(format!("flow.edges is limited to {MAX_FLOW_EDGES} entries"));
        }

        let mut node_ids = HashSet::new();
        let mut node_types = HashMap::new();
        let mut svg_vectorization_nodes = HashSet::new();
        for node in &self.nodes {
            let mut resolved_node = node.clone();
            resolved_node.config = self.resolve_node_config(&node.config)?;
            resolved_node.validate()?;
            if !node_ids.insert(node.id.as_str()) {
                return Err("flow contains duplicate node ids".to_string());
            }
            node_types.insert(node.id.as_str(), node.r#type.as_str());
            if is_svg_vectorization_node(&resolved_node) {
                svg_vectorization_nodes.insert(node.id.as_str());
            }
        }

        let mut edge_ids = HashSet::new();
        let mut connections = HashSet::new();
        let mut incoming = HashMap::<&str, u32>::new();
        let mut incoming_ports = HashMap::<(&str, &str), u32>::new();
        let mut outgoing_ports = HashSet::<(&str, &str)>::new();
        let mut adjacency = HashMap::<&str, Vec<&str>>::new();
        for edge in &self.edges {
            edge.validate()?;
            if !edge_ids.insert(edge.id.as_str()) {
                return Err("flow contains duplicate edge ids".to_string());
            }
            if edge.from_node_id == edge.to_node_id {
                return Err("flow edges cannot connect a node to itself".to_string());
            }
            let from_type = node_types.get(edge.from_node_id.as_str()).ok_or_else(|| {
                format!("flow edge {} references an unknown source node", edge.id)
            })?;
            let to_type = node_types.get(edge.to_node_id.as_str()).ok_or_else(|| {
                format!("flow edge {} references an unknown target node", edge.id)
            })?;
            let output_type = port_type(from_type, &edge.from_port_id, true)
                .ok_or_else(|| format!("flow edge {} uses an unsupported source port", edge.id))?;
            let input_type = port_type(to_type, &edge.to_port_id, false)
                .ok_or_else(|| format!("flow edge {} uses an unsupported target port", edge.id))?;
            if output_type != input_type {
                return Err(format!(
                    "flow edge {} connects incompatible port types",
                    edge.id
                ));
            }
            if !connections.insert((
                edge.from_node_id.as_str(),
                edge.from_port_id.as_str(),
                edge.to_node_id.as_str(),
                edge.to_port_id.as_str(),
            )) {
                return Err("flow contains duplicate semantic connections".to_string());
            }
            *incoming.entry(edge.to_node_id.as_str()).or_default() += 1;
            let input_count = incoming_ports
                .entry((edge.to_node_id.as_str(), edge.to_port_id.as_str()))
                .or_default();
            *input_count += 1;
            let max_connections = max_input_connections(
                to_type,
                &edge.to_port_id,
                svg_vectorization_nodes.contains(edge.to_node_id.as_str()),
            );
            if *input_count > max_connections {
                return Err(format!(
                    "flow node {} input port {} accepts at most {} connection{}",
                    edge.to_node_id,
                    edge.to_port_id,
                    max_connections,
                    if max_connections == 1 { "" } else { "s" }
                ));
            }
            outgoing_ports.insert((edge.from_node_id.as_str(), edge.from_port_id.as_str()));
            adjacency
                .entry(edge.from_node_id.as_str())
                .or_default()
                .push(edge.to_node_id.as_str());
        }
        for node in &self.nodes {
            let is_svg_vectorization = svg_vectorization_nodes.contains(node.id.as_str());
            if is_svg_vectorization && incoming_ports.contains_key(&(node.id.as_str(), "prompt")) {
                return Err(format!(
                    "flow node {} accepts an image instead of a prompt in SVG vectorization mode",
                    node.id
                ));
            }
            for port_id in required_input_ports(&node.r#type, is_svg_vectorization) {
                if !incoming_ports.contains_key(&(node.id.as_str(), *port_id)) {
                    return Err(format!(
                        "flow node {} requires input port {port_id}",
                        node.id
                    ));
                }
            }
            for port_id in required_output_ports(&node.r#type) {
                if !outgoing_ports.contains(&(node.id.as_str(), *port_id)) {
                    return Err(format!(
                        "flow node {} requires output port {port_id}",
                        node.id
                    ));
                }
            }
        }
        validate_acyclic(&self.nodes, &incoming, &adjacency)
    }

    fn resolve_node_config(&self, config: &Map<String, Value>) -> MediaResult<Map<String, Value>> {
        config
            .iter()
            .map(|(key, value)| {
                self.resolve_config_value(value)
                    .map(|resolved| (key.clone(), resolved))
            })
            .collect()
    }

    fn resolve_config_value(&self, value: &Value) -> MediaResult<Value> {
        match value {
            Value::String(text) => {
                let Some(variable_id) = exact_variable_token(text) else {
                    return Ok(value.clone());
                };
                let variable = self
                    .variables
                    .iter()
                    .find(|variable| variable.id == variable_id)
                    .ok_or_else(|| {
                        format!("flow node config references unknown variable {variable_id}")
                    })?;
                Ok(self
                    .variable_bindings
                    .get(variable_id)
                    .or(variable.default_value.as_ref())
                    .cloned()
                    .unwrap_or_else(|| variable.validation_placeholder()))
            }
            Value::Array(entries) => entries
                .iter()
                .map(|entry| self.resolve_config_value(entry))
                .collect::<MediaResult<Vec<_>>>()
                .map(Value::Array),
            Value::Object(entries) => entries
                .iter()
                .map(|(key, entry)| {
                    self.resolve_config_value(entry)
                        .map(|resolved| (key.clone(), resolved))
                })
                .collect::<MediaResult<Map<_, _>>>()
                .map(Value::Object),
            _ => Ok(value.clone()),
        }
    }

    fn validate_variables(&self) -> MediaResult<()> {
        if self.variables.len() > 32 {
            return Err("flow.variables is limited to 32 entries".to_string());
        }
        if self.presets.len() > 32 {
            return Err("flow.presets is limited to 32 entries".to_string());
        }
        let mut variables_by_id = HashMap::new();
        for variable in &self.variables {
            validate_variable_id("flow.variable.id", &variable.id)?;
            validate_text("flow.variable.name", &variable.name, 80, false)?;
            validate_multiline_text(
                "flow.variable.description",
                &variable.description,
                500,
                true,
            )?;
            if variables_by_id
                .insert(variable.id.as_str(), variable)
                .is_some()
            {
                return Err("flow contains duplicate variable ids".to_string());
            }
            variable.validate()?;
        }
        for (variable_id, value) in &self.variable_bindings {
            let variable = variables_by_id.get(variable_id.as_str()).ok_or_else(|| {
                format!("flow binding {variable_id} references an unknown variable")
            })?;
            variable.validate_value(value)?;
        }

        let mut preset_ids = HashSet::new();
        for preset in &self.presets {
            validate_variable_id("flow.preset.id", &preset.id)?;
            validate_text("flow.preset.name", &preset.name, 80, false)?;
            validate_multiline_text("flow.preset.description", &preset.description, 500, true)?;
            if !preset_ids.insert(preset.id.as_str()) {
                return Err("flow contains duplicate preset ids".to_string());
            }
            for (variable_id, value) in &preset.values {
                let variable = variables_by_id.get(variable_id.as_str()).ok_or_else(|| {
                    format!(
                        "flow preset {} references unknown variable {variable_id}",
                        preset.id
                    )
                })?;
                variable.validate_value(value)?;
            }
        }
        if let Some(active_preset_id) = &self.active_preset_id {
            if !preset_ids.contains(active_preset_id.as_str()) {
                return Err("flow activePresetId references an unknown preset".to_string());
            }
        }
        Ok(())
    }
}

impl MediaFlowVariable {
    fn validation_placeholder(&self) -> Value {
        match self.r#type.as_str() {
            "text" => json!("variable"),
            "number" => json!(1),
            "boolean" => json!(false),
            "choice" => self
                .constraints
                .options
                .first()
                .cloned()
                .map(Value::String)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }

    fn validate(&self) -> MediaResult<()> {
        match self.r#type.as_str() {
            "text" => {
                let max_length = self
                    .constraints
                    .max_length
                    .ok_or_else(|| format!("flow variable {} requires maxLength", self.id))?;
                if !(1..=8_000).contains(&max_length)
                    || self.constraints.min.is_some()
                    || self.constraints.max.is_some()
                    || self.constraints.step.is_some()
                    || !self.constraints.options.is_empty()
                {
                    return Err(format!(
                        "flow variable {} has invalid text constraints",
                        self.id
                    ));
                }
            }
            "number" => {
                let min = self.constraints.min.ok_or_else(|| {
                    format!("flow variable {} requires a numeric minimum", self.id)
                })?;
                let max = self.constraints.max.ok_or_else(|| {
                    format!("flow variable {} requires a numeric maximum", self.id)
                })?;
                let step = self
                    .constraints
                    .step
                    .ok_or_else(|| format!("flow variable {} requires a numeric step", self.id))?;
                if !min.is_finite()
                    || !max.is_finite()
                    || min > max
                    || !step.is_finite()
                    || step <= 0.0
                    || self.constraints.max_length.is_some()
                    || !self.constraints.options.is_empty()
                {
                    return Err(format!(
                        "flow variable {} has invalid numeric constraints",
                        self.id
                    ));
                }
            }
            "boolean" => {
                if self.constraints.max_length.is_some()
                    || self.constraints.min.is_some()
                    || self.constraints.max.is_some()
                    || self.constraints.step.is_some()
                    || !self.constraints.options.is_empty()
                {
                    return Err(format!(
                        "flow variable {} has unsupported boolean constraints",
                        self.id
                    ));
                }
            }
            "choice" => {
                if self.constraints.options.is_empty()
                    || self.constraints.options.len() > 64
                    || self.constraints.max_length.is_some()
                    || self.constraints.min.is_some()
                    || self.constraints.max.is_some()
                    || self.constraints.step.is_some()
                {
                    return Err(format!(
                        "flow variable {} has invalid choice constraints",
                        self.id
                    ));
                }
                let mut options = HashSet::new();
                for option in &self.constraints.options {
                    validate_text("flow.variable.option", option, 80, false)?;
                    if !options.insert(option.as_str()) {
                        return Err(format!(
                            "flow variable {} contains duplicate choice options",
                            self.id
                        ));
                    }
                }
            }
            _ => return Err(format!("flow variable {} has an unsupported type", self.id)),
        }
        if let Some(default_value) = &self.default_value {
            self.validate_value(default_value)?;
        }
        let _ = self.required;
        Ok(())
    }

    fn validate_value(&self, value: &Value) -> MediaResult<()> {
        let valid = match self.r#type.as_str() {
            "text" => value.as_str().is_some_and(|text| {
                let max_length = self.constraints.max_length.unwrap_or_default() as usize;
                text.chars().count() <= max_length
                    && !text.chars().any(|character| {
                        character.is_control() && !matches!(character, '\n' | '\r' | '\t')
                    })
            }),
            "number" => value.as_f64().is_some_and(|number| {
                let min = self.constraints.min.unwrap_or(f64::NAN);
                let max = self.constraints.max.unwrap_or(f64::NAN);
                let step = self.constraints.step.unwrap_or(f64::NAN);
                if !number.is_finite()
                    || !min.is_finite()
                    || !max.is_finite()
                    || !step.is_finite()
                    || number < min
                    || number > max
                    || step <= 0.0
                {
                    return false;
                }
                let steps = (number - min) / step;
                (steps - steps.round()).abs() <= 1e-8
            }),
            "boolean" => value.is_boolean(),
            "choice" => value.as_str().is_some_and(|choice| {
                self.constraints
                    .options
                    .iter()
                    .any(|option| option == choice)
            }),
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(format!(
                "flow variable {} contains a value outside its typed constraints",
                self.id
            ))
        }
    }
}

fn exact_variable_token(value: &str) -> Option<&str> {
    let variable_id = value.strip_prefix("{{")?.strip_suffix("}}")?;
    if variable_id.contains("{{") || variable_id.contains("}}") {
        return None;
    }
    let mut characters = variable_id.chars();
    let first = characters.next()?;
    if !first.is_ascii_lowercase()
        || variable_id.len() > 64
        || !characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
    {
        return None;
    }
    Some(variable_id)
}

impl MediaFlowNode {
    fn validate(&self) -> MediaResult<()> {
        validate_text("flow.node.id", &self.id, 128, false)?;
        validate_text("flow.node.label", &self.label, 256, false)?;
        if self.version != 1 {
            return Err(format!(
                "flow node {} uses unsupported version {}",
                self.id, self.version
            ));
        }
        let expected_layer = match self.r#type.as_str() {
            "source.prompt" | "source.image" => "source",
            "task.generate-image" | "task.edit-image" => "task",
            "operation.crop"
            | "operation.resize"
            | "operation.format-convert"
            | "operation.metadata-strip"
            | "operation.auto-tag"
            | "operation.contact-sheet"
            | "operation.subject-cutout"
            | "operation.alpha-matte"
            | "operation.composite"
            | "operation.quality-analyze" => "operation",
            "control.quality-gate" | "control.human-review" => "control",
            "output.asset" => "output",
            _ => return Err(format!("flow node {} has an unsupported type", self.id)),
        };
        if self.layer != expected_layer {
            return Err(format!(
                "flow node {} has an invalid semantic layer",
                self.id
            ));
        }
        let config_bytes = serde_json::to_vec(&self.config)
            .map_err(|error| format!("failed to validate flow node config: {error}"))?
            .len();
        if config_bytes > MAX_CONFIG_BYTES {
            return Err(format!(
                "flow node {} config exceeds {MAX_CONFIG_BYTES} bytes",
                self.id
            ));
        }
        validate_node_config(self)
    }
}

impl MediaFlowEdge {
    fn validate(&self) -> MediaResult<()> {
        validate_text("flow.edge.id", &self.id, 128, false)?;
        validate_text("flow.edge.fromNodeId", &self.from_node_id, 128, false)?;
        validate_text("flow.edge.fromPortId", &self.from_port_id, 64, false)?;
        validate_text("flow.edge.toNodeId", &self.to_node_id, 128, false)?;
        validate_text("flow.edge.toPortId", &self.to_port_id, 64, false)
    }
}

impl MediaFlowLayoutDocument {
    fn validate(&self, flow: &MediaFlowDocument) -> MediaResult<()> {
        if self.schema_version != 1 || self.flow_id != flow.id {
            return Err("flow layout identity does not match the flow document".to_string());
        }
        if self.nodes.len() != flow.nodes.len() {
            return Err("flow layout must contain exactly one position for every node".to_string());
        }
        let flow_node_ids = flow
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<HashSet<_>>();
        let mut layout_node_ids = HashSet::new();
        for node in &self.nodes {
            validate_text("flow.layout.nodeId", &node.node_id, 128, false)?;
            if !flow_node_ids.contains(node.node_id.as_str())
                || !layout_node_ids.insert(node.node_id.as_str())
            {
                return Err(
                    "flow layout contains an unknown or duplicate node position".to_string()
                );
            }
            if !node.x.is_finite()
                || !node.y.is_finite()
                || node.x.abs() > 1_000_000.0
                || node.y.abs() > 1_000_000.0
            {
                return Err(
                    "flow layout positions must be finite and within canvas bounds".to_string(),
                );
            }
        }
        if self.groups.len() > MAX_FLOW_NODES {
            return Err("flow layout contains too many visual groups".to_string());
        }
        let mut group_ids = HashSet::new();
        let mut grouped_node_ids = HashSet::new();
        for group in &self.groups {
            validate_text("flow.layout.group.id", &group.id, 128, false)?;
            validate_text("flow.layout.group.label", &group.label, 80, false)?;
            if !matches!(
                group.color.as_str(),
                "slate" | "cyan" | "violet" | "amber" | "emerald"
            ) {
                return Err("flow layout group color is not supported".to_string());
            }
            if !group_ids.insert(group.id.as_str()) {
                return Err("flow layout contains a duplicate group id".to_string());
            }
            if group.node_ids.len() < 2 || group.node_ids.len() > MAX_FLOW_NODES {
                return Err("flow layout groups require between two and 64 nodes".to_string());
            }
            let mut local_node_ids = HashSet::new();
            for node_id in &group.node_ids {
                validate_text("flow.layout.group.nodeId", node_id, 128, false)?;
                if !flow_node_ids.contains(node_id.as_str())
                    || !local_node_ids.insert(node_id.as_str())
                    || !grouped_node_ids.insert(node_id.as_str())
                {
                    return Err(
                        "flow layout groups contain an unknown, duplicate, or overlapping node"
                            .to_string(),
                    );
                }
            }
            let _ = group.collapsed;
        }
        if self.comments.len() > MAX_FLOW_NODES {
            return Err("flow layout contains too many comments".to_string());
        }
        let mut comment_ids = HashSet::new();
        for comment in &self.comments {
            validate_text("flow.layout.comment.id", &comment.id, 128, false)?;
            validate_multiline_text("flow.layout.comment.body", &comment.body, 1_000, false)?;
            if !matches!(
                comment.color.as_str(),
                "slate" | "cyan" | "violet" | "amber" | "emerald"
            ) {
                return Err("flow layout comment color is not supported".to_string());
            }
            if !comment_ids.insert(comment.id.as_str()) {
                return Err("flow layout contains a duplicate comment id".to_string());
            }
            if !comment.x.is_finite()
                || !comment.y.is_finite()
                || comment.x.abs() > 1_000_000.0
                || comment.y.abs() > 1_000_000.0
                || !comment.width.is_finite()
                || !(180.0..=600.0).contains(&comment.width)
                || !comment.height.is_finite()
                || !(80.0..=600.0).contains(&comment.height)
            {
                return Err("flow layout comment geometry is outside safe bounds".to_string());
            }
        }
        Ok(())
    }
}

fn validate_model_addon_config(node_id: &str, value: &Value) -> MediaResult<()> {
    let addons = value
        .as_array()
        .ok_or_else(|| format!("flow node {node_id} modelAddons must be an array"))?;
    if addons.len() > 24 {
        return Err(format!(
            "flow node {node_id} modelAddons cannot contain more than 24 entries"
        ));
    }
    let mut addon_ids = HashSet::new();
    for addon in addons {
        let addon = addon
            .as_object()
            .ok_or_else(|| format!("flow node {node_id} modelAddons entries must be objects"))?;
        let kind = addon
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("flow node {node_id} modelAddons entries require a kind"))?;
        let allowed_keys: &[&str] = match kind {
            "lora" => &[
                "kind",
                "addonId",
                "enabled",
                "modelStrength",
                "textEncoderStrength",
                "denoisingSchedule",
            ],
            "textual-inversion" => &["kind", "addonId", "enabled", "token", "placement"],
            _ => {
                return Err(format!(
                    "flow node {node_id} modelAddons kind is not supported"
                ))
            }
        };
        if addon
            .keys()
            .any(|key| !allowed_keys.contains(&key.as_str()))
        {
            return Err(format!(
                "flow node {node_id} modelAddons entry contains an unknown field"
            ));
        }
        let addon_id = addon
            .get("addonId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("flow node {node_id} modelAddons entries require addonId"))?;
        validate_text("flow.node.config.modelAddons.addonId", addon_id, 160, false)?;
        if !addon_ids.insert(addon_id) {
            return Err(format!(
                "flow node {node_id} cannot select the same model add-on more than once"
            ));
        }
        if addon.get("enabled").and_then(Value::as_bool).is_none() {
            return Err(format!(
                "flow node {node_id} modelAddons entries require boolean enabled"
            ));
        }
        if kind == "lora" {
            let model_strength = addon
                .get("modelStrength")
                .and_then(Value::as_f64)
                .ok_or_else(|| {
                    format!("flow node {node_id} LoRA selections require numeric modelStrength")
                })?;
            if !model_strength.is_finite() || !(-100.0..=100.0).contains(&model_strength) {
                return Err(format!(
                    "flow node {node_id} LoRA modelStrength must be between -100 and 100"
                ));
            }
            match addon.get("textEncoderStrength") {
                Some(Value::Null) => {}
                Some(value) => {
                    let strength = value.as_f64().ok_or_else(|| {
                        format!(
                            "flow node {node_id} LoRA textEncoderStrength must be numeric or null"
                        )
                    })?;
                    if !strength.is_finite() || !(-100.0..=100.0).contains(&strength) {
                        return Err(format!(
                            "flow node {node_id} LoRA textEncoderStrength must be between -100 and 100"
                        ));
                    }
                }
                None => {
                    return Err(format!(
                        "flow node {node_id} LoRA selections require textEncoderStrength"
                    ))
                }
            }
            match addon.get("denoisingSchedule") {
                None | Some(Value::Null) => {}
                Some(value) => {
                    let schedule = value.as_object().ok_or_else(|| {
                        format!(
                            "flow node {node_id} LoRA denoisingSchedule must be an object or null"
                        )
                    })?;
                    if schedule.len() != 2
                        || schedule.keys().any(|key| key != "start" && key != "end")
                    {
                        return Err(format!(
                            "flow node {node_id} LoRA denoisingSchedule contains an unknown field"
                        ));
                    }
                    let start = schedule
                        .get("start")
                        .and_then(Value::as_f64)
                        .ok_or_else(|| {
                            format!(
                                "flow node {node_id} LoRA denoisingSchedule requires numeric start"
                            )
                        })?;
                    let end = schedule.get("end").and_then(Value::as_f64).ok_or_else(|| {
                        format!("flow node {node_id} LoRA denoisingSchedule requires numeric end")
                    })?;
                    if !start.is_finite()
                        || !end.is_finite()
                        || start < 0.0
                        || start >= end
                        || end > 1.0
                    {
                        return Err(format!(
                            "flow node {node_id} LoRA denoisingSchedule must satisfy 0 <= start < end <= 1"
                        ));
                    }
                }
            }
        } else {
            let token = addon.get("token").and_then(Value::as_str).ok_or_else(|| {
                format!("flow node {node_id} textual-inversion selections require a token")
            })?;
            validate_text("flow.node.config.modelAddons.token", token, 128, false)?;
            match addon.get("placement").and_then(Value::as_str) {
                Some("positive" | "negative" | "both") => {}
                _ => {
                    return Err(format!(
                        "flow node {node_id} textual-inversion placement is not supported"
                    ))
                }
            }
        }
    }
    Ok(())
}

fn validate_node_config(node: &MediaFlowNode) -> MediaResult<()> {
    match node.r#type.as_str() {
        "source.prompt" => {
            validate_config_keys(node, &["prompt"])?;
            config_multiline_string(node, "prompt", 8_000, true).map(|_| ())
        }
        "source.image" => {
            validate_config_keys(node, &["assetId", "referenceRole", "influence"])?;
            config_string(node, "assetId", 256, true)?;
            if node.config.contains_key("referenceRole") {
                config_enum(
                    node,
                    "referenceRole",
                    &[
                        "base",
                        "subject",
                        "style",
                        "composition",
                        "palette",
                        "detail",
                    ],
                )?;
            }
            if let Some(influence) = node.config.get("influence") {
                let influence = influence
                    .as_f64()
                    .ok_or_else(|| format!("flow node {} influence must be numeric", node.id))?;
                if !influence.is_finite() || !(0.0..=1.0).contains(&influence) {
                    return Err(format!(
                        "flow node {} influence must be between 0 and 1",
                        node.id
                    ));
                }
            }
            Ok(())
        }
        "task.generate-image" | "task.edit-image" => {
            validate_config_keys(
                node,
                if node.r#type == "task.edit-image" {
                    &[
                        "providerPolicy",
                        "modelPolicy",
                        "modelId",
                        "aspectRatio",
                        "outputCount",
                        "outputFormat",
                        "editStrength",
                        "modelAddons",
                    ]
                } else {
                    &[
                        "providerPolicy",
                        "modelPolicy",
                        "modelId",
                        "aspectRatio",
                        "outputCount",
                        "outputFormat",
                        "transparentBackground",
                        "svgMode",
                        "svgAutoCrop",
                        "svgTargetSize",
                        "svgStyle",
                        "svgTextPolicy",
                        "svgCandidateCount",
                        "svgCriticEnabled",
                        "modelAddons",
                    ]
                },
            )?;
            config_enum(node, "providerPolicy", &["auto", "local", "remote"])?;
            config_enum(node, "modelPolicy", &["balanced", "fast", "quality"])?;
            if let Some(addons) = node.config.get("modelAddons") {
                validate_model_addon_config(&node.id, addons)?;
            }
            match node.config.get("modelId") {
                Some(Value::Null) => {}
                Some(Value::String(value)) => {
                    validate_text("flow.node.config.modelId", value, 256, false)?
                }
                _ => {
                    return Err(format!(
                        "flow node {} requires modelId to be a string or null",
                        node.id
                    ))
                }
            }
            config_enum(node, "aspectRatio", &["1:1", "4:5", "16:9", "9:16"])?;
            let output_count = node
                .config
                .get("outputCount")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("flow node {} requires an integer outputCount", node.id))?;
            if !(1..=8).contains(&output_count) {
                return Err(format!(
                    "flow node {} outputCount must be between 1 and 8",
                    node.id
                ));
            }
            config_enum(
                node,
                "outputFormat",
                if node.r#type == "task.generate-image" {
                    &["png", "jpeg", "webp", "svg"]
                } else {
                    &["png", "jpeg", "webp"]
                },
            )?;
            if node.r#type == "task.generate-image"
                && node.config.get("outputFormat").and_then(Value::as_str) == Some("svg")
            {
                config_enum(node, "svgMode", &["generate", "vectorize"])?;
                config_enum(
                    node,
                    "svgStyle",
                    &["illustration", "icon", "logo", "diagram", "technical"],
                )?;
                config_enum(node, "svgTextPolicy", &["avoid", "editable", "outlines"])?;
                let candidate_count = node
                    .config
                    .get("svgCandidateCount")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        format!(
                            "flow node {} requires an integer svgCandidateCount",
                            node.id
                        )
                    })?;
                if candidate_count < output_count || candidate_count > 16 {
                    return Err(format!(
                        "flow node {} svgCandidateCount must be between outputCount and 16",
                        node.id
                    ));
                }
                for key in ["transparentBackground", "svgAutoCrop", "svgCriticEnabled"] {
                    if !node.config.get(key).is_some_and(Value::is_boolean) {
                        return Err(format!(
                            "flow node {} requires boolean {key} for SVG generation",
                            node.id
                        ));
                    }
                }
                let target_size = node
                    .config
                    .get("svgTargetSize")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        format!("flow node {} requires an integer svgTargetSize", node.id)
                    })?;
                if !(128..=4_096).contains(&target_size) {
                    return Err(format!(
                        "flow node {} svgTargetSize must be between 128 and 4096",
                        node.id
                    ));
                }
                if node.config.get("svgMode").and_then(Value::as_str) == Some("vectorize")
                    && (output_count != 1 || candidate_count != 1)
                {
                    return Err(format!(
                        "flow node {} SVG vectorization requires outputCount and svgCandidateCount to equal 1",
                        node.id
                    ));
                }
            }
            if node.r#type == "task.edit-image" {
                let edit_strength = node
                    .config
                    .get("editStrength")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| {
                        format!("flow node {} requires numeric editStrength", node.id)
                    })?;
                if !edit_strength.is_finite() || !(0.0..=1.0).contains(&edit_strength) {
                    return Err(format!(
                        "flow node {} editStrength must be between 0 and 1",
                        node.id
                    ));
                }
            }
            Ok(())
        }
        "operation.crop" => {
            validate_config_keys(node, &["x", "y", "width", "height"])?;
            for key in ["x", "y"] {
                let value = node
                    .config
                    .get(key)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| format!("flow node {} requires integer {key}", node.id))?;
                if value > 1_000_000 {
                    return Err(format!("flow node {} {key} exceeds safe bounds", node.id));
                }
            }
            for key in ["width", "height"] {
                let value = node
                    .config
                    .get(key)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| format!("flow node {} requires integer {key}", node.id))?;
                if !(1..=32_768).contains(&value) {
                    return Err(format!(
                        "flow node {} {key} must be between 1 and 32768",
                        node.id
                    ));
                }
            }
            Ok(())
        }
        "operation.resize" => {
            validate_config_keys(node, &["width", "height", "fit"])?;
            for key in ["width", "height"] {
                let value = node
                    .config
                    .get(key)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| format!("flow node {} requires integer {key}", node.id))?;
                if !(1..=32_768).contains(&value) {
                    return Err(format!(
                        "flow node {} {key} must be between 1 and 32768",
                        node.id
                    ));
                }
            }
            config_enum(node, "fit", &["contain", "cover", "stretch"])
        }
        "operation.format-convert" => {
            validate_config_keys(node, &["outputFormat", "quality", "jpegBackground"])?;
            config_enum(node, "outputFormat", &["png", "jpeg", "webp"])?;
            let quality = node
                .config
                .get("quality")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("flow node {} requires integer quality", node.id))?;
            if !(1..=100).contains(&quality) {
                return Err(format!(
                    "flow node {} quality must be between 1 and 100",
                    node.id
                ));
            }
            if let Some(background) = node.config.get("jpegBackground") {
                let background = background.as_str().ok_or_else(|| {
                    format!("flow node {} jpegBackground must be a string", node.id)
                })?;
                if background.len() != 7
                    || !background.starts_with('#')
                    || !background[1..]
                        .chars()
                        .all(|character| character.is_ascii_hexdigit())
                {
                    return Err(format!(
                        "flow node {} jpegBackground must be a six-digit hex color",
                        node.id
                    ));
                }
            }
            Ok(())
        }
        "operation.metadata-strip" => {
            validate_config_keys(node, &["preserveColorProfile", "applyOrientation"])?;
            config_bool(node, "preserveColorProfile")?;
            config_bool(node, "applyOrientation")
        }
        "operation.auto-tag" => {
            validate_config_keys(node, &["profile"])?;
            config_enum(node, "profile", &["technical-metadata-v1"])
        }
        "operation.contact-sheet" => {
            validate_config_keys(
                node,
                &[
                    "columns",
                    "cellWidth",
                    "cellHeight",
                    "gap",
                    "background",
                    "labelMode",
                ],
            )?;
            let columns = node
                .config
                .get("columns")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("flow node {} requires integer columns", node.id))?;
            if !(1..=8).contains(&columns) {
                return Err(format!(
                    "flow node {} columns must be between 1 and 8",
                    node.id
                ));
            }
            for key in ["cellWidth", "cellHeight"] {
                let value = node
                    .config
                    .get(key)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| format!("flow node {} requires integer {key}", node.id))?;
                if !(32..=4096).contains(&value) {
                    return Err(format!(
                        "flow node {} {key} must be between 32 and 4096",
                        node.id
                    ));
                }
            }
            let gap = node
                .config
                .get("gap")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("flow node {} requires integer gap", node.id))?;
            if gap > 256 {
                return Err(format!("flow node {} gap must not exceed 256", node.id));
            }
            let background = config_string(node, "background", 7, false)?;
            if background.len() != 7
                || !background.starts_with('#')
                || !background[1..]
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            {
                return Err(format!(
                    "flow node {} background must be a six-digit hex color",
                    node.id
                ));
            }
            config_enum(node, "labelMode", &["index", "none"])
        }
        "operation.subject-cutout" => {
            validate_config_keys(node, &["modelPriority", "outputMatte"])?;
            local_subject_cutout_model_priority(node)?;
            config_bool(node, "outputMatte")
        }
        "operation.alpha-matte" => {
            validate_config_keys(node, &["invert"])?;
            config_bool(node, "invert")
        }
        "operation.composite" => {
            validate_config_keys(node, &["fit", "opacityPercent"])?;
            config_enum(node, "fit", &["contain", "cover", "stretch"])?;
            let opacity = node
                .config
                .get("opacityPercent")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("flow node {} requires integer opacityPercent", node.id))?;
            if opacity > 100 {
                return Err(format!(
                    "flow node {} opacityPercent must be between 0 and 100",
                    node.id
                ));
            }
            Ok(())
        }
        "operation.quality-analyze" => {
            validate_config_keys(node, &["profile"])?;
            config_string(node, "profile", 128, false).map(|_| ())
        }
        "control.quality-gate" => {
            validate_config_keys(node, &["onUnknown", "profile"])?;
            config_enum(node, "onUnknown", &["human-review", "fail", "pass"])?;
            config_string(node, "profile", 128, false).map(|_| ())
        }
        "control.human-review" => {
            validate_config_keys(node, &["instructions", "maxSelections", "requireComment"])?;
            config_multiline_string(node, "instructions", 1_000, false)?;
            let max_selections = node
                .config
                .get("maxSelections")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    format!("flow node {} requires an integer maxSelections", node.id)
                })?;
            if !(1..=8).contains(&max_selections) {
                return Err(format!(
                    "flow node {} maxSelections must be between 1 and 8",
                    node.id
                ));
            }
            config_bool(node, "requireComment")
        }
        "output.asset" => {
            validate_config_keys(node, &["format", "outputCount"])?;
            config_enum(node, "format", &["png", "jpeg", "webp", "svg"])?;
            let output_count = node
                .config
                .get("outputCount")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("flow node {} requires an integer outputCount", node.id))?;
            if !(1..=8).contains(&output_count) {
                return Err(format!(
                    "flow node {} outputCount must be between 1 and 8",
                    node.id
                ));
            }
            Ok(())
        }
        _ => unreachable!("node type was validated before config"),
    }
}

fn validate_config_keys(node: &MediaFlowNode, allowed: &[&str]) -> MediaResult<()> {
    if let Some(key) = node
        .config
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(format!(
            "flow node {} config contains unsupported field {key}",
            node.id
        ));
    }
    Ok(())
}

fn config_string<'a>(
    node: &'a MediaFlowNode,
    key: &str,
    max: usize,
    allow_empty: bool,
) -> MediaResult<&'a str> {
    let value = node
        .config
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("flow node {} requires string config {key}", node.id))?;
    validate_text(&format!("flow.node.config.{key}"), value, max, allow_empty)?;
    Ok(value)
}

fn config_multiline_string<'a>(
    node: &'a MediaFlowNode,
    key: &str,
    max: usize,
    allow_empty: bool,
) -> MediaResult<&'a str> {
    let value = node
        .config
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("flow node {} requires string config {key}", node.id))?;
    validate_multiline_text(&format!("flow.node.config.{key}"), value, max, allow_empty)?;
    Ok(value)
}

fn config_enum(node: &MediaFlowNode, key: &str, supported: &[&str]) -> MediaResult<()> {
    let value = config_string(node, key, 128, false)?;
    if !supported.contains(&value) {
        return Err(format!("flow node {} config {key} is unsupported", node.id));
    }
    Ok(())
}

fn config_bool(node: &MediaFlowNode, key: &str) -> MediaResult<()> {
    if !node.config.get(key).is_some_and(Value::is_boolean) {
        return Err(format!(
            "flow node {} requires boolean config {key}",
            node.id
        ));
    }
    Ok(())
}

fn port_type(node_type: &str, port_id: &str, output: bool) -> Option<&'static str> {
    match (node_type, output, port_id) {
        ("source.prompt", true, "prompt") => Some("prompt"),
        ("source.image", true, "image") => Some("image"),
        ("task.generate-image", false, "prompt") => Some("prompt"),
        ("task.generate-image", false, "image") => Some("image"),
        ("task.generate-image", true, "image") => Some("image"),
        ("task.edit-image", false, "prompt") => Some("prompt"),
        ("task.edit-image", false | true, "image") => Some("image"),
        ("operation.crop", false | true, "image") => Some("image"),
        ("operation.resize", false | true, "image") => Some("image"),
        ("operation.format-convert", false | true, "image") => Some("image"),
        ("operation.metadata-strip", false | true, "image") => Some("image"),
        ("operation.auto-tag", false | true, "image") => Some("image"),
        ("operation.contact-sheet", false | true, "image") => Some("image"),
        ("operation.subject-cutout", false | true, "image") => Some("image"),
        ("operation.alpha-matte", false | true, "image") => Some("image"),
        ("operation.composite", false, "foreground" | "background") => Some("image"),
        ("operation.composite", true, "image") => Some("image"),
        ("operation.quality-analyze", false, "image") => Some("image"),
        ("operation.quality-analyze", true, "report") => Some("report"),
        ("control.quality-gate", false, "image") => Some("image"),
        ("control.quality-gate", false, "report") => Some("report"),
        ("control.quality-gate", true, "image") => Some("image"),
        ("control.human-review", false | true, "image") => Some("image"),
        ("output.asset", false, "image") => Some("image"),
        _ => None,
    }
}

fn is_svg_vectorization_node(node: &MediaFlowNode) -> bool {
    node.r#type == "task.generate-image"
        && node.config.get("outputFormat").and_then(Value::as_str) == Some("svg")
        && node.config.get("svgMode").and_then(Value::as_str) == Some("vectorize")
}

fn max_input_connections(node_type: &str, port_id: &str, is_svg_vectorization: bool) -> u32 {
    if is_svg_vectorization && port_id == "image" {
        return 1;
    }
    if matches!(
        node_type,
        "task.generate-image" | "task.edit-image" | "operation.contact-sheet"
    ) && port_id == "image"
    {
        8
    } else {
        1
    }
}

fn required_input_ports(node_type: &str, is_svg_vectorization: bool) -> &'static [&'static str] {
    if node_type == "task.generate-image" && is_svg_vectorization {
        return &["image"];
    }
    match node_type {
        "source.prompt" | "source.image" => &[],
        "task.generate-image" => &["prompt"],
        "task.edit-image" => &["prompt", "image"],
        "operation.crop"
        | "operation.resize"
        | "operation.format-convert"
        | "operation.metadata-strip"
        | "operation.auto-tag"
        | "operation.contact-sheet"
        | "operation.subject-cutout"
        | "operation.alpha-matte"
        | "operation.quality-analyze"
        | "control.human-review"
        | "output.asset" => &["image"],
        "control.quality-gate" => &["image", "report"],
        "operation.composite" => &["foreground", "background"],
        _ => &[],
    }
}

fn required_output_ports(node_type: &str) -> &'static [&'static str] {
    match node_type {
        "source.prompt" => &["prompt"],
        "source.image" => &["image"],
        "task.generate-image"
        | "task.edit-image"
        | "operation.crop"
        | "operation.resize"
        | "operation.format-convert"
        | "operation.metadata-strip"
        | "operation.auto-tag"
        | "operation.contact-sheet"
        | "operation.subject-cutout"
        | "operation.alpha-matte"
        | "operation.composite"
        | "control.quality-gate"
        | "control.human-review" => &["image"],
        "operation.quality-analyze" => &["report"],
        "output.asset" => &[],
        _ => &[],
    }
}

fn validate_acyclic<'a>(
    nodes: &'a [MediaFlowNode],
    incoming: &HashMap<&'a str, u32>,
    adjacency: &HashMap<&'a str, Vec<&'a str>>,
) -> MediaResult<()> {
    let mut remaining = nodes
        .iter()
        .map(|node| {
            (
                node.id.as_str(),
                *incoming.get(node.id.as_str()).unwrap_or(&0),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut queue = remaining
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect::<VecDeque<_>>();
    let mut visited = 0;
    while let Some(node_id) = queue.pop_front() {
        visited += 1;
        for target in adjacency.get(node_id).into_iter().flatten() {
            let count = remaining
                .get_mut(target)
                .expect("edge target was validated");
            *count -= 1;
            if *count == 0 {
                queue.push_back(target);
            }
        }
    }
    if visited != nodes.len() {
        return Err("flow graph must be acyclic".to_string());
    }
    Ok(())
}

fn validate_text(field: &str, value: &str, max_chars: usize, allow_empty: bool) -> MediaResult<()> {
    if value != value.trim() || (!allow_empty && value.is_empty()) {
        return Err(format!("{field} must be a trimmed non-empty string"));
    }
    if value.chars().count() > max_chars || value.chars().any(char::is_control) {
        return Err(format!("{field} exceeds its safe text bounds"));
    }
    Ok(())
}

fn validate_variable_id(field: &str, value: &str) -> MediaResult<()> {
    if value.is_empty()
        || value.len() > 64
        || !value.as_bytes()[0].is_ascii_lowercase()
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        return Err(format!("{field} must be a lowercase token-safe identifier"));
    }
    Ok(())
}

fn validate_multiline_text(
    field: &str,
    value: &str,
    max_chars: usize,
    allow_empty: bool,
) -> MediaResult<()> {
    if value != value.trim() || (!allow_empty && value.is_empty()) {
        return Err(format!(
            "{field} must be trimmed and non-empty when required"
        ));
    }
    if value.chars().count() > max_chars
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(format!("{field} exceeds its safe multiline text bounds"));
    }
    Ok(())
}

fn validate_timestamp(field: &str, value: &str) -> MediaResult<()> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| format!("{field} must be RFC 3339"))
}

fn document_projection(flow: &MediaFlowDocument) -> MediaResult<Value> {
    let value = serde_json::to_value(flow)
        .map_err(|error| format!("failed to serialize validated flow document: {error}"))?;
    raw_document_projection(&value)
}

fn execution_projection(flow: &MediaFlowDocument) -> Value {
    let mut nodes = flow.nodes.clone();
    nodes.sort_by(|left, right| left.id.cmp(&right.id));
    let mut edges = flow.edges.clone();
    edges.sort_by(|left, right| {
        (
            &left.from_node_id,
            &left.from_port_id,
            &left.to_node_id,
            &left.to_port_id,
            &left.id,
        )
            .cmp(&(
                &right.from_node_id,
                &right.from_port_id,
                &right.to_node_id,
                &right.to_port_id,
                &right.id,
            ))
    });
    let mut projection = json!({
        "schemaVersion": flow.schema_version,
        "nodes": nodes.into_iter().map(|node| json!({
            "id": node.id,
            "type": node.r#type,
            "version": node.version,
            "config": node.config,
        })).collect::<Vec<_>>(),
        "edges": edges,
    });
    if !flow.variables.is_empty() {
        let mut variables = flow.variables.clone();
        variables.sort_by(|left, right| left.id.cmp(&right.id));
        projection["variables"] = Value::Array(
            variables
                .into_iter()
                .map(|variable| {
                    json!({
                        "id": variable.id,
                        "type": variable.r#type,
                        "required": variable.required,
                        "defaultValue": variable.default_value,
                        "constraints": variable.constraints,
                    })
                })
                .collect(),
        );
    }
    if !flow.variable_bindings.is_empty() {
        projection["variableBindings"] = json!(flow.variable_bindings);
    }
    projection
}

fn layout_projection(layout: &MediaFlowLayoutDocument) -> Value {
    let mut nodes = layout.nodes.clone();
    nodes.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    let mut groups = layout.groups.clone();
    groups.sort_by(|left, right| left.id.cmp(&right.id));
    for group in &mut groups {
        group.node_ids.sort();
    }
    let mut comments = layout.comments.clone();
    comments.sort_by(|left, right| left.id.cmp(&right.id));
    let mut projection = json!({
        "schemaVersion": layout.schema_version,
        "flowId": layout.flow_id,
        "nodes": nodes,
    });
    if !groups.is_empty() {
        projection["groups"] = json!(groups);
    }
    if !comments.is_empty() {
        projection["comments"] = json!(comments);
    }
    projection
}

fn digest_value(value: &Value) -> MediaResult<String> {
    let canonical = canonical_json(value)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

fn canonical_json(value: &Value) -> MediaResult<String> {
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                return Ok(integer.to_string());
            }
            if let Some(integer) = value.as_u64() {
                return Ok(integer.to_string());
            }
            let number = value
                .as_f64()
                .ok_or_else(|| "flow JSON contains a non-finite number".to_string())?;
            if number.fract() == 0.0 {
                return Ok(format!("{number:.0}"));
            }
            Ok(value.to_string())
        }
        Value::String(value) => serde_json::to_string(value)
            .map_err(|error| format!("failed to canonicalize JSON string: {error}")),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<MediaResult<Vec<_>>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut entries = Vec::with_capacity(keys.len());
            for key in keys {
                let encoded_key = serde_json::to_string(key)
                    .map_err(|error| format!("failed to canonicalize JSON key: {error}"))?;
                entries.push(format!("{encoded_key}:{}", canonical_json(&values[key])?));
            }
            Ok(format!("{{{}}}", entries.join(",")))
        }
    }
}

fn create_revision_id(flow_id: &str, idempotency_key: &str, request_digest: &str) -> String {
    let digest = Sha256::digest(
        format!("machdoch-flow-revision-v1\0{flow_id}\0{idempotency_key}\0{request_digest}")
            .as_bytes(),
    );
    format!("mfr-{}", &format!("{digest:x}")[..32])
}

fn artifact_relative_path(flow_id: &str, revision_id: &str) -> String {
    let flow_digest = format!("{:x}", Sha256::digest(flow_id.as_bytes()));
    format!("{}/{}.json", &flow_digest[..16], revision_id)
}

fn write_revision_artifact(
    paths: &MediaRuntimePaths,
    relative_path: &str,
    value: Value,
) -> MediaResult<()> {
    let root = paths
        .database
        .parent()
        .ok_or_else(|| "Media Studio storage path has no parent directory".to_string())?;
    let destination = root.join("flow-revisions").join(relative_path);
    fs::create_dir_all(
        destination
            .parent()
            .ok_or_else(|| "flow revision artifact has no parent directory".to_string())?,
    )
    .map_err(|error| format!("failed to create flow revision artifact directory: {error}"))?;
    let mut bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("failed to encode flow revision artifact: {error}"))?;
    bytes.push(b'\n');
    crate::atomic_file::write_file_atomic(
        &destination,
        &bytes,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("failed to atomically publish flow revision artifact: {error}"))
}

fn import_artifact_relative_path(revision_id: &str, bundle_digest: &str) -> String {
    let digest = bundle_digest
        .strip_prefix("sha256:")
        .unwrap_or(bundle_digest);
    format!("{}/{revision_id}.machdoch-flow.json", &digest[..16])
}

fn write_import_artifact(
    paths: &MediaRuntimePaths,
    relative_path: &str,
    bytes: &[u8],
) -> MediaResult<()> {
    let root = paths
        .database
        .parent()
        .ok_or_else(|| "Media Studio storage path has no parent directory".to_string())?;
    let destination = root.join("flow-imports").join(relative_path);
    fs::create_dir_all(
        destination
            .parent()
            .ok_or_else(|| "flow import artifact has no parent directory".to_string())?,
    )
    .map_err(|error| format!("failed to create flow import artifact directory: {error}"))?;
    crate::atomic_file::write_file_atomic(
        &destination,
        bytes,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("failed to preserve reviewed flow bundle: {error}"))
}

fn read_head(connection: &Connection, flow_id: &str) -> MediaResult<Option<MediaFlowHead>> {
    connection
        .query_row(
            "SELECT id, name, description, head_revision_id, head_revision_number, created_at,
                    updated_at, document_digest, execution_digest, layout_digest
             FROM flows WHERE id = ?1",
            params![flow_id],
            read_head_row,
        )
        .optional()
        .map_err(|error| format!("failed to read flow revision head: {error}"))
}

fn read_head_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaFlowHead> {
    Ok(MediaFlowHead {
        schema_version: 1,
        flow_id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        head_revision_id: row.get(3)?,
        head_revision_number: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        document_digest: row.get(7)?,
        execution_digest: row.get(8)?,
        layout_digest: row.get(9)?,
    })
}

fn read_revision(
    connection: &Connection,
    revision_id: &str,
    head_revision_id: &str,
) -> MediaResult<MediaFlowRevision> {
    connection
        .query_row(
            "SELECT revision_id, flow_id, revision_number, parent_revision_id, created_at,
                    change_summary, document_digest, execution_digest, layout_digest,
                    node_count, edge_count, flow_json, layout_json
             FROM flow_revisions WHERE revision_id = ?1",
            params![revision_id],
            |row| read_revision_row(row, head_revision_id),
        )
        .map_err(|error| format!("failed to read flow revision: {error}"))
}

fn read_revision_by_id(
    connection: &Connection,
    revision_id: &str,
) -> MediaResult<MediaFlowRevision> {
    let flow_id = connection
        .query_row(
            "SELECT flow_id FROM flow_revisions WHERE revision_id = ?1",
            params![revision_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to locate flow revision: {error}"))?
        .ok_or_else(|| format!("Flow revision {revision_id} was not found"))?;
    let head = read_head(connection, &flow_id)?
        .ok_or_else(|| "flow revision storage is inconsistent: head is missing".to_string())?;
    read_revision(connection, revision_id, &head.head_revision_id)
}

fn read_revision_row(
    row: &rusqlite::Row<'_>,
    head_revision_id: &str,
) -> rusqlite::Result<MediaFlowRevision> {
    let revision_id = row.get::<_, String>(0)?;
    let flow_json = row.get::<_, String>(11)?;
    let layout_json = row.get::<_, String>(12)?;
    let flow = serde_json::from_str(&flow_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let layout = serde_json::from_str(&layout_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(MediaFlowRevision {
        schema_version: 1,
        is_head: revision_id == head_revision_id,
        revision_id,
        flow_id: row.get(1)?,
        revision_number: row.get(2)?,
        parent_revision_id: row.get(3)?,
        created_at: row.get(4)?,
        change_summary: row.get(5)?,
        document_digest: row.get(6)?,
        execution_digest: row.get(7)?,
        layout_digest: row.get(8)?,
        node_count: row.get(9)?,
        edge_count: row.get(10)?,
        flow,
        layout,
    })
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_paths(label: &str) -> MediaRuntimePaths {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-media-flow-{label}-{}-{unique}",
            std::process::id()
        ));
        MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        }
    }

    fn request(
        idempotency_key: &str,
        expected: Option<&str>,
        prompt: &str,
    ) -> SaveMediaFlowRevisionRequest {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "idempotencyKey": idempotency_key,
            "expectedHeadRevisionId": expected,
            "changeSummary": "Saved from test",
            "flow": {
                "schemaVersion": 1,
                "id": "flow:test",
                "name": "Test flow",
                "description": "Validated fixture",
                "createdAt": "2026-07-14T00:00:00.000Z",
                "updatedAt": "2026-07-14T00:00:00.000Z",
                "nodes": [
                    {"id":"prompt","type":"source.prompt","version":1,"label":"Prompt","layer":"source","config":{"prompt":prompt}},
                    {"id":"generate","type":"task.generate-image","version":1,"label":"Generate","layer":"task","config":{"providerPolicy":"auto","modelPolicy":"balanced","modelId":null,"aspectRatio":"1:1","outputCount":1,"outputFormat":"png"}},
                    {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
                ],
                "edges": [
                    {"id":"prompt-generate","fromNodeId":"prompt","fromPortId":"prompt","toNodeId":"generate","toPortId":"prompt"},
                    {"id":"generate-output","fromNodeId":"generate","fromPortId":"image","toNodeId":"output","toPortId":"image"}
                ]
            },
            "layout": {"schemaVersion":1,"flowId":"flow:test","nodes":[
                {"nodeId":"prompt","x":0,"y":0},{"nodeId":"generate","x":250,"y":0},{"nodeId":"output","x":500,"y":0}
            ]}
        })).unwrap()
    }

    #[test]
    fn saves_immutable_revisions_and_replays_idempotently() {
        let paths = test_paths("save");
        let first = save(&paths, &request("save-1", None, "First")).unwrap();
        assert!(first.created);
        assert_eq!(first.head.head_revision_number, 1);
        assert_eq!(
            first.head.document_digest,
            "sha256:539d4c47037c918e7b0062258c354c30f7d1fa483ec08bf72127dc564b1ea264"
        );
        assert_eq!(
            first.head.execution_digest,
            "sha256:8d5c80ea1d13912b26a8614434701a6d3c7e65b0045f0c23456933537f9ac931"
        );
        assert_eq!(
            first.head.layout_digest,
            "sha256:a4cfc06c39d6e2c077a081cc332dbf5d561fb95317c5ebedb67a852b0aa3fa91"
        );
        let replay = save(&paths, &request("save-1", None, "First")).unwrap();
        assert!(!replay.created);
        assert_eq!(replay.revision.revision_id, first.revision.revision_id);

        let second = save(
            &paths,
            &request("save-2", Some(&first.revision.revision_id), "Second"),
        )
        .unwrap();
        assert!(second.created);
        assert_eq!(second.head.head_revision_number, 2);
        assert_eq!(
            second.revision.parent_revision_id,
            Some(first.revision.revision_id)
        );
        let history = get(&paths, "flow:test").unwrap();
        assert_eq!(history.revisions.len(), 2);
        assert!(history.revisions[0].is_head);
        let root = paths.database.parent().unwrap().to_path_buf();
        assert_eq!(
            fs::read_dir(root.join("flow-revisions")).unwrap().count(),
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compiles_pinned_ralph_revision_with_typed_bindings_and_stable_identity() {
        let paths = test_paths("ralph-bridge");
        let mut source = request("ralph-bridge-save", None, "{{subject}} product photo");
        source.flow.variables.push(MediaFlowVariable {
            id: "subject".to_string(),
            name: "Subject".to_string(),
            description: "Bound by the Ralph bridge".to_string(),
            r#type: "text".to_string(),
            required: true,
            default_value: None,
            constraints: MediaFlowVariableConstraints {
                max_length: Some(120),
                min: None,
                max: None,
                step: None,
                options: Vec::new(),
            },
        });
        let saved = save(&paths, &source).unwrap();
        let bridge_request = RalphMediaFlowRunRequest {
            run_id: "ralph-media-test".to_string(),
            flow_id: "flow:test".to_string(),
            revision_id: saved.revision.revision_id.clone(),
            input_bindings: HashMap::from([(
                "subject".to_string(),
                super::super::RalphMediaResolvedInputBinding {
                    source: "literal".to_string(),
                    value: json!("Glass bottle"),
                },
            )]),
            approval_policy: "inherit-workspace".to_string(),
        };

        let mut first = create_ralph_fixture_run_request(&paths, &bridge_request).unwrap();
        let second = create_ralph_fixture_run_request(&paths, &bridge_request).unwrap();
        assert_eq!(first.plan_id, second.plan_id);
        assert_eq!(first.prompt, "Glass bottle product photo");
        assert_eq!(
            first.flow_revision_id,
            Some(saved.revision.revision_id.clone())
        );
        assert_eq!(
            first.plan_snapshot.as_ref().unwrap().flow_fingerprint,
            saved.revision.execution_digest
        );
        assert!(first.validate().is_ok());
    }

    #[test]
    fn rejects_stale_heads_and_invalid_graphs() {
        let paths = test_paths("conflict");
        save(&paths, &request("save-1", None, "First")).unwrap();
        let conflict = save(&paths, &request("save-2", None, "Second")).unwrap_err();
        assert!(conflict.contains("flow revision conflict"));

        let mut invalid = request("invalid", None, "Invalid");
        invalid.flow.edges[1].to_port_id = "prompt".to_string();
        assert!(invalid
            .validate()
            .unwrap_err()
            .contains("unsupported target port"));
        let root = paths.database.parent().unwrap().to_path_buf();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validates_safe_multiline_prompts_at_the_persistence_boundary() {
        let multiline = request(
            "multiline-prompt",
            None,
            "Subject and composition\n\tLighting and material direction",
        );
        assert!(multiline.validate().is_ok());

        let unsafe_prompt = request("unsafe-prompt", None, "Subject\0hidden");
        assert!(unsafe_prompt
            .validate()
            .unwrap_err()
            .contains("safe multiline text bounds"));
    }

    #[test]
    fn validates_bounded_human_review_at_the_persistence_boundary() {
        let mut reviewed = request("human-review", None, "Review candidates");
        reviewed.flow.nodes.push(
            serde_json::from_value(json!({
                "id": "human-review",
                "type": "control.human-review",
                "version": 1,
                "label": "Human review",
                "layer": "control",
                "config": {
                    "instructions": "Approve only technically clean candidates.",
                    "maxSelections": 1,
                    "requireComment": true
                }
            }))
            .unwrap(),
        );
        reviewed
            .flow
            .edges
            .retain(|edge| edge.id != "generate-output");
        reviewed.flow.edges.extend([
            serde_json::from_value(json!({
                "id": "generate-review",
                "fromNodeId": "generate",
                "fromPortId": "image",
                "toNodeId": "human-review",
                "toPortId": "image"
            }))
            .unwrap(),
            serde_json::from_value(json!({
                "id": "review-output",
                "fromNodeId": "human-review",
                "fromPortId": "image",
                "toNodeId": "output",
                "toPortId": "image"
            }))
            .unwrap(),
        ]);
        reviewed.layout.nodes.push(MediaFlowNodeLayout {
            node_id: "human-review".to_string(),
            x: 375.0,
            y: 150.0,
        });
        assert!(reviewed.validate().is_ok());

        reviewed
            .flow
            .nodes
            .last_mut()
            .unwrap()
            .config
            .insert("maxSelections".to_string(), json!(9));
        assert!(reviewed
            .validate()
            .unwrap_err()
            .contains("maxSelections must be between 1 and 8"));
    }

    #[test]
    fn validates_visual_group_membership_and_layout_identity() {
        let mut grouped = request("visual-group", None, "Grouped flow");
        let original_digest = digest_value(&layout_projection(&grouped.layout)).unwrap();
        grouped.layout.groups.push(MediaFlowLayoutGroup {
            id: "group-1".to_string(),
            label: "Generation chain".to_string(),
            color: "violet".to_string(),
            collapsed: true,
            node_ids: vec!["prompt".to_string(), "generate".to_string()],
        });
        assert!(grouped.validate().is_ok());
        assert_ne!(
            digest_value(&layout_projection(&grouped.layout)).unwrap(),
            original_digest
        );

        grouped.layout.groups.push(MediaFlowLayoutGroup {
            id: "group-2".to_string(),
            label: "Overlapping group".to_string(),
            color: "cyan".to_string(),
            collapsed: false,
            node_ids: vec!["generate".to_string(), "output".to_string()],
        });
        assert!(grouped
            .validate()
            .unwrap_err()
            .contains("unknown, duplicate, or overlapping node"));
    }

    #[test]
    fn validates_canvas_comments_and_layout_identity() {
        let mut commented = request("canvas-comment", None, "Commented flow");
        let original_digest = digest_value(&layout_projection(&commented.layout)).unwrap();
        commented.layout.comments.push(MediaFlowLayoutComment {
            id: "comment-1".to_string(),
            body: "Review glass edges before export".to_string(),
            color: "amber".to_string(),
            x: 120.0,
            y: 180.0,
            width: 240.0,
            height: 120.0,
        });
        assert!(commented.validate().is_ok());
        assert_ne!(
            digest_value(&layout_projection(&commented.layout)).unwrap(),
            original_digest
        );

        commented.layout.comments[0].width = 100.0;
        assert!(commented
            .validate()
            .unwrap_err()
            .contains("geometry is outside safe bounds"));
    }

    #[test]
    fn raw_and_typed_layout_projections_match_for_annotations() {
        let raw = json!({
            "schemaVersion": 1,
            "flowId": "flow:test",
            "nodes": [
                {"nodeId":"output","x":500.0,"y":0.0},
                {"nodeId":"prompt","x":0.0,"y":0.0},
                {"nodeId":"generate","x":250.0,"y":0.0}
            ],
            "groups": [
                {
                    "id":"group-2","label":"Later","color":"cyan","collapsed":false,
                    "nodeIds":["output","generate"]
                },
                {
                    "id":"group-1","label":"Earlier","color":"violet","collapsed":true,
                    "nodeIds":["prompt","generate"]
                }
            ],
            "comments": [
                {
                    "id":"comment-2","body":"Second","color":"slate",
                    "x":40.0,"y":400.0,"width":240.0,"height":120.0
                },
                {
                    "id":"comment-1","body":"First","color":"amber",
                    "x":20.0,"y":300.0,"width":320.0,"height":180.0
                }
            ]
        });
        let typed = serde_json::from_value::<MediaFlowLayoutDocument>(raw.clone()).unwrap();

        assert_eq!(
            digest_value(&raw_layout_projection(&raw).unwrap()).unwrap(),
            digest_value(&layout_projection(&typed)).unwrap()
        );
    }

    #[test]
    fn validates_typed_variables_presets_and_execution_identity() {
        let mut parameterized = request("typed-variable", None, "Parameterized flow");
        let baseline_execution = digest_value(&execution_projection(&parameterized.flow)).unwrap();
        parameterized.flow.variables.push(MediaFlowVariable {
            id: "material".to_string(),
            name: "Material".to_string(),
            description: "Product surface material".to_string(),
            r#type: "text".to_string(),
            required: true,
            default_value: Some(json!("ceramic")),
            constraints: MediaFlowVariableConstraints {
                max_length: Some(80),
                min: None,
                max: None,
                step: None,
                options: Vec::new(),
            },
        });
        assert!(parameterized.validate().is_ok());
        let declared_execution = digest_value(&execution_projection(&parameterized.flow)).unwrap();
        assert_ne!(declared_execution, baseline_execution);

        parameterized
            .flow
            .variable_bindings
            .insert("material".to_string(), json!("glass"));
        let bound_execution = digest_value(&execution_projection(&parameterized.flow)).unwrap();
        assert_ne!(bound_execution, declared_execution);

        let before_preset_document =
            digest_value(&document_projection(&parameterized.flow).unwrap()).unwrap();
        parameterized.flow.presets.push(MediaFlowPreset {
            id: "preset-1".to_string(),
            name: "Glass product".to_string(),
            description: String::new(),
            values: Map::from_iter([("material".to_string(), json!("glass"))]),
        });
        parameterized.flow.active_preset_id = Some("preset-1".to_string());
        assert!(parameterized.validate().is_ok());
        assert_eq!(
            digest_value(&execution_projection(&parameterized.flow)).unwrap(),
            bound_execution
        );
        assert_ne!(
            digest_value(&document_projection(&parameterized.flow).unwrap()).unwrap(),
            before_preset_document
        );

        parameterized.flow.variables.push(MediaFlowVariable {
            id: "variant-count".to_string(),
            name: "Variant count".to_string(),
            description: "Bounded output cardinality".to_string(),
            r#type: "number".to_string(),
            required: true,
            default_value: Some(json!(3)),
            constraints: MediaFlowVariableConstraints {
                max_length: None,
                min: Some(1.0),
                max: Some(8.0),
                step: Some(1.0),
                options: Vec::new(),
            },
        });
        for node in &mut parameterized.flow.nodes {
            if matches!(node.id.as_str(), "generate" | "output") {
                node.config
                    .insert("outputCount".to_string(), json!("{{variant-count}}"));
            }
        }
        assert!(parameterized.validate().is_ok());

        parameterized
            .flow
            .variable_bindings
            .insert("material".to_string(), json!(42));
        assert!(parameterized
            .validate()
            .unwrap_err()
            .contains("outside its typed constraints"));
    }

    #[test]
    fn raw_and_typed_document_projections_match_for_variables() {
        let raw = json!({
            "schemaVersion": 1,
            "id": "flow:variables",
            "name": "Variable flow",
            "description": "",
            "createdAt": "2026-07-14T00:00:00.000Z",
            "updatedAt": "2026-07-14T00:00:00.000Z",
            "variables": [{
                "id": "material",
                "name": "Material",
                "description": "",
                "type": "choice",
                "required": true,
                "defaultValue": "ceramic",
                "constraints": {"options": ["ceramic", "glass"]}
            }],
            "variableBindings": {"material": "glass"},
            "presets": [{
                "id": "preset-1",
                "name": "Glass",
                "description": "",
                "values": {"material": "glass"}
            }],
            "activePresetId": "preset-1",
            "nodes": [
                {"id":"prompt","type":"source.prompt","version":1,"label":"Prompt","layer":"source","config":{"prompt":"{{material}} product"}},
                {"id":"generate","type":"task.generate-image","version":1,"label":"Generate","layer":"task","config":{"providerPolicy":"auto","modelPolicy":"balanced","modelId":null,"aspectRatio":"1:1","outputCount":1,"outputFormat":"png"}},
                {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
            ],
            "edges": [
                {"id":"prompt-generate","fromNodeId":"prompt","fromPortId":"prompt","toNodeId":"generate","toPortId":"prompt"},
                {"id":"generate-output","fromNodeId":"generate","fromPortId":"image","toNodeId":"output","toPortId":"image"}
            ]
        });
        let typed = serde_json::from_value::<MediaFlowDocument>(raw.clone()).unwrap();
        assert!(typed.validate().is_ok());
        assert_eq!(
            digest_value(&raw_document_projection(&raw).unwrap()).unwrap(),
            digest_value(&document_projection(&typed).unwrap()).unwrap()
        );
    }

    #[test]
    fn validates_promptless_single_source_svg_vectorization() {
        let flow = serde_json::from_value::<MediaFlowDocument>(json!({
            "schemaVersion": 1,
            "id": "flow:svg-vectorization",
            "name": "SVG vectorization",
            "description": "",
            "createdAt": "2026-07-15T00:00:00.000Z",
            "updatedAt": "2026-07-15T00:00:00.000Z",
            "nodes": [
                {"id":"source","type":"source.image","version":1,"label":"Source","layer":"source","config":{"assetId":"asset:raster","referenceRole":"base","influence":1.0}},
                {"id":"vectorize","type":"task.generate-image","version":1,"label":"Vectorize","layer":"task","config":{"providerPolicy":"remote","modelPolicy":"quality","modelId":"recraft:recraftv4_1_pro_vector","aspectRatio":"1:1","outputCount":1,"outputFormat":"svg","transparentBackground":false,"svgMode":"vectorize","svgAutoCrop":true,"svgTargetSize":2048,"svgStyle":"illustration","svgTextPolicy":"avoid","svgCandidateCount":1,"svgCriticEnabled":false,"modelAddons":[]}},
                {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"svg","outputCount":1}}
            ],
            "edges": [
                {"id":"source-vectorize","fromNodeId":"source","fromPortId":"image","toNodeId":"vectorize","toPortId":"image"},
                {"id":"vectorize-output","fromNodeId":"vectorize","fromPortId":"image","toNodeId":"output","toPortId":"image"}
            ]
        }))
        .unwrap();

        assert!(flow.validate().is_ok());
        assert_eq!(
            create_ralph_plan_steps(&flow.nodes)
                .unwrap()
                .into_iter()
                .map(|step| step.kind)
                .collect::<Vec<_>>(),
            vec![
                "resolve-asset",
                "resolve-model",
                "vectorize-svg",
                "ingest-asset",
            ]
        );

        let mut duplicate_source = flow.clone();
        duplicate_source.nodes.push(MediaFlowNode {
            id: "second-source".to_string(),
            r#type: "source.image".to_string(),
            version: 1,
            label: "Second source".to_string(),
            layer: "source".to_string(),
            config: serde_json::from_value(json!({
                "assetId": "asset:second",
                "referenceRole": "detail",
                "influence": 1.0,
            }))
            .unwrap(),
        });
        duplicate_source.edges.push(MediaFlowEdge {
            id: "second-vectorize".to_string(),
            from_node_id: "second-source".to_string(),
            from_port_id: "image".to_string(),
            to_node_id: "vectorize".to_string(),
            to_port_id: "image".to_string(),
        });
        assert!(duplicate_source
            .validate()
            .unwrap_err()
            .contains("accepts at most 1 connection"));
    }

    #[test]
    fn validates_and_expands_provider_neutral_image_edit_nodes() {
        let flow = serde_json::from_value::<MediaFlowDocument>(json!({
            "schemaVersion": 1,
            "id": "flow:image-edit",
            "name": "Image edit",
            "description": "",
            "createdAt": "2026-07-14T00:00:00.000Z",
            "updatedAt": "2026-07-14T00:00:00.000Z",
            "nodes": [
                {"id":"prompt","type":"source.prompt","version":1,"label":"Instructions","layer":"source","config":{"prompt":"Replace the background with travertine"}},
                {"id":"source","type":"source.image","version":1,"label":"Source","layer":"source","config":{"assetId":"asset:approved-product-shot"}},
                {"id":"edit","type":"task.edit-image","version":1,"label":"Edit","layer":"task","config":{"providerPolicy":"auto","modelPolicy":"balanced","modelId":null,"aspectRatio":"1:1","outputCount":2,"outputFormat":"png","editStrength":0.65}},
                {"id":"crop","type":"operation.crop","version":1,"label":"Crop","layer":"operation","config":{"x":0,"y":0,"width":1024,"height":1024}},
                {"id":"resize","type":"operation.resize","version":1,"label":"Resize","layer":"operation","config":{"width":768,"height":768,"fit":"contain"}},
                {"id":"convert","type":"operation.format-convert","version":1,"label":"Convert","layer":"operation","config":{"outputFormat":"webp","quality":90}},
                {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":2}}
            ],
            "edges": [
                {"id":"prompt-edit","fromNodeId":"prompt","fromPortId":"prompt","toNodeId":"edit","toPortId":"prompt"},
                {"id":"source-edit","fromNodeId":"source","fromPortId":"image","toNodeId":"edit","toPortId":"image"},
                {"id":"edit-crop","fromNodeId":"edit","fromPortId":"image","toNodeId":"crop","toPortId":"image"},
                {"id":"crop-resize","fromNodeId":"crop","fromPortId":"image","toNodeId":"resize","toPortId":"image"},
                {"id":"resize-convert","fromNodeId":"resize","fromPortId":"image","toNodeId":"convert","toPortId":"image"},
                {"id":"convert-output","fromNodeId":"convert","fromPortId":"image","toNodeId":"output","toPortId":"image"}
            ]
        }))
        .unwrap();

        assert!(flow.validate().is_ok());
        assert_eq!(
            create_ralph_plan_steps(&flow.nodes)
                .unwrap()
                .into_iter()
                .map(|step| step.kind)
                .collect::<Vec<_>>(),
            vec![
                "normalize-prompt",
                "resolve-asset",
                "resolve-model",
                "edit-image",
                "crop-image",
                "resize-image",
                "convert-image",
                "ingest-asset",
            ]
        );
    }

    #[test]
    fn validates_bounded_multi_reference_image_edit_inputs() {
        let flow = serde_json::from_value::<MediaFlowDocument>(json!({
            "schemaVersion": 1,
            "id": "flow:multi-reference-edit",
            "name": "Multi-reference edit",
            "description": "",
            "createdAt": "2026-07-14T00:00:00.000Z",
            "updatedAt": "2026-07-14T00:00:00.000Z",
            "nodes": [
                {"id":"prompt","type":"source.prompt","version":1,"label":"Instructions","layer":"source","config":{"prompt":"Preserve the subject and apply the style reference"}},
                {"id":"base","type":"source.image","version":1,"label":"Base","layer":"source","config":{"assetId":"asset:base","referenceRole":"base","influence":1.0}},
                {"id":"style","type":"source.image","version":1,"label":"Style","layer":"source","config":{"assetId":"asset:style","referenceRole":"style","influence":0.45}},
                {"id":"edit","type":"task.edit-image","version":1,"label":"Edit","layer":"task","config":{"providerPolicy":"auto","modelPolicy":"balanced","modelId":null,"aspectRatio":"1:1","outputCount":1,"outputFormat":"png","editStrength":0.65}},
                {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
            ],
            "edges": [
                {"id":"prompt-edit","fromNodeId":"prompt","fromPortId":"prompt","toNodeId":"edit","toPortId":"prompt"},
                {"id":"base-edit","fromNodeId":"base","fromPortId":"image","toNodeId":"edit","toPortId":"image"},
                {"id":"style-edit","fromNodeId":"style","fromPortId":"image","toNodeId":"edit","toPortId":"image"},
                {"id":"edit-output","fromNodeId":"edit","fromPortId":"image","toNodeId":"output","toPortId":"image"}
            ]
        }))
        .unwrap();

        assert!(flow.validate().is_ok());
        assert_eq!(
            create_ralph_plan_steps(&flow.nodes)
                .unwrap()
                .into_iter()
                .map(|step| step.kind)
                .collect::<Vec<_>>(),
            vec![
                "normalize-prompt",
                "resolve-asset",
                "resolve-asset",
                "resolve-model",
                "edit-image",
                "ingest-asset",
            ]
        );
    }

    #[test]
    fn validates_and_expands_model_free_local_image_utility_flows() {
        let flow = serde_json::from_value::<MediaFlowDocument>(json!({
            "schemaVersion": 1,
            "id": "flow:local-utility",
            "name": "Local utility",
            "description": "",
            "createdAt": "2026-07-14T00:00:00.000Z",
            "updatedAt": "2026-07-14T00:00:00.000Z",
            "nodes": [
                {"id":"source","type":"source.image","version":1,"label":"Source","layer":"source","config":{"assetId":"asset:source","referenceRole":"base","influence":1.0}},
                {"id":"resize","type":"operation.resize","version":1,"label":"Resize","layer":"operation","config":{"width":1600,"height":900,"fit":"cover"}},
                {"id":"convert","type":"operation.format-convert","version":1,"label":"Convert","layer":"operation","config":{"outputFormat":"jpeg","quality":86,"jpegBackground":"#111827"}},
                {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"jpeg","outputCount":1}}
            ],
            "edges": [
                {"id":"source-resize","fromNodeId":"source","fromPortId":"image","toNodeId":"resize","toPortId":"image"},
                {"id":"resize-convert","fromNodeId":"resize","fromPortId":"image","toNodeId":"convert","toPortId":"image"},
                {"id":"convert-output","fromNodeId":"convert","fromPortId":"image","toNodeId":"output","toPortId":"image"}
            ]
        }))
        .unwrap();

        assert!(flow.validate().is_ok());
        assert_eq!(
            create_ralph_plan_steps(&flow.nodes)
                .unwrap()
                .into_iter()
                .map(|step| step.kind)
                .collect::<Vec<_>>(),
            vec![
                "resolve-asset",
                "resize-image",
                "convert-image",
                "ingest-asset",
            ]
        );
    }

    #[test]
    fn validates_named_foreground_and_background_composite_ports() {
        let flow = serde_json::from_value::<MediaFlowDocument>(json!({
            "schemaVersion": 1,
            "id": "flow:composite",
            "name": "Composite",
            "description": "",
            "createdAt": "2026-07-14T00:00:00.000Z",
            "updatedAt": "2026-07-14T00:00:00.000Z",
            "nodes": [
                {"id":"foreground","type":"source.image","version":1,"label":"Foreground","layer":"source","config":{"assetId":"asset:foreground"}},
                {"id":"background","type":"source.image","version":1,"label":"Background","layer":"source","config":{"assetId":"asset:background"}},
                {"id":"composite","type":"operation.composite","version":1,"label":"Composite","layer":"operation","config":{"fit":"contain","opacityPercent":75}},
                {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
            ],
            "edges": [
                {"id":"foreground-composite","fromNodeId":"foreground","fromPortId":"image","toNodeId":"composite","toPortId":"foreground"},
                {"id":"background-composite","fromNodeId":"background","fromPortId":"image","toNodeId":"composite","toPortId":"background"},
                {"id":"composite-output","fromNodeId":"composite","fromPortId":"image","toNodeId":"output","toPortId":"image"}
            ]
        }))
        .unwrap();

        assert!(flow.validate().is_ok());
        assert_eq!(
            create_ralph_plan_steps(&flow.nodes)
                .unwrap()
                .into_iter()
                .map(|step| step.kind)
                .collect::<Vec<_>>(),
            vec![
                "resolve-asset",
                "resolve-asset",
                "composite-image",
                "ingest-asset",
            ]
        );

        let mut missing_background = flow;
        missing_background
            .nodes
            .retain(|node| node.id != "background");
        missing_background
            .edges
            .retain(|edge| edge.to_port_id != "background");
        let error = missing_background.validate().unwrap_err();
        assert!(
            error.contains("requires input port background"),
            "unexpected validation error: {error}"
        );
    }

    #[test]
    fn validates_bounded_contact_sheet_and_metadata_privacy_operations() {
        let flow = serde_json::from_value::<MediaFlowDocument>(json!({
            "schemaVersion": 1,
            "id": "flow:contact-sheet",
            "name": "Contact sheet",
            "description": "",
            "createdAt": "2026-07-14T00:00:00.000Z",
            "updatedAt": "2026-07-14T00:00:00.000Z",
            "nodes": [
                {"id":"one","type":"source.image","version":1,"label":"One","layer":"source","config":{"assetId":"asset:one"}},
                {"id":"two","type":"source.image","version":1,"label":"Two","layer":"source","config":{"assetId":"asset:two"}},
                {"id":"sheet","type":"operation.contact-sheet","version":1,"label":"Sheet","layer":"operation","config":{"columns":2,"cellWidth":512,"cellHeight":512,"gap":16,"background":"#0f172a","labelMode":"index"}},
                {"id":"strip","type":"operation.metadata-strip","version":1,"label":"Strip","layer":"operation","config":{"preserveColorProfile":true,"applyOrientation":true}},
                {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
            ],
            "edges": [
                {"id":"one-sheet","fromNodeId":"one","fromPortId":"image","toNodeId":"sheet","toPortId":"image"},
                {"id":"two-sheet","fromNodeId":"two","fromPortId":"image","toNodeId":"sheet","toPortId":"image"},
                {"id":"sheet-strip","fromNodeId":"sheet","fromPortId":"image","toNodeId":"strip","toPortId":"image"},
                {"id":"strip-output","fromNodeId":"strip","fromPortId":"image","toNodeId":"output","toPortId":"image"}
            ]
        }))
        .unwrap();

        assert!(flow.validate().is_ok());
        assert_eq!(
            create_ralph_plan_steps(&flow.nodes)
                .unwrap()
                .into_iter()
                .map(|step| step.kind)
                .collect::<Vec<_>>(),
            vec![
                "resolve-asset",
                "resolve-asset",
                "create-contact-sheet",
                "strip-metadata",
                "ingest-asset",
            ]
        );
    }

    #[test]
    fn validates_required_output_ports_and_single_input_cardinality() {
        let mut leaf_operation = request("leaf-operation", None, "Leaf operation");
        leaf_operation.flow.nodes.push(
            serde_json::from_value(json!({
                "id": "quality-analyze",
                "type": "operation.quality-analyze",
                "version": 1,
                "label": "Analyze quality",
                "layer": "operation",
                "config": {"profile": "image-technical-v1"}
            }))
            .unwrap(),
        );
        leaf_operation.flow.edges.push(
            serde_json::from_value(json!({
                "id": "generate-analyze",
                "fromNodeId": "generate",
                "fromPortId": "image",
                "toNodeId": "quality-analyze",
                "toPortId": "image"
            }))
            .unwrap(),
        );
        assert!(leaf_operation
            .validate()
            .unwrap_err()
            .contains("requires output port report"));

        let mut duplicate_input = request("duplicate-input", None, "Duplicate input");
        duplicate_input.flow.nodes.push(
            serde_json::from_value(json!({
                "id": "prompt-two",
                "type": "source.prompt",
                "version": 1,
                "label": "Second prompt",
                "layer": "source",
                "config": {"prompt": "Second"}
            }))
            .unwrap(),
        );
        duplicate_input.flow.edges.push(
            serde_json::from_value(json!({
                "id": "prompt-two-generate",
                "fromNodeId": "prompt-two",
                "fromPortId": "prompt",
                "toNodeId": "generate",
                "toPortId": "prompt"
            }))
            .unwrap(),
        );
        assert!(duplicate_input
            .validate()
            .unwrap_err()
            .contains("input port prompt accepts at most 1 connection"));
    }

    #[test]
    fn exports_reviews_and_imports_an_isolated_immutable_copy() {
        let paths = test_paths("portable-roundtrip");
        let saved = save(&paths, &request("portable-save", None, "Portable")).unwrap();
        let root = paths.database.parent().unwrap().to_path_buf();
        let destination = root.join("portable.machdoch-flow.json");
        let exported = export_revision(
            &paths,
            &ExportMediaFlowRevisionRequest {
                schema_version: 1,
                idempotency_key: "portable-export".to_string(),
                revision_id: saved.revision.revision_id.clone(),
                destination_path: destination.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        assert!(is_sha256_digest(&exported.bundle_digest));
        assert_eq!(exported.requirement_count, 3);

        let inspection = inspect_import(
            &paths,
            &InspectMediaFlowImportRequest {
                schema_version: 1,
                source_path: destination.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        assert_eq!(inspection.status, MediaFlowImportStatus::Ready);
        assert!(inspection.can_import);
        assert!(inspection.issues.is_empty());
        assert!(inspection
            .proposed_flow_id
            .as_deref()
            .unwrap()
            .starts_with("flow:test-import-"));

        let imported = import_reviewed(
            &paths,
            &ImportMediaFlowRequest {
                schema_version: 1,
                idempotency_key: "portable-import".to_string(),
                source_path: destination.to_string_lossy().into_owned(),
                review_token: inspection.review_token,
            },
        )
        .unwrap();
        assert!(imported.created);
        assert_ne!(imported.target_flow_id, imported.source_flow_id);
        assert_eq!(imported.revision.flow.id, imported.target_flow_id);
        assert_eq!(imported.revision.layout.flow_id, imported.target_flow_id);
        let provenance_count = database::open(&paths)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM flow_revision_imports WHERE revision_id = ?1",
                params![imported.revision.revision_id],
                |row| row.get::<_, u32>(0),
            )
            .unwrap();
        assert_eq!(provenance_count, 1);
        assert!(root.join("flow-imports").is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_unknown_nodes_as_inspect_only_tombstones() {
        let paths = test_paths("portable-unknown");
        let saved = save(&paths, &request("unknown-save", None, "Unknown")).unwrap();
        let root = paths.database.parent().unwrap().to_path_buf();
        let destination = root.join("unknown.machdoch-flow.json");
        export_revision(
            &paths,
            &ExportMediaFlowRevisionRequest {
                schema_version: 1,
                idempotency_key: "unknown-export".to_string(),
                revision_id: saved.revision.revision_id,
                destination_path: destination.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        let mut bundle = parse_strict_json(&fs::read(&destination).unwrap()).unwrap();
        let generate = bundle["flow"]["nodes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|node| node["id"] == "generate")
            .unwrap();
        generate["version"] = json!(2);
        let requirement = bundle["requirements"]["nodeTypes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|entry| entry["nodeType"] == "task.generate-image")
            .unwrap();
        requirement["version"] = json!(2);
        bundle["source"]["documentDigest"] =
            json!(digest_value(&raw_document_projection(&bundle["flow"]).unwrap()).unwrap());
        fs::write(&destination, serde_json::to_vec_pretty(&bundle).unwrap()).unwrap();

        let inspection = inspect_import(
            &paths,
            &InspectMediaFlowImportRequest {
                schema_version: 1,
                source_path: destination.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        assert_eq!(inspection.status, MediaFlowImportStatus::InspectOnly);
        assert!(!inspection.can_import);
        assert_eq!(inspection.unknown_nodes.len(), 1);
        assert_eq!(inspection.unknown_nodes[0].node_id, "generate");
        assert_eq!(inspection.unknown_nodes[0].connected_edges.len(), 2);
        assert!(inspection.proposed_flow_id.is_none());
        let error = import_reviewed(
            &paths,
            &ImportMediaFlowRequest {
                schema_version: 1,
                idempotency_key: "unknown-import".to_string(),
                source_path: destination.to_string_lossy().into_owned(),
                review_token: inspection.review_token,
            },
        )
        .unwrap_err();
        assert!(error.contains("inspect-only"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn strict_bundle_parser_rejects_duplicate_object_keys() {
        assert!(parse_strict_json(br#"{"a":1,"a":2}"#).is_err());
    }

    #[test]
    fn pins_runs_to_a_matching_immutable_execution_digest() {
        let paths = test_paths("run-lineage");
        let saved = save(&paths, &request("save-run", None, "Pinned run")).unwrap();
        let snapshot = crate::media::MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: "plan:pinned".to_string(),
            flow_id: "flow:test".to_string(),
            flow_fingerprint: saved.revision.execution_digest.clone(),
            compiled_at: "2026-07-14T00:01:00.000Z".to_string(),
            nodes: vec![crate::media::MediaRunPlanNodeSnapshot {
                id: "generate".to_string(),
                r#type: "task.generate-image".to_string(),
                label: "Generate".to_string(),
                layer: "task".to_string(),
            }],
            steps: vec![crate::media::MediaRunPlanStepSnapshot {
                id: "generate-image".to_string(),
                source_node_id: "generate".to_string(),
                kind: "generate-image".to_string(),
                label: "Generate image".to_string(),
                target: "local".to_string(),
                cacheable: true,
                side_effect: None,
                review: None,
            }],
        };
        let run_request = crate::media::EnqueueFixtureRunRequest {
            run_id: "run:pinned".to_string(),
            flow_id: "flow:test".to_string(),
            flow_revision_id: Some(saved.revision.revision_id.clone()),
            flow_name: "Pinned flow".to_string(),
            plan_id: snapshot.plan_id.clone(),
            prompt: "Pinned run".to_string(),
            model_label: "Fixture".to_string(),
            target: Some("local".to_string()),
            output_count: 1,
            diagnostic_count: 0,
            aspect_ratio: "1:1".to_string(),
            plan_snapshot: Some(snapshot.clone()),
        };

        database::enqueue_fixture_run(&paths, &run_request).unwrap();
        let detail = database::get_run_detail(&paths, "run:pinned").unwrap();
        assert_eq!(
            detail.run.flow_revision_id,
            Some(saved.revision.revision_id.clone())
        );

        let mismatched = crate::media::EnqueueFixtureRunRequest {
            run_id: "run:mismatched".to_string(),
            plan_snapshot: Some(crate::media::MediaRunPlanSnapshot {
                flow_fingerprint: "sha256:mismatched".to_string(),
                ..snapshot
            }),
            ..run_request
        };
        assert!(database::enqueue_fixture_run(&paths, &mismatched)
            .unwrap_err()
            .contains("does not match the compiled plan"));
        let root = paths.database.parent().unwrap().to_path_buf();
        let _ = fs::remove_dir_all(root);
    }
}
