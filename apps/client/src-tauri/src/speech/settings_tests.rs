use super::*;

fn preferences() -> Value {
    json!({
        "cloudConsent": false,
        "maxConcurrent": 1,
        "pricing": null,
        "budgetLimit": null,
        "answerBudgetLimit": null,
        "answerCharacterLimit": 10000,
        "cacheRetentionDays": 7
    })
}

fn price() -> Value {
    json!({
        "unit": "characters",
        "perMillion": 15.0,
        "currency": "USD",
        "source": "https://fish.audio/pricing?plan=api#rates",
        "effectiveFrom": "2024-02-29",
        "effectiveTo": "2025-03-01"
    })
}

#[test]
fn preference_save_preserves_native_connection_metadata() {
    let saved = json!({
        "connections": [{
            "backend": "sglang",
            "configured": true,
            "healthy": true,
            "error": null,
            "url": "https://runtime.example",
            "model": "drama-3",
            "runtimeVersion": "v0.5.0",
            "maxTextBytes": 16384,
            "maxSpeakers": 16,
            "nativeRevision": false
        }],
        "modelRoot": model_root()
    });
    let mut input = preferences();
    input["cloudConsent"] = json!(true);
    input["pricing"] = price();
    let updated = apply_preferences(&saved, &input).unwrap();
    assert_eq!(updated["connections"], saved["connections"]);
    assert_eq!(updated["modelRoot"], model_root());
    for field in PREFERENCE_FIELDS {
        assert_eq!(updated[field], input[field], "{field}");
    }
}

#[test]
fn preferences_reject_native_fields_unknown_fields_and_nonobjects() {
    for field in ["connections", "modelRoot", "healthy", "secret", "extra"] {
        let mut input = preferences();
        input[field] = json!("overwrite");
        assert!(validate_preferences(&input).is_err(), "{field}");
    }
    for input in [Value::Null, json!([]), json!(true)] {
        assert!(validate_preferences(&input).is_err(), "{input}");
    }
    for field in PREFERENCE_FIELDS {
        let mut input = preferences();
        input.as_object_mut().unwrap().remove(field);
        assert!(validate_preferences(&input).is_err(), "{field}");
    }
}

#[test]
fn preferences_validate_boolean_integer_and_money_types() {
    for (field, invalid) in [
        ("cloudConsent", json!("true")),
        ("cloudConsent", Value::Null),
        ("maxConcurrent", json!(0)),
        ("maxConcurrent", json!(51)),
        ("maxConcurrent", json!(1.5)),
        ("maxConcurrent", json!("1")),
        ("answerCharacterLimit", json!(0)),
        ("answerCharacterLimit", json!(-1)),
        ("answerCharacterLimit", json!(1.5)),
        ("answerCharacterLimit", json!(4294967296_u64)),
        ("answerCharacterLimit", Value::Null),
        ("cacheRetentionDays", json!(-1)),
        ("cacheRetentionDays", json!(0.5)),
        ("cacheRetentionDays", json!("7")),
        ("cacheRetentionDays", json!(4294967296_u64)),
        ("budgetLimit", json!(-0.01)),
        ("budgetLimit", json!("10")),
        ("budgetLimit", json!(false)),
    ] {
        let mut input = preferences();
        input[field] = invalid;
        assert!(validate_preferences(&input).is_err(), "{field}: {}", input[field]);
    }
    let mut input = preferences();
    input["maxConcurrent"] = json!(50);
    input["answerCharacterLimit"] = json!(u32::MAX);
    input["cacheRetentionDays"] = json!(0);
    input["budgetLimit"] = json!(0);
    assert!(validate_preferences(&input).is_ok());
}

