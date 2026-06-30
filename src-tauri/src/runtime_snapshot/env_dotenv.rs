use std::{collections::HashMap, fs, path::Path};

use crate::runtime_contract_generated::{PROVIDER_ENV_KEYS, RUNTIME_ENV_KEYS, WEB_SEARCH_ENV_KEYS};

use super::strip_wrapping_quotes;

pub(super) fn parse_dotenv_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some(separator_index) = trimmed.find('=') else {
            continue;
        };

        let key = trimmed[..separator_index].trim();
        let value = strip_wrapping_quotes(&trimmed[separator_index + 1..]);

        values.insert(key.to_string(), value);
    }

    Ok(values)
}

pub(super) fn apply_process_env_overrides(values: &mut HashMap<String, String>) {
    for key in PROVIDER_ENV_KEYS
        .iter()
        .map(|(_, key)| *key)
        .chain(WEB_SEARCH_ENV_KEYS.iter().map(|(_, key)| *key))
        .chain(RUNTIME_ENV_KEYS.iter().copied())
    {
        if let Ok(value) = std::env::var(key) {
            values.insert(key.to_string(), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn temp_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();

        std::env::temp_dir().join(format!("machdoch-{name}-{unique}"))
    }

    #[test]
    fn dotenv_parser_trims_keys_values_and_ignores_comments() {
        let directory = temp_test_directory("dotenv");
        let env_path = directory.join(".env");
        fs::create_dir_all(&directory).expect("test directory should be creatable");
        fs::write(
            &env_path,
            "\n# comment\nOPENAI_API_KEY = \"sk-test\"\nMACHDOCH_DEFAULT_MODE=machdoch\n",
        )
        .expect("dotenv should be writable");

        let values = parse_dotenv_file(&env_path).expect("dotenv should parse");

        assert_eq!(values.get("OPENAI_API_KEY"), Some(&"sk-test".to_string()));
        assert_eq!(
            values.get("MACHDOCH_DEFAULT_MODE"),
            Some(&"machdoch".to_string())
        );
        assert!(!values.contains_key("# comment"));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn dotenv_parser_preserves_unwrapped_internal_quotes() {
        let directory = temp_test_directory("dotenv-quotes");
        let env_path = directory.join(".env");
        fs::create_dir_all(&directory).expect("test directory should be creatable");
        fs::write(&env_path, "MACHDOCH_VALUE='quoted value'\nRAW=a \"b\" c\n")
            .expect("dotenv should be writable");

        let values = parse_dotenv_file(&env_path).expect("dotenv should parse");

        assert_eq!(
            values.get("MACHDOCH_VALUE"),
            Some(&"quoted value".to_string())
        );
        assert_eq!(values.get("RAW"), Some(&"a \"b\" c".to_string()));

        let _ = fs::remove_dir_all(directory);
    }
}
