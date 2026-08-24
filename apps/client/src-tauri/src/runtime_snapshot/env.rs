use std::collections::HashMap;

use super::{
    env_commands, env_process::apply_process_env_overrides, merge_user_agent_cli_paths_into_env,
    merge_user_api_keys_into_env, merge_user_web_search_api_keys_into_env,
};

pub(crate) fn load_global_env() -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    merge_user_api_keys_into_env(&mut values)?;
    merge_user_agent_cli_paths_into_env(&mut values)?;
    merge_user_web_search_api_keys_into_env(&mut values)?;
    apply_process_env_overrides(&mut values);
    Ok(values)
}

pub(super) fn has_configured_value(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim) else {
        return false;
    };

    !value.is_empty()
}

pub(super) use env_commands::resolve_agent_cli_binary;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_value_requires_only_an_explicit_non_empty_value() {
        assert!(!has_configured_value(Some("")));
        assert!(has_configured_value(Some("YOUR_API_KEY")));
        assert!(has_configured_value(Some("sk-live")));
        assert!(has_configured_value(Some("real-PLACEHOLDER-token")));
        assert!(has_configured_value(Some("sk-real-value")));
    }
}
