use serde::{de::Error as _, Deserialize, Deserializer};
use serde_json::{Map, Value};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_MEDIA_BYTES: f64 = 64.0 * 1024.0 * 1024.0;
const MAX_RESPONSE_CHUNK: usize = 262_144;

const MEDIA_COMMANDS: &[&str] = &[
    "media_read_studio_state",
    "media_write_studio_state",
    "media_create_transfer",
    "media_write_transfer",
    "run_media_flow_agent",
    "media_read_transfer",
    "media_remove_transfer",
    "media_analyze_image_quality",
    "media_auto_tag_asset",
    "media_cancel_civitai_download",
    "media_cancel_model_install",
    "media_cancel_run",
    "media_civitai_connection",
    "media_civitai_options",
    "media_connect_civitai",
    "media_delete_asset",
    "media_discover_workspace_models",
    "media_download_civitai_resource",
    "media_execute_local_image_flow",
    "media_execute_remote_image_edit_flow",
    "media_execute_workflow",
    "media_export_asset",
    "media_export_flow_revision",
    "media_generate_images",
    "media_generate_svg",
    "media_generate_video",
    "media_generate_audio",
    "media_get_civitai_model",
    "media_get_flow",
    "media_get_model_catalog",
    "media_get_model_install_job",
    "media_get_run_detail",
    "media_get_runtime_setup",
    "media_import_flow",
    "media_import_asset",
    "media_create_pose_map",
    "media_install_pose_control",
    "media_import_image_url",
    "media_import_local_model",
    "media_import_model_addon",
    "media_initialize_runtime",
    "media_inspect_civitai_file",
    "media_civitai_storage",
    "media_inspect_civitai_model_addon",
    "media_inspect_flow_import",
    "media_inspect_hardware",
    "media_inspect_local_model",
    "media_inspect_model_addon",
    "media_install_workflow_model",
    "media_list_asset_page",
    "media_list_assets",
    "media_list_flows",
    "media_list_run_page",
    "media_list_runs",
    "media_plan_asset_deletion",
    "media_plan_model_addon_removal",
    "media_plan_model_install",
    "media_plan_model_removal",
    "media_read_asset_preview",
    "media_read_quality_report",
    "media_refresh_local_diffusers_runtime",
    "media_remove_model",
    "media_remove_model_addon",
    "media_resolve_human_review",
    "media_resolve_provider_review",
    "media_save_flow_revision",
    "media_search_civitai",
    "media_set_asset_tags",
    "media_start_model_install",
    "media_start_runtime_setup",
    "media_transform_image",
    "media_update_model_resource",
    "media_wake_provider_reconciliation",
];

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum MediaRequest {
    Release {
        id: String,
    },
    Invoke {
        id: String,
        command: String,
        args: Map<String, Value>,
    },
    Read {
        id: String,
        offset: Value,
    },
    Events {
        after: Value,
    },
}

pub(super) fn deserialize_media_request<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let request = Value::deserialize(deserializer)?;
    let typed: MediaRequest = serde_json::from_value(request.clone()).map_err(D::Error::custom)?;
    let valid = match typed {
        MediaRequest::Release { id } => valid_uuid(&id),
        MediaRequest::Invoke { id, command, args } => {
            valid_uuid(&id) && MEDIA_COMMANDS.contains(&command.as_str()) && valid_json_args(&args)
        }
        MediaRequest::Read { id, offset } => {
            valid_uuid(&id) && valid_nonnegative_integer(&offset, MAX_MEDIA_BYTES)
        }
        MediaRequest::Events { after } => valid_nonnegative_integer(&after, MAX_SAFE_INTEGER),
    };
    if !valid {
        return Err(D::Error::custom("invalid media request"));
    }
    Ok(request)
}

pub(super) fn deserialize_media_response<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let response = Value::deserialize(deserializer)?;
    if response.get("state").and_then(Value::as_str) != Some("complete") {
        return Ok(response);
    }

    let valid = response.as_object().is_some_and(|fields| {
        let Some(chunk) = fields.get("chunk").and_then(Value::as_str) else {
            return false;
        };
        let Some(offset) = fields.get("offset") else {
            return false;
        };
        let Some(total) = fields.get("total") else {
            return false;
        };
        let chunk_length = chunk.encode_utf16().count();
        if fields.len() != 4
            || chunk_length > MAX_RESPONSE_CHUNK
            || !valid_nonnegative_integer(offset, MAX_MEDIA_BYTES)
            || !valid_nonnegative_integer(total, MAX_MEDIA_BYTES)
        {
            return false;
        }
        let offset = offset.as_f64().expect("validated offset is numeric");
        let total = total.as_f64().expect("validated total is numeric");
        let chunk_length = chunk_length as f64;
        offset <= total && chunk_length <= total - offset && (chunk_length > 0.0 || offset == total)
    });
    if !valid {
        return Err(D::Error::custom("invalid complete media response"));
    }
    Ok(response)
}

fn valid_json_args(args: &Map<String, Value>) -> bool {
    args.values().all(valid_json_value)
}

fn valid_json_value(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::Array(values) => values.iter().all(valid_json_value),
        Value::Object(values) => values.values().all(valid_json_value),
    }
}

fn valid_nonnegative_integer(value: &Value, max: f64) -> bool {
    value.as_f64().is_some_and(|number| {
        number.is_finite() && number.fract() == 0.0 && (0.0..=max).contains(&number)
    })
}

fn valid_uuid(id: &str) -> bool {
    if id == "00000000-0000-0000-0000-000000000000" || id == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => (b'1'..=b'8').contains(byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::super::{deserialize_host_message, HostResponse};
    use serde_json::json;

    #[test]
    fn complete_media_response_bounds_match_the_host_message_boundary() {
        let cases = [
            ("partial chunk", "abc".to_owned(), 2, 10, true),
            ("empty result", String::new(), 0, 0, true),
            ("empty final chunk", String::new(), 3, 3, true),
            ("offset beyond total", String::new(), 11, 10, false),
            ("chunk overruns total", "abc".to_owned(), 8, 10, false),
            ("empty partial chunk", String::new(), 2, 10, false),
            (
                "total at maximum",
                "a".to_owned(),
                64 * 1024 * 1024 - 1,
                64 * 1024 * 1024,
                true,
            ),
            (
                "total beyond maximum",
                "a".to_owned(),
                64 * 1024 * 1024,
                64 * 1024 * 1024 + 1,
                false,
            ),
            ("chunk at maximum", "a".repeat(262_144), 0, 262_144, true),
            (
                "chunk beyond maximum",
                "a".repeat(262_145),
                0,
                262_145,
                false,
            ),
        ];

        for (name, chunk, offset, total, accepted) in cases {
            let host_response = json!({
                "type": "media",
                "response": { "state": "complete", "chunk": chunk, "offset": offset, "total": total },
            });
            assert_eq!(
                serde_json::from_value::<HostResponse>(host_response.clone()).is_ok(),
                accepted,
                "{name}"
            );
            let host_message = json!({
                "type": "response",
                "requestId": "request-1",
                "response": host_response,
            });
            assert_eq!(
                deserialize_host_message(host_message.to_string()).is_ok(),
                accepted,
                "{name}"
            );
        }
    }
}