#[test]
fn pricing_requires_all_current_fields_and_valid_rates() {
    for field in ["unit", "perMillion", "currency", "source", "effectiveFrom", "effectiveTo"] {
        let mut input = preferences();
        input["pricing"] = price();
        input["pricing"].as_object_mut().unwrap().remove(field);
        assert!(validate_preferences(&input).is_err(), "{field}");
    }
    for (field, invalid) in [
        ("extra", json!(true)),
        ("unit", json!("tokens")),
        ("unit", json!(1)),
        ("perMillion", json!(-1)),
        ("perMillion", json!("15")),
        ("perMillion", Value::Null),
        ("currency", json!("usd")),
        ("currency", json!("US")),
        ("currency", json!("USDD")),
        ("currency", json!("$")),
        ("currency", json!(" USD")),
        ("currency", json!(123)),
        ("source", json!("")),
        ("source", json!("pricing")),
        ("source", json!("file:///pricing")),
        ("source", json!("https://user:secret@fish.audio/pricing")),
        ("source", json!("https://fish.audio/pricing\n")),
        ("source", json!(true)),
    ] {
        let mut input = preferences();
        input["pricing"] = price();
        input["pricing"][field] = invalid;
        assert!(validate_preferences(&input).is_err(), "{field}: {}", input["pricing"][field]);
    }
    for invalid in [json!([]), json!(true), json!("price")] {
        let mut input = preferences();
        input["pricing"] = invalid;
        assert!(validate_preferences(&input).is_err());
    }
    for unit in ["characters", "utf8Bytes"] {
        let mut input = preferences();
        input["pricing"] = price();
        input["pricing"]["unit"] = json!(unit);
        input["pricing"]["perMillion"] = json!(0);
        assert!(validate_preferences(&input).is_ok());
    }
}

#[test]
fn pricing_dates_require_real_ordered_calendar_dates() {
    for date in [
        "", "2024-2-29", "2023-02-29", "1900-02-29", "2024-04-31",
        "0000-01-01", "2024-00-01", "2024-13-01", "2024-01-00",
        "2024-01-32", "2024-02-29T00:00:00Z", "2024-02-29 ",
        "2024-02-2x", "é024-02-2", "2025-03-01", "2026-01-01",
    ] {
        let mut input = preferences();
        input["pricing"] = price();
        input["pricing"]["effectiveFrom"] = json!(date);
        assert!(validate_preferences(&input).is_err(), "{date}");
    }
    for date in ["2000-02-29", "2024-02-29"] {
        assert_eq!(pricing_date(&json!(date)).unwrap(), date);
    }
    let mut input = preferences();
    input["pricing"] = price();
    input["pricing"]["effectiveTo"] = json!("2024-02-29");
    assert!(validate_preferences(&input).is_err());
    input["pricing"]["effectiveTo"] = json!(null);
    assert!(validate_preferences(&input).is_err());
}

#[test]
fn connections_reject_unknown_fields_and_invalid_optional_types() {
    for input in [Value::Null, json!([]), json!({}), json!({"backend":"other"})] {
        assert!(validate_connection(&input).is_err(), "{input}");
    }
    for field in ["secret", "deleteSecret", "url", "runtimeVersion", "model", "healthy", "configured", "extra"] {
        let mut input = json!({"backend":"sglang"});
        input[field] = Value::Null;
        assert!(validate_connection(&input).is_err(), "{field}");
    }
    for (field, invalid) in [
        ("secret", json!(42)),
        ("deleteSecret", json!("true")),
        ("deleteSecret", json!(1)),
        ("url", json!(true)),
        ("runtimeVersion", json!(1)),
        ("model", json!([])),
    ] {
        let mut input = json!({"backend":"sglang"});
        input[field] = invalid;
        assert!(validate_connection(&input).is_err(), "{field}");
    }
}

#[test]
fn connection_model_is_pinned_for_every_backend() {
    for (backend, model) in [
        ("fish-cloud", "drama-3"),
        ("sglang", "drama-3"),
        ("openai", "gpt-4o-mini-tts"),
        ("google", "gemini-3.1-flash-tts-preview"),
    ] {
        assert!(validate_connection(&json!({"backend":backend,"model":model})).is_ok());
        assert!(validate_connection(&json!({"backend":backend,"secret":"new-key","model":"other"})).is_err());
    }
}

#[test]
fn connections_reject_combined_secret_save_and_delete() {
    for backend in ["fish-cloud", "sglang", "openai", "google"] {
        assert!(validate_connection(&json!({"backend":backend,"secret":"new-key","deleteSecret":true})).is_err());
        assert!(validate_connection(&json!({"backend":backend,"deleteSecret":true})).unwrap().delete_secret);
        let input = json!({"backend":backend,"secret":"  new-key  ","deleteSecret":false});
        assert_eq!(validate_connection(&input).unwrap().secret, Some("new-key"));
    }
}

#[test]
fn connections_reject_empty_keys_whitespace_and_controls() {
    for secret in ["", " ", "new\nkey", "new-key\n", "\rnew-key", "new\tkey", "new key", "new\u{0}key", "new\u{7f}key"] {
        assert!(validate_connection(&json!({"backend":"openai","secret":secret})).is_err());
    }
}

