use std::{collections::HashMap, path::Path};

use super::{
    env_commands,
    env_dotenv::{apply_process_env_overrides, parse_dotenv_file},
    merge_user_agent_cli_paths_into_env, merge_user_api_keys_into_env,
    merge_user_web_search_api_keys_into_env,
};

const PLACEHOLDER_TOKENS: [&str; 3] = ["YOUR_", "CHANGE_ME", "PLACEHOLDER"];
const KNOWN_SAMPLE_SECRET_VALUES: [&str; 6] = [
    "sk-user-config",
    "sk-live",
    "pplx-live",
    "tvly-live",
    "tavily-live",
    "serper-live",
];

pub(crate) fn load_global_env() -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    merge_user_api_keys_into_env(&mut values)?;
    merge_user_agent_cli_paths_into_env(&mut values)?;
    merge_user_web_search_api_keys_into_env(&mut values)?;
    apply_process_env_overrides(&mut values);
    Ok(values)
}

pub(super) fn load_workspace_env(workspace_root: &Path) -> Result<HashMap<String, String>, String> {
    let env_path = workspace_root.join(".env");
    let mut values = HashMap::new();

    merge_user_api_keys_into_env(&mut values)?;
    merge_user_agent_cli_paths_into_env(&mut values)?;
    merge_user_web_search_api_keys_into_env(&mut values)?;

    if env_path.exists() {
        for (key, value) in parse_dotenv_file(&env_path)? {
            values.insert(key, value);
        }
    }

    apply_process_env_overrides(&mut values);

    Ok(values)
}

pub(super) fn has_configured_value(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim) else {
        return false;
    };

    if value.is_empty() {
        return false;
    }

    if KNOWN_SAMPLE_SECRET_VALUES.contains(&value) {
        return false;
    }

    !PLACEHOLDER_TOKENS.iter().any(|token| value.contains(token))
}

pub(super) use env_commands::resolve_agent_cli_binary;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_value_rejects_placeholders_samples_and_blanks() {
        assert!(!has_configured_value(Some("")));
        assert!(!has_configured_value(Some("YOUR_API_KEY")));
        assert!(!has_configured_value(Some("sk-live")));
        assert!(has_configured_value(Some("sk-real-value")));
    }
}
