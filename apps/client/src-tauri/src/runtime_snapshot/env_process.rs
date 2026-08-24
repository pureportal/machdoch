use std::collections::HashMap;

use crate::runtime_contract_generated::{PROVIDER_ENV_KEYS, RUNTIME_ENV_KEYS, WEB_SEARCH_ENV_KEYS};

pub(super) fn apply_process_env_overrides(values: &mut HashMap<String, String>) {
    for key in PROVIDER_ENV_KEYS
        .iter()
        .map(|(_, key)| *key)
        .chain(WEB_SEARCH_ENV_KEYS.iter().map(|(_, key)| *key))
        .chain(RUNTIME_ENV_KEYS.iter().copied())
    {
        if let Ok(value) = std::env::var(key) {
            let normalized = value.trim();

            if !normalized.is_empty() {
                values.insert(key.to_string(), normalized.to_string());
            }
        }
    }
}
