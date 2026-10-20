use super::*;

impl SpeechStore {
    pub(super) fn resolve_project_takes(&self, input: &Value) -> Result<Value, String> {
        fields(input, &["projectId", "ids"])?;
        let project_id = identifier(input, "projectId")?;
        let exists: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND deleted=0)", [project_id], |row| row.get(0)).map_err(error)?;
        if !exists { return Err("The speech project is unavailable.".into()); }
        self.production_takes(project_id, required(input, "ids")?, 100)
    }

    pub(crate) fn production_takes(&self, project_id: &str, ids: &Value, maximum: usize) -> Result<Value, String> {
        let values = ids.as_array().filter(|values| values.len() <= maximum).ok_or_else(|| format!("Choose at most {maximum} production takes."))?;
        let mut unique = HashSet::new();
        for value in values {
            let id = identifier(&json!({"id":value}), "id")?.to_string();
            if !unique.insert(id) { return Err("Choose distinct production takes.".into()); }
        }
        let transaction = self.connection.unchecked_transaction().map_err(error)?;
        let (count, bytes): (i64, i64) = transaction.query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM takes WHERE project_id=?1 AND id IN(SELECT value FROM json_each(?2))", params![project_id, ids.to_string()], |row| Ok((row.get(0)?, row.get(1)?))).map_err(error)?;
        if count as usize != values.len() { return Err("A production take is unavailable or belongs to another project. Select it again.".into()); }
        if bytes > 64 * 1024 * 1024 { return Err("The selected production metadata exceeds 64 MiB. Produce a smaller chapter or scene.".into()); }
        let mut statement = transaction.prepare("SELECT takes.data FROM json_each(?2) requested JOIN takes ON takes.id=requested.value WHERE takes.project_id=?1 ORDER BY CAST(requested.key AS INTEGER)").map_err(error)?;
        let rows = statement.query_map(params![project_id, ids.to_string()], |row| row.get(0)).map_err(error)?;
        collect_json(rows)
    }
}
