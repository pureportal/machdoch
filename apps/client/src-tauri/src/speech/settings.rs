use keyring::Entry;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use super::store::SpeechStore;

const PREFERENCE_FIELDS: [&str; 7] = [
    "cloudConsent", "maxConcurrent", "pricing", "budgetLimit",
    "answerCharacterLimit", "cacheRetentionDays", "answerBudgetLimit",
];

pub fn model_root() -> &'static str {
    if cfg!(windows) { "D:\\Models\\machdoch" } else { "/mnt/d/Models/machdoch" }
}

fn backend_model(backend: &str) -> Result<&'static str, String> {
    match backend {
        "drama3" | "fish-cloud" | "sglang" => Ok("drama-3"),
        "openai" => Ok("gpt-4o-mini-tts"),
        "google" => Ok("gemini-3.1-flash-tts-preview"),
        _ => Err("Choose a supported speech backend.".to_string()),
    }
}

fn default_connection(backend: &str, model: &str) -> Value {
    json!({"backend":backend,"healthy":null,"error":null,"runtimeVersion":null,"model":model,"nativeRevision":false,"maxTextBytes":null,"maxSpeakers":if backend=="sglang"{Some(1)}else{None}})
}

pub fn raw_settings(store: &SpeechStore) -> Result<Value, String> {
    store.connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").map_err(|_| "Speech settings could not be opened.".to_string())?;
    let saved: Option<String> = store.connection.query_row("SELECT value FROM speech_settings WHERE key='settings'", [], |row| row.get(0)).optional().map_err(|_| "Speech settings could not be read.".to_string())?;
    match saved {
        Some(value) => serde_json::from_str(&value).map_err(|_| "Speech settings are damaged. Restore the settings backup.".to_string()),
        None => Ok(json!({"connections":[],"modelRoot":model_root(),"cloudConsent":false,"maxConcurrent":1,"pricing":null,"budgetLimit":null,"answerBudgetLimit":null,"answerCharacterLimit":10000,"cacheRetentionDays":7})),
    }
}

pub fn credential(backend: &str) -> Result<Option<String>, String> {
    let environment_key = match backend { "fish-cloud" => "FISH_API_KEY", "sglang" => "MACHDOCH_SPEECH_SGLANG_KEY", "openai" => "OPENAI_API_KEY", "google" => "GOOGLE_API_KEY", _ => return Err("Choose a supported speech backend.".to_string()) };
    let environment = crate::runtime_snapshot::load_global_env()?;
    if let Some(value) = environment.get(environment_key).filter(|value| !value.trim().is_empty()) { return Ok(Some(value.clone())); }
    if let Ok(value) = std::env::var(environment_key) { if !value.trim().is_empty() { return Ok(Some(value)); } }
    if matches!(backend,"openai"|"google") { return Ok(None); }
    match Entry::new("machdoch.speech", backend).map_err(|_| "The OS credential store is unavailable. Unlock it and try again.".to_string())?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("The OS credential store could not be read. Unlock it and try again.".to_string()),
    }
}

pub fn settings(store: &SpeechStore) -> Result<Value, String> {
    let mut settings = raw_settings(store)?;
    let mut connections = vec![super::drama3_model::connection()];
    for backend in ["fish-cloud", "sglang", "openai", "google"] {
        let saved = settings["connections"].as_array().and_then(|values| values.iter().find(|value| value["backend"] == backend));
        let model = backend_model(backend)?;
        let configured = credential(backend)?.is_some() || (backend == "sglang" && saved.and_then(|value| value["url"].as_str()).is_some());
        let mut connection = saved.cloned().unwrap_or_else(|| default_connection(backend, model));
        connection["configured"] = json!(configured);
        connection["nativeRevision"] = json!(false);
        if backend=="sglang"{connection["maxSpeakers"]=json!(1);}
        connections.push(connection);
    }
    settings["connections"] = json!(connections);
    settings["modelRoot"] = json!(model_root());
    Ok(settings)
}

pub fn connection_snapshot(store:&SpeechStore,backend:&str)->Result<Value,String>{
    if backend=="drama3"{return Ok(super::drama3_model::connection())}
    let settings=raw_settings(store)?;
    Ok(settings["connections"].as_array().and_then(|connections|connections.iter().find(|connection|connection["backend"]==backend)).cloned().unwrap_or(default_connection(backend,backend_model(backend)?)))
}

fn input_fields<'a>(input: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let fields = input.as_object().ok_or("Supply a speech settings object.")?;
    if fields.keys().any(|field| !allowed.contains(&field.as_str())) {
        return Err("Remove unsupported fields from the speech settings request.".to_string());
    }
    Ok(fields)
}

fn pricing_date(value: &Value) -> Result<&str, String> {
    let date = value.as_str().ok_or("Enter pricing dates as YYYY-MM-DD.")?;
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || bytes.iter().enumerate().any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return Err("Enter pricing dates as YYYY-MM-DD.".to_string());
    }
    let year: u32 = date[..4].parse().map_err(|_| "Enter a valid pricing year.")?;
    let month: u32 = date[5..7].parse().map_err(|_| "Enter a valid pricing month.")?;
    let day: u32 = date[8..].parse().map_err(|_| "Enter a valid pricing day.")?;
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    if year == 0 || day == 0 || day > days {
        return Err("Enter valid calendar dates for pricing.".to_string());
    }
    Ok(date)
}

