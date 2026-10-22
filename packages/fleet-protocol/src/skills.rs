use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Skill {
    name: String,
    description: String,
    content: String,
    enabled: bool,
    expected_fingerprint: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    List,
    Save { skill: Skill },
    Delete { name: String, #[serde(rename = "expectedFingerprint")] expected_fingerprint: String },
}

fn name_valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.split('-').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
}

fn fingerprint_valid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn valid_request(value: &Value) -> bool {
    match serde_json::from_value::<Request>(value.clone()) {
        Ok(Request::List) => true,
        Ok(Request::Save { skill }) => {
            let _ = skill.enabled;
            name_valid(&skill.name)
                && !skill.description.is_empty() && skill.description.encode_utf16().count() <= 1024 && !skill.description.contains('\0')
                && !skill.content.is_empty() && skill.content.encode_utf16().count() <= 128 * 1024 && !skill.content.contains('\0')
                && skill.expected_fingerprint.as_deref().is_none_or(fingerprint_valid)
        },
        Ok(Request::Delete { name, expected_fingerprint }) => name_valid(&name) && fingerprint_valid(&expected_fingerprint),
        Err(_) => false,
    }
}
