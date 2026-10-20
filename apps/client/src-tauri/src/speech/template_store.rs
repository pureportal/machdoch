use super::*;

impl SpeechStore {
    pub(super) fn execute_template(
        &mut self,
        operation: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let mut request=input.clone();
        if operation=="saveTemplate"{bounded_record(&request["template"])?;self.pin_cast_voice_observations(&mut request["template"])?;}
        execute_template_on(&mut self.connection, operation, &request)
    }
}

fn execute_template_on(
    connection: &mut Connection,
    operation: &str,
    input: &Value,
) -> Result<Value, String> {
    match operation {
        "listTemplates" => {
            fields(input, &["search"])?;
            optional_text(input, "search", 256)?;
        }
        "saveTemplate" => {
            fields(input, &["template", "expectedRevisionId"])?;
            nullable_identifier(input, "expectedRevisionId")?;
            validate_template(required(input, "template")?)?;
        }
        "deleteTemplate" => {
            fields(input, &["id", "expectedRevisionId"])?;
            identifier(input, "id")?;
            identifier(input, "expectedRevisionId")?;
        }
        _ => return Err(format!("Unknown template operation: {operation}")),
    }

    init_schema(connection)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(error)?;
    let result = match operation {
        "listTemplates" => {
            let search = optional_text(input, "search", 256)?
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let mut statement = transaction.prepare("SELECT document FROM templates WHERE deleted=0 ORDER BY name COLLATE NOCASE, id").map_err(error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(error)?;
            let mut templates = Vec::new();
            for row in rows {
                let template = parse_json(row.map_err(error)?)?;
                if text(&template, "name", 1, 256)?
                    .to_lowercase()
                    .contains(&search)
                {
                    templates.push(template);
                }
            }
            Value::Array(templates)
        }
        "saveTemplate" => save_template(&transaction, input)?,
        "deleteTemplate" => {
            let changed = transaction
                .execute(
                    "UPDATE templates SET deleted=1 WHERE id=?1 AND revision_id=?2 AND deleted=0",
                    params![
                        identifier(input, "id")?,
                        identifier(input, "expectedRevisionId")?
                    ],
                )
                .map_err(error)?;
            if changed != 1 {
                return Err("Template changed or was deleted. Reopen it before deleting.".into());
            }
            Value::Null
        }
        _ => unreachable!(),
    };
    transaction.commit().map_err(error)?;
    Ok(result)
}

pub(super) fn init_schema(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            revision_id TEXT NOT NULL UNIQUE,
            document TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
        );
        CREATE TABLE IF NOT EXISTS template_revisions (
            id TEXT PRIMARY KEY,
            template_id TEXT NOT NULL REFERENCES templates(id),
            parent_id TEXT REFERENCES template_revisions(id),
            created_at TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            document TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS template_revision_assets(revision_id TEXT NOT NULL REFERENCES template_revisions(id),asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(revision_id,asset_id));
        CREATE INDEX IF NOT EXISTS template_revision_history ON template_revisions(template_id, created_at);
        CREATE TRIGGER IF NOT EXISTS template_revisions_no_update
        BEFORE UPDATE ON template_revisions BEGIN SELECT RAISE(ABORT, 'Template revisions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS template_revisions_no_delete
        BEFORE DELETE ON template_revisions BEGIN SELECT RAISE(ABORT, 'Template revisions are immutable'); END;"
    ).map_err(error)?;

    Ok(())
}

fn validate_template(template: &Value) -> Result<(), String> {
    fields(
        template,
        &[
            "id",
            "name",
            "source",
            "cast",
            "profileId",
            "exportSettings",
            "revisionId",
            "parentRevisionId",
            "createdAt",
            "updatedAt",
        ],
    )?;
    bounded_record(template)?;
    identifier(template, "id")?;
    let name = text(template, "name", 1, 256)?;
    if name.trim().is_empty() {
        return Err("Enter a template name".into());
    }
    text(template, "source", 0, 2_000_000)?;
    array(template, "cast", 256)?;
    nullable_identifier(template, "profileId")?;
    identifier(template, "revisionId")?;
    nullable_identifier(template, "parentRevisionId")?;
    let created_at = parse_time(text(template, "createdAt", 1, 64)?)?;
    let updated_at = parse_time(text(template, "updatedAt", 1, 64)?)?;
    if updated_at < created_at {
        return Err("Template update time cannot precede its creation time".into());
    }
    validate_export_preset(required(template, "exportSettings")?)?;
    let project = serde_json::json!({
        "id": template["id"],
        "title": template["name"],
        "source": template["source"],
        "cast": template["cast"],
        "profileId": template["profileId"],
        "revisionId": template["revisionId"],
        "parentRevisionId": template["parentRevisionId"],
        "createdAt": template["createdAt"],
        "updatedAt": template["updatedAt"],
        "archived": false,
        "location": null,
        "timeline": [],
        "selectedTakes": {},
        "bookmarks": [],
        "variants": [],
    });
    validate_project(&project)
}

fn save_template(connection: &Connection, input: &Value) -> Result<Value, String> {
    let template = required(input, "template")?;
    let id = identifier(template, "id")?;
    let expected = nullable_identifier(input, "expectedRevisionId")?;
    let previous: Option<(String, String, bool)> = connection
        .query_row(
            "SELECT revision_id, document, deleted FROM templates WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(error)?;
    match &previous {
        Some((revision, _, false)) if Some(revision.as_str()) == expected => {
            if identifier(template, "revisionId")? != revision {
                return Err("Template revision does not match the expected revision. Reopen it before saving.".into());
            }
        }
        None if expected.is_none() => {}
        _ => return Err("Template changed or was deleted. Reopen it before saving.".into()),
    }

    if let Some(profile_id) = nullable_identifier(template, "profileId")? {
        exists(connection, "SELECT 1 FROM profiles WHERE id=?1", profile_id)?;
    }
    for asset_id in project_reference_ids(template)?{exists(connection,"SELECT 1 FROM assets WHERE id=?1",&asset_id)?;}

    let now = timestamp();
    let revision_id = uuid()?;
    let mut saved = template.clone();
    saved["name"] = Value::String(text(template, "name", 1, 256)?.trim().to_owned());
    saved["revisionId"] = Value::String(revision_id.clone());
    saved["parentRevisionId"] = expected
        .map(|value| Value::String(value.to_owned()))
        .unwrap_or(Value::Null);
    saved["createdAt"] = match previous {
        Some((_, document, _)) => required(&parse_json(document)?, "createdAt")?.clone(),
        None => Value::String(now.clone()),
    };
    saved["updatedAt"] = Value::String(now.clone());
    let document = encode(&saved)?;

    let changed =
        if let Some(expected_revision) = expected {
            connection
                .execute(
                    "UPDATE templates SET name=?1, revision_id=?2, document=?3
             WHERE id=?4 AND revision_id=?5 AND deleted=0",
                    params![
                        saved["name"].as_str(),
                        revision_id,
                        document,
                        id,
                        expected_revision
                    ],
                )
                .map_err(error)?
        } else {
            connection.execute(
            "INSERT INTO templates(id, name, revision_id, document) VALUES (?1, ?2, ?3, ?4)",
            params![id, saved["name"].as_str(), revision_id, document],
        ).map_err(error)?
        };
    if changed != 1 {
        return Err("Template changed or was deleted. Reopen it before saving.".into());
    }
    connection.execute(
        "INSERT INTO template_revisions(id, template_id, parent_id, created_at, content_hash, document)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![revision_id, id, expected, now, digest(document.as_bytes()), document],
    ).map_err(error)?;
    for id in project_reference_ids(&saved)? {
        connection
            .execute(
                "INSERT INTO template_revision_assets(revision_id,asset_id) VALUES(?1,?2)",
                params![revision_id, id],
            )
            .map_err(error)?;
    }
    Ok(saved)
}

#[cfg(test)]
#[path = "template_store_tests.rs"]
mod tests;
