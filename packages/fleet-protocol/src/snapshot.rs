use serde::{de::Error, Deserialize, Deserializer};
use serde_json::Value;

pub(crate) fn deserialize_product_snapshot<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let snapshot = Value::deserialize(deserializer)?;
    let object = snapshot
        .as_object()
        .ok_or_else(|| D::Error::custom("Product snapshot must be an object."))?;

    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "enabled" | "serverTime" | "eventId" | "sessions" | "commands" | "shell"
        )
    }) {
        return Err(D::Error::custom(
            "Product snapshot contains an unknown field.",
        ));
    }
    if !object.get("enabled").is_some_and(Value::is_boolean) {
        return Err(D::Error::custom(
            "Product snapshot requires a boolean enabled field.",
        ));
    }
    for field in ["serverTime", "eventId"] {
        if !object
            .get(field)
            .and_then(Value::as_f64)
            .is_some_and(|value| {
                (0.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0
            })
        {
            return Err(D::Error::custom(format!(
                "Product snapshot requires a nonnegative safe integer {field}."
            )));
        }
    }
    for field in ["sessions", "commands"] {
        if !object.get(field).is_some_and(Value::is_array) {
            return Err(D::Error::custom(format!(
                "Product snapshot requires a {field} array."
            )));
        }
    }
    Ok(snapshot)
}