fn validate_preferences(input: &Value) -> Result<&Map<String, Value>, String> {
    let fields = input_fields(input, &PREFERENCE_FIELDS)?;
    if PREFERENCE_FIELDS.iter().any(|field| !fields.contains_key(*field)) {
        return Err("Supply all speech preference fields.".to_string());
    }
    if !input["cloudConsent"].is_boolean() {
        return Err("Choose whether to send synthesis material to the cloud.".to_string());
    }
    for (field, minimum, maximum) in [
        ("maxConcurrent", 1, 50),
        ("answerCharacterLimit", 1, u32::MAX as u64),
        ("cacheRetentionDays", 0, u32::MAX as u64),
    ] {
        if !input[field].as_u64().is_some_and(|value| (minimum..=maximum).contains(&value)) {
            return Err(format!("Use a whole number from {minimum} to {maximum} for {field}."));
        }
    }
    if !input["budgetLimit"].is_null()
        && !input["budgetLimit"].as_f64().is_some_and(|value| value.is_finite() && value >= 0.0)
    {
        return Err("Use a nonnegative spending limit.".to_string());
    }
    if !input["answerBudgetLimit"].is_null()
        && !input["answerBudgetLimit"].as_f64().is_some_and(|value| value.is_finite() && value >= 0.0)
    {
        return Err("Use a nonnegative automatic speech spending limit.".to_string());
    }
    if !input["pricing"].is_null() {
        let price = &input["pricing"];
        let price_fields = ["unit", "perMillion", "currency", "source", "effectiveFrom", "effectiveTo"];
        let fields = input_fields(price, &price_fields)?;
        if price_fields.iter().any(|field| !fields.contains_key(*field))
            || !matches!(price["unit"].as_str(), Some("characters" | "utf8Bytes"))
            || !price["perMillion"].as_f64().is_some_and(|value| value.is_finite() && value >= 0.0)
        {
            return Err("Enter a pricing unit and a nonnegative rate.".to_string());
        }
        let currency = price["currency"].as_str().ok_or("Use a three-letter uppercase currency code.")?;
        if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
            return Err("Use a three-letter uppercase currency code.".to_string());
        }
        let source = price["source"].as_str().ok_or("Enter an HTTP(S) pricing source URL.")?;
        let parsed = url::Url::parse(source).map_err(|_| "Enter an HTTP(S) pricing source URL.")?;
        if source.chars().any(|character| character.is_whitespace() || character.is_control())
            || !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
            || !parsed.username().is_empty() || parsed.password().is_some()
        {
            return Err("Use an HTTP(S) pricing source URL without credentials.".to_string());
        }
        let from = pricing_date(&price["effectiveFrom"])?;
        let to = pricing_date(&price["effectiveTo"])?;
        if to <= from {
            return Err("Set the pricing end date after the start date.".to_string());
        }
    }
    Ok(fields)
}

fn apply_preferences(saved: &Value, input: &Value) -> Result<Value, String> {
    let fields = validate_preferences(input)?;
    let mut saved = saved.as_object().ok_or("Speech settings are damaged. Restore the settings backup.")?.clone();
    for field in PREFERENCE_FIELDS {
        saved.insert(field.to_string(), fields[field].clone());
    }
    saved.insert("modelRoot".to_string(), json!(model_root()));
    Ok(Value::Object(saved))
}

pub(super) fn persist_settings(store: &SpeechStore, settings: &Value) -> Result<(), String> {
    store.connection.execute("INSERT INTO speech_settings(key,value) VALUES('settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [settings.to_string()]).map_err(|_| "Speech settings could not be saved.".to_string())?;
    Ok(())
}

pub fn save_settings(store: &SpeechStore, preferences: &Value) -> Result<Value, String> {
    let saved = apply_preferences(&raw_settings(store)?, preferences)?;
    store.cache_retention_cutoff(saved["cacheRetentionDays"].as_u64().ok_or("Enter a whole cache retention period.")?,chrono::Utc::now())?;
    persist_settings(store, &saved)?;
    settings(store)
}

struct ConnectionUpdate<'a> {
    backend: &'a str,
    secret: Option<&'a str>,
    delete_secret: bool,
    url: Option<String>,
    runtime_version: Option<&'a str>,
}

fn optional_string<'a>(input: &'a Value, field: &str) -> Result<Option<&'a str>, String> {
    input.get(field).map(|value| value.as_str().ok_or_else(|| format!("Use a string for {field}."))).transpose()
}

fn validate_runtime_version(version: &str) -> Result<(), String> {
    if version.is_empty() || version.len() > 128
        || !version.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-+:@/".contains(&byte))
        || !version.as_bytes()[0].is_ascii_alphanumeric()
        || matches!(version.to_ascii_lowercase().as_str(), "latest" | "main" | "master" | "nightly" | "stable" | "dev")
    {
        return Err("Pin a specific self-hosted runtime version without spaces.".to_string());
    }
    Ok(())
}

