use keyring::Entry;
use serde_json::json;

fn present(backend: &str) -> Result<bool, String> {
    let entry = Entry::new("machdoch.speech", backend).map_err(|_| "Credential store unavailable.")?;
    match entry.get_password() {
        Ok(secret) => Ok(!secret.trim().is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Credential store entry could not be read.".into()),
    }
}

fn main() {
    let fish = present("fish-cloud");
    let sglang = present("sglang");
    let result = json!({
        "platform":std::env::consts::OS,
        "credentialStoreAvailable":Entry::store_status().is_ok(),
        "fishCloudEntry":fish,
        "sglangEntry":sglang,
        "processFishEnvironment":std::env::var("FISH_API_KEY").ok().is_some_and(|value|!value.trim().is_empty()),
        "processSglangEnvironment":std::env::var("MACHDOCH_SPEECH_SGLANG_KEY").ok().is_some_and(|value|!value.trim().is_empty())
    });
    println!("{result}");
}
