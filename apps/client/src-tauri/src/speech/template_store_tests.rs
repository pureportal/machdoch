use super::*;

fn database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
         CREATE TABLE profiles(id TEXT PRIMARY KEY);
         CREATE TABLE assets(id TEXT PRIMARY KEY);",
        )
        .unwrap();
    connection
}

fn template(id: &str, name: &str) -> Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "source": "Hello {{name}}.",
        "cast": [{
            "id": "narrator",
            "name": "Narrator",
            "voiceId": "voice-narrator",
            "referenceAssetIds": [],
            "direction": ""
        }],
        "profileId": null,
        "exportSettings": {
            "format": "wav",
            "sampleRate": 44100,
            "channels": 1,
            "bitrate": 128000,
            "loudnessLufs": null,
            "truePeakDb": null
        },
        "revisionId": "client-revision",
        "parentRevisionId": null,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    })
}

fn save(
    connection: &mut Connection,
    template: &Value,
    expected: Option<&str>,
) -> Result<Value, String> {
    execute_template_on(
        connection,
        "saveTemplate",
        &serde_json::json!({
            "template": template,
            "expectedRevisionId": expected,
        }),
    )
}

fn history_count(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM template_revisions", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn template_saves_reopen_with_server_revisions_and_immutable_ancestry() {
    let mut connection = database();
    let original = template("greeting", " Greeting ");
    let first = save(&mut connection, &original, None).unwrap();
    assert_eq!(first["id"], original["id"]);
    assert_eq!(first["name"], "Greeting");
    assert_ne!(first["revisionId"], original["revisionId"]);
    assert_eq!(first["parentRevisionId"], Value::Null);
    assert_ne!(first["createdAt"], original["createdAt"]);

    let mut changed = first.clone();
    changed["source"] = Value::String("Goodbye {{name}}.".into());
    changed["createdAt"] = Value::String("2000-01-01T00:00:00.000Z".into());
    let second = save(&mut connection, &changed, first["revisionId"].as_str()).unwrap();
    assert_ne!(second["revisionId"], first["revisionId"]);
    assert_eq!(second["parentRevisionId"], first["revisionId"]);
    assert_eq!(second["createdAt"], first["createdAt"]);
    assert_eq!(history_count(&connection), 2);

    let reopened =
        execute_template_on(&mut connection, "listTemplates", &serde_json::json!({})).unwrap();
    assert_eq!(reopened, serde_json::json!([second]));
    let (snapshot, content_hash): (String, String) = connection
        .query_row(
            "SELECT document, content_hash FROM template_revisions WHERE id=?1",
            [first["revisionId"].as_str().unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(content_hash, digest(snapshot.as_bytes()));
    assert_eq!(parse_json(snapshot).unwrap(), first);
}

#[test]
fn template_compare_and_swap_rejects_stale_saves_and_deletes() {
    let mut connection = database();
    let first = save(&mut connection, &template("greeting", "Greeting"), None).unwrap();
    let second = save(&mut connection, &first, first["revisionId"].as_str()).unwrap();
    assert!(save(&mut connection, &first, first["revisionId"].as_str())
        .unwrap_err()
        .contains("Reopen"));
    assert!(save(&mut connection, &first, None).is_err());
    assert!(execute_template_on(
        &mut connection,
        "deleteTemplate",
        &serde_json::json!({
            "id": "greeting", "expectedRevisionId": first["revisionId"]
        })
    )
    .is_err());
    assert_eq!(history_count(&connection), 2);
    assert_eq!(
        execute_template_on(&mut connection, "listTemplates", &serde_json::json!({})).unwrap(),
        serde_json::json!([second])
    );
}

#[test]
fn template_deletion_retains_history_and_rejects_identifier_reuse() {
    let mut connection = database();
    let saved = save(&mut connection, &template("greeting", "Greeting"), None).unwrap();
    let input = serde_json::json!({"id": "greeting", "expectedRevisionId": saved["revisionId"]});
    assert_eq!(
        execute_template_on(&mut connection, "deleteTemplate", &input).unwrap(),
        Value::Null
    );
    assert!(execute_template_on(&mut connection, "deleteTemplate", &input).is_err());
    assert!(save(&mut connection, &saved, saved["revisionId"].as_str()).is_err());
    assert!(save(&mut connection, &template("greeting", "Replacement"), None).is_err());
    assert_eq!(history_count(&connection), 1);
    assert_eq!(
        execute_template_on(&mut connection, "listTemplates", &serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );
}

#[test]
fn template_revision_history_rejects_direct_mutation() {
    let mut connection = database();
    save(&mut connection, &template("greeting", "Greeting"), None).unwrap();
    assert!(connection
        .execute("UPDATE template_revisions SET document='{}'", [])
        .is_err());
    assert!(connection
        .execute("DELETE FROM template_revisions", [])
        .is_err());
    assert_eq!(history_count(&connection), 1);
}

#[test]
fn template_failed_history_write_rolls_back_the_current_document() {
    let mut connection = database();
    let first = save(&mut connection, &template("greeting", "Greeting"), None).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_template_history BEFORE INSERT ON template_revisions
         WHEN NEW.parent_id IS NOT NULL
         BEGIN SELECT RAISE(ABORT, 'history unavailable'); END;",
        )
        .unwrap();
    let mut changed = first.clone();
    changed["source"] = Value::String("Changed source".into());
    assert!(
        save(&mut connection, &changed, first["revisionId"].as_str())
            .unwrap_err()
            .contains("history unavailable")
    );
    assert_eq!(history_count(&connection), 1);
    assert_eq!(
        execute_template_on(&mut connection, "listTemplates", &serde_json::json!({})).unwrap(),
        serde_json::json!([first])
    );
    connection
        .execute_batch("DROP TRIGGER reject_template_history")
        .unwrap();
    assert!(save(&mut connection, &changed, first["revisionId"].as_str()).is_ok());
    assert_eq!(history_count(&connection), 2);
}

#[test]
fn template_search_treats_wildcards_literally_and_matches_unicode_case() {
    let mut connection = database();
    let expected = save(&mut connection, &template("promo", "Promo %_Ä"), None).unwrap();
    save(&mut connection, &template("other", "Other"), None).unwrap();
    let result = execute_template_on(
        &mut connection,
        "listTemplates",
        &serde_json::json!({"search": "  %_ä  "}),
    )
    .unwrap();
    assert_eq!(result, serde_json::json!([expected]));
    assert!(execute_template_on(
        &mut connection,
        "listTemplates",
        &serde_json::json!({"search": null})
    )
    .is_err());
    assert!(execute_template_on(
        &mut connection,
        "listTemplates",
        &serde_json::json!({"unexpected": true})
    )
    .is_err());
}

#[test]
fn template_validation_rejects_invalid_fields_cast_timestamps_and_export() {
    let mut connection = database();
    let original = template("greeting", "Greeting");
    let invalid = [
        ("name", serde_json::json!(" ")),
        ("id", serde_json::json!("../outside")),
        ("source", serde_json::json!(false)),
        (
            "cast",
            serde_json::json!([original["cast"][0], original["cast"][0]]),
        ),
        ("cast", serde_json::json!([{"id": "speaker"}])),
        ("profileId", serde_json::json!(true)),
        ("revisionId", Value::Null),
        ("createdAt", serde_json::json!("invalid")),
        ("updatedAt", serde_json::json!("2025-01-01T00:00:00Z")),
        ("exportSettings", serde_json::json!({"format": "invalid"})),
        ("unexpected", serde_json::json!(true)),
    ];
    for (key, value) in invalid {
        let mut candidate = original.clone();
        candidate[key] = value;
        assert!(save(&mut connection, &candidate, None).is_err(), "{key}");
    }
    assert!(save(&mut connection, &original, None).is_ok());
    assert_eq!(history_count(&connection), 1);
}

#[test]
fn template_validation_requires_existing_profiles_and_reference_assets() {
    let mut connection = database();
    let mut candidate = template("greeting", "Greeting");
    candidate["profileId"] = serde_json::json!("profile-a");
    assert!(save(&mut connection, &candidate, None).is_err());
    connection
        .execute("INSERT INTO profiles(id) VALUES ('profile-a')", [])
        .unwrap();
    let asset_id = "a".repeat(64);
    candidate["cast"][0]
        .as_object_mut()
        .unwrap()
        .remove("voiceId");
    candidate["cast"][0]["referenceAssetIds"] = serde_json::json!([asset_id]);
    candidate["cast"][0]["rightsEvidence"] = serde_json::json!("Recorded with permission");
    assert!(save(&mut connection, &candidate, None).is_err());
    connection
        .execute("INSERT INTO assets(id) VALUES (?1)", [&asset_id])
        .unwrap();
    let saved = save(&mut connection, &candidate, None).unwrap();
    assert_eq!(saved["profileId"], "profile-a");
    assert_eq!(
        saved["cast"][0]["referenceAssetIds"],
        serde_json::json!([asset_id])
    );
}

#[test]
fn template_payload_revision_must_match_the_expected_revision() {
    let mut connection = database();
    let saved = save(&mut connection, &template("greeting", "Greeting"), None).unwrap();
    let mut changed = saved.clone();
    changed["revisionId"] = serde_json::json!("unrelated-revision");
    assert!(save(&mut connection, &changed, saved["revisionId"].as_str()).is_err());
    assert_eq!(history_count(&connection), 1);
}