#[test]
fn cloud_connections_reject_runtime_overrides() {
    for backend in ["fish-cloud", "openai", "google"] {
        for (field, value) in [("url", "https://runtime.example"), ("runtimeVersion", "v0.5.0")] {
            let mut input = json!({"backend":backend,"secret":"new-key"});
            input[field] = json!(value);
            assert!(validate_connection(&input).is_err(), "{backend}: {field}");
        }
    }
}

#[test]
fn runtime_urls_require_secure_remote_or_loopback_endpoints() {
    for url in [
        "http://localhost:8000/", "http://127.0.0.1:8000", "http://[::1]:8000",
        "https://runtime.example/speech/",
    ] {
        assert!(validate_runtime_url(url).is_ok(), "{url}");
    }
    assert_eq!(validate_runtime_url("https://runtime.example/speech/").unwrap(), "https://runtime.example/speech");
    for url in [
        "", "runtime.example", "file:///runtime", "http://runtime.example",
        "http://192.168.1.5:8000", "https://user:secret@runtime.example",
        "https://runtime.example?api_key=secret", "https://runtime.example#version",
        "https://runtime.example\n", " https://runtime.example", "https://runtime.example/a b",
    ] {
        let input = json!({"backend":"sglang","secret":"new-key","url":url});
        assert!(validate_connection(&input).is_err(), "{url}");
    }
}

#[test]
fn runtime_versions_require_specific_tokens() {
    for version in ["v0.5.0", "0.5.0+build.1", "a1b2c3d4", "sha256:abc123"] {
        assert!(validate_runtime_version(version).is_ok(), "{version}");
    }
    for version in ["", " ", "latest", "LATEST", "main", "master", "nightly", "stable", "dev", "v0.5.0\n", " v0.5.0", "-invalid", "version 1"] {
        let input = json!({"backend":"sglang","secret":"new-key","runtimeVersion":version});
        assert!(validate_connection(&input).is_err(), "{version}");
    }
    assert!(validate_runtime_version(&"v".repeat(129)).is_err());
}

#[test]
fn self_hosted_connection_is_complete_before_credentials_can_be_changed() {
    let saved = json!({"connections":[]});
    for input in [
        json!({"backend":"sglang","secret":"new-key"}),
        json!({"backend":"sglang","secret":"new-key","url":"https://runtime.example"}),
        json!({"backend":"sglang","secret":"new-key","runtimeVersion":"v0.5.0"}),
        json!({"backend":"sglang","deleteSecret":true,"url":"https://runtime.example"}),
        json!({"backend":"sglang","deleteSecret":true,"runtimeVersion":"v0.5.0"}),
    ] {
        let update = validate_connection(&input).unwrap();
        assert!(apply_connection_update(&saved, &update).is_err());
        assert_eq!(saved, json!({"connections":[]}));
    }
    let input = json!({"backend":"sglang","secret":"new-key","url":"https://runtime.example","runtimeVersion":"v0.5.0"});
    let update = validate_connection(&input).unwrap();
    let saved = apply_connection_update(&saved, &update).unwrap();
    assert_eq!(saved["connections"][0]["url"], "https://runtime.example");
    assert_eq!(saved["connections"][0]["runtimeVersion"], "v0.5.0");
    assert_eq!(saved["connections"][0]["model"], "drama-3");
    let input = json!({"backend":"sglang","secret":"replacement-key"});
    assert!(apply_connection_update(&saved, &validate_connection(&input).unwrap()).is_ok());
    for (field, invalid) in [("url", "http://runtime.example"), ("runtimeVersion", "latest")] {
        let mut damaged = saved.clone();
        damaged["connections"][0][field] = json!(invalid);
        assert!(apply_connection_update(&damaged, &validate_connection(&input).unwrap()).is_err());
    }
}

#[test]
fn connection_updates_preserve_other_connections_and_preferences() {
    let mut saved = preferences();
    saved["connections"] = json!([
        {"backend":"fish-cloud","healthy":true,"maxTextBytes":16384},
        {"backend":"sglang","healthy":false,"error":"old failure","url":"https://runtime.example","runtimeVersion":"v0.5.0"}
    ]);
    let input = json!({"backend":"sglang","deleteSecret":true});
    let updated = apply_connection_update(&saved, &validate_connection(&input).unwrap()).unwrap();
    assert_eq!(updated["connections"][0], saved["connections"][0]);
    assert!(updated["connections"][1]["healthy"].is_null());
    assert!(updated["connections"][1]["error"].is_null());
    for field in PREFERENCE_FIELDS {
        assert_eq!(updated[field], saved[field], "{field}");
    }
    assert!(apply_connection_update(&json!({"connections":null}), &validate_connection(&input).unwrap()).is_err());
}