fn validate_runtime_url(value: &str) -> Result<String, String> {
    let parsed = url::Url::parse(value).map_err(|_| "Enter a valid self-hosted URL.")?;
    if value.chars().any(|character| character.is_whitespace() || character.is_control())
        || !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some()
        || parsed.query().is_some() || parsed.fragment().is_some()
    {
        return Err("Use an HTTP(S) backend URL without credentials, query parameters or fragments.".to_string());
    }
    if parsed.scheme() == "http" && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("Use HTTPS for a remote speech runtime.".to_string());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn validate_connection(input: &Value) -> Result<ConnectionUpdate<'_>, String> {
    input_fields(input, &["backend", "secret", "deleteSecret", "url", "runtimeVersion", "model"])?;
    let backend = input["backend"].as_str().ok_or("Choose a speech backend.")?;
    if backend == "drama3" { return Err("Manage the local Drama 3 model in Text to Speech settings.".into()) }
    let expected_model = backend_model(backend)?;
    let secret = optional_string(input, "secret")?;
    if secret.is_some_and(|value| value.chars().any(char::is_control)) {
        return Err("Enter an API key without control characters.".to_string());
    }
    let secret = secret.map(str::trim);
    let delete_secret = input.get("deleteSecret").map(|value| value.as_bool().ok_or("Choose whether to delete the API key.")).transpose()?.unwrap_or(false);
    if secret.is_some() && delete_secret {
        return Err("Save or remove the API key in separate requests.".to_string());
    }
    if secret.is_some_and(|value| value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_graphic())) {
        return Err("Enter a nonempty API key without spaces or control characters.".to_string());
    }
    if optional_string(input, "model")?.is_some_and(|model| model != expected_model) {
        return Err("Choose the pinned model for this speech backend.".to_string());
    }
    let url = optional_string(input, "url")?;
    let runtime_version = optional_string(input, "runtimeVersion")?;
    if backend != "sglang" && (url.is_some() || runtime_version.is_some()) {
        return Err("Set an endpoint and runtime version only for the self-hosted backend.".to_string());
    }
    let url = url.map(validate_runtime_url).transpose()?;
    if let Some(version) = runtime_version {
        validate_runtime_version(version)?;
    }
    Ok(ConnectionUpdate { backend, secret, delete_secret, url, runtime_version })
}

fn apply_connection_update(saved: &Value, update: &ConnectionUpdate<'_>) -> Result<Value, String> {
    let mut saved = saved.clone();
    let connections = saved.get_mut("connections").and_then(Value::as_array_mut).ok_or("Speech connection settings are damaged.")?;
    let index = match connections.iter().position(|value| value["backend"] == update.backend) {
        Some(index) => index,
        None => {
            connections.push(default_connection(update.backend, backend_model(update.backend)?));
            connections.len() - 1
        }
    };
    let connection = connections[index].as_object_mut().ok_or("Speech connection settings are damaged.")?;
    connection.insert("model".to_string(), json!(backend_model(update.backend)?));
    if let Some(url) = &update.url {
        connection.insert("url".to_string(), json!(url));
    }
    if let Some(version) = update.runtime_version {
        connection.insert("runtimeVersion".to_string(), json!(version));
    }
    if update.backend == "sglang" && (!update.delete_secret || update.url.is_some() || update.runtime_version.is_some()) {
        let url = connection.get("url").and_then(Value::as_str).ok_or("Enter the self-hosted endpoint URL.")?;
        validate_runtime_url(url)?;
        let version = connection.get("runtimeVersion").and_then(Value::as_str).ok_or("Pin the self-hosted runtime version.")?;
        validate_runtime_version(version)?;
    }
    connection.insert("healthy".to_string(), Value::Null);
    connection.insert("error".to_string(), Value::Null);
    Ok(saved)
}

pub fn set_connection(store: &SpeechStore, input: &Value) -> Result<Value, String> {
    let update = validate_connection(input)?;
    let saved = apply_connection_update(&raw_settings(store)?, &update)?;
    if matches!(update.backend, "openai" | "google") {
        if update.delete_secret {
            crate::runtime_snapshot::save_shared_speech_key(update.backend, None)?;
        } else if let Some(secret) = update.secret {
            crate::runtime_snapshot::save_shared_speech_key(update.backend, Some(secret))?;
        }
    } else if update.secret.is_some() || update.delete_secret {
        let entry = Entry::new("machdoch.speech", update.backend).map_err(|_| "The OS credential store is unavailable.".to_string())?;
        if update.delete_secret {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {},
                Err(_) => return Err("The speech credential could not be deleted.".to_string()),
            }
        } else if let Some(secret) = update.secret {
            entry.set_password(secret).map_err(|_| "The speech credential could not be saved to the OS credential store.".to_string())?;
        }
    }
    persist_settings(store, &saved)?;
    settings(store)?["connections"].as_array().and_then(|values| values.iter().find(|value| value["backend"] == update.backend)).cloned().ok_or("Speech connection was not found.".to_string())
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
