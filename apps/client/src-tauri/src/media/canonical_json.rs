use serde_json::Value;
use super::MediaResult;

pub(crate) fn canonical_json(value: &Value) -> MediaResult<String> {
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
            Ok(ryu_js::Buffer::new().format(number).to_string())
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
