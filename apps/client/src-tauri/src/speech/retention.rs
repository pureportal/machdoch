use super::*;

const RETENTION_RANGE_ERROR:&str="This cache retention period exceeds the storage date range. Enter fewer days.";

pub(super) const ASSET_ROOTS:&str="
    EXISTS(SELECT 1 FROM takes t WHERE t.asset_id=a.id AND (t.project_id IS NOT NULL OR json_extract(t.data,'$.favorite')=1 OR julianday(t.created_at)>=julianday(?1)))
    OR EXISTS(SELECT 1 FROM revision_assets r WHERE r.asset_id=a.id)
    OR EXISTS(SELECT 1 FROM template_revision_assets r WHERE r.asset_id=a.id)
    OR EXISTS(SELECT 1 FROM speech_references r WHERE r.asset_id=a.id)
    OR EXISTS(SELECT 1 FROM speech_reference_originals r WHERE r.asset_id=a.id OR r.original_asset_id=a.id)
    OR EXISTS(SELECT 1 FROM speech_design_candidates d WHERE d.asset_id=a.id)
    OR EXISTS(SELECT 1 FROM speech_request_assets r JOIN jobs j ON j.id=r.job_id WHERE r.asset_id=a.id AND j.state IN ('queued','running'))
    OR EXISTS(SELECT 1 FROM job_takes jt JOIN jobs j ON j.id=jt.job_id JOIN takes t ON t.id=jt.take_id WHERE t.asset_id=a.id AND j.state IN ('queued','running'))
    OR EXISTS(SELECT 1 FROM speech_playback_assets p WHERE p.asset_id=a.id)
    OR EXISTS(SELECT 1 FROM speech_reserved_assets r WHERE r.asset_id=a.id)
    OR EXISTS(SELECT 1 FROM speech_playback_jobs p JOIN job_takes t ON t.job_id=p.job_id JOIN takes v ON v.id=t.take_id WHERE v.asset_id=a.id)";

pub fn schema(connection:&Connection)->Result<(),String>{
    connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_request_assets(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(job_id,asset_id));
        CREATE INDEX IF NOT EXISTS speech_request_asset_lookup ON speech_request_assets(asset_id,job_id);
        CREATE INDEX IF NOT EXISTS speech_jobs_state ON jobs(state,id);").map_err(error)?;
    let index = |filter:&str| {
        let requests=format!("SELECT r.job_id,r.snapshot FROM speech_requests r JOIN jobs j ON j.id=r.job_id WHERE j.state IN ('queued','running') {filter}");
        format!("INSERT OR IGNORE INTO speech_request_assets(job_id,asset_id)
            SELECT bindings.job_id,a.id FROM (
                SELECT r.job_id,CASE WHEN json_type(r.snapshot,'$.references')='object' THEN refs.key ELSE json_extract(refs.value,'$.asset.id') END AS asset_id
                FROM ({requests}) r JOIN json_each(r.snapshot,'$.references') refs
                UNION ALL SELECT r.job_id,t.asset_id FROM ({requests}) r JOIN json_each(r.snapshot,'$.cachedTakes') cache JOIN takes t ON t.id=cache.value
                UNION ALL SELECT r.job_id,json_extract(r.snapshot,'$.take.asset.id') FROM ({requests}) r
            ) bindings JOIN assets a ON a.id=bindings.asset_id;")
    };
    connection.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS speech_index_request_assets AFTER INSERT ON speech_requests BEGIN {} END;",index("AND r.job_id=NEW.job_id"))).map_err(error)?;
    connection.execute_batch(&index("" )).map_err(error)
}

impl SpeechStore {
    pub fn cache_retention_cutoff(&self, days: u64, now: DateTime<Utc>) -> Result<String,String> {
        let interval=days.checked_mul(86400).and_then(|value|i64::try_from(value).ok()).and_then(chrono::Duration::try_seconds).ok_or(RETENTION_RANGE_ERROR)?;
        let cutoff=now.checked_sub_signed(interval).ok_or(RETENTION_RANGE_ERROR)?;
        if !(0..=9999).contains(&chrono::Datelike::year(&cutoff)) { return Err(RETENTION_RANGE_ERROR.into()); }
        let cutoff=cutoff.to_rfc3339_opts(SecondsFormat::Millis,true);
        let supported:bool=self.connection.query_row("SELECT julianday(?1) IS NOT NULL",[&cutoff],|row|row.get(0)).map_err(error)?;
        if !supported { return Err(RETENTION_RANGE_ERROR.into()); }
        Ok(cutoff)
    }

    pub fn clean_cache(&mut self, days: u64, now: DateTime<Utc>) -> Result<Value, String> {
        let cutoff = self.cache_retention_cutoff(days,now)?;
        let cutoff_time=parse_time(&cutoff)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        transaction.execute("DELETE FROM speech_playback_leases WHERE julianday(expires_at)<=julianday(?1)",[now.to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;
        transaction.execute("DELETE FROM speech_asset_reservations WHERE julianday(expires_at)<=julianday(?1)",[now.to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;
        timing_store::clean_workspaces(&transaction,&self.root,None)?;
        let ids = {
            let mut statement = transaction.prepare(&format!(
                "SELECT a.id,a.bytes FROM assets a
                 WHERE NOT EXISTS(SELECT 1 FROM speech_cache_evictions e WHERE e.asset_id=a.id)
                 AND NOT EXISTS(SELECT 1 FROM speech_asset_access x WHERE x.asset_id=a.id AND julianday(x.accessed_at)>=julianday(?1))
                 AND NOT ({ASSET_ROOTS}) ORDER BY a.id LIMIT 256"
            )).map_err(error)?;
            let values = statement.query_map([&cutoff], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(error)?;
            values.collect::<Result<Vec<_>, _>>().map_err(error)?
        };
        let scanned=ids.len();
        let mut assets = 0u64;
        let mut bytes = 0u64;
        for (id, size) in ids {
            asset_identifier(&json!(id))?;
            let path = self.root.join("blobs").join(&id[..2]).join(&id);
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
                    transaction.execute("INSERT INTO speech_cache_evictions(asset_id,evicted_at,removed) VALUES(?1,?2,1)",params![id,now.to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;
                    transaction.execute("DELETE FROM speech_mixes WHERE asset_id=?1",[&id]).map_err(error)?;
                    assets+=1;
                    continue;
                },
                Err(cause) => return Err(error(cause)),
            };
            let modified = DateTime::<Utc>::from(metadata.modified().map_err(error)?);
            if modified >= cutoff_time {
                transaction.execute("INSERT INTO speech_asset_access VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET accessed_at=excluded.accessed_at",params![id,modified.to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;
                continue;
            }
            if !metadata.is_file() || metadata.file_type().is_symlink() || !path.canonicalize().map_err(error)?.starts_with(&self.root) {
                return Err("A speech cache path leaves its storage directory. Repair the storage before cleaning it.".into());
            }
            transaction.execute("INSERT INTO speech_cache_evictions(asset_id,evicted_at) VALUES(?1,?2)", params![id,now.to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;
            transaction.execute("DELETE FROM speech_mixes WHERE asset_id=?1",[&id]).map_err(error)?;
            assets += 1;
            bytes = bytes.checked_add(u64::try_from(size).map_err(|_|"The cached audio size is invalid.")?).ok_or("The cache size overflowed.")?;
        }
        transaction.commit().map_err(error)?;
        self.finish_cache_evictions()?;
        let (orphan_assets,orphan_bytes,orphan_pending)=self.clean_orphan_files(&cutoff,days,now)?;
        Ok(json!({"assets":assets.checked_add(orphan_assets).ok_or("The removed asset count overflowed.")?,"bytes":bytes.checked_add(orphan_bytes).ok_or("The removed cache size overflowed.")?,"pending":scanned==256||orphan_pending}))
    }

    fn finish_cache_evictions(&mut self) -> Result<(), String> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let ids = {
            let mut statement = transaction.prepare("SELECT asset_id FROM speech_cache_evictions e WHERE removed=0 AND NOT EXISTS(SELECT 1 FROM speech_reserved_assets a JOIN speech_asset_reservations w ON w.id=a.reservation_id WHERE a.asset_id=e.asset_id AND julianday(w.expires_at)>julianday('now')) LIMIT 256").map_err(error)?;
            let values = statement.query_map([], |row| row.get::<_,String>(0)).map_err(error)?;
            values.collect::<Result<Vec<_>,_>>().map_err(error)?
        };
        for id in ids {
            asset_identifier(&json!(id))?;
            let path = self.root.join("blobs").join(&id[..2]).join(&id);
            match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if !metadata.is_file() || metadata.file_type().is_symlink() || !path.canonicalize().map_err(error)?.starts_with(&self.root) {
                        return Err("A speech cache path leaves its storage directory. Repair the storage before cleaning it.".into());
                    }
                    fs::remove_file(path).map_err(|_|"Temporary speech audio could not be removed. Close its player and clean the cache again.")?;
                }
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                Err(cause) => return Err(error(cause)),
            }
            transaction.execute("UPDATE speech_cache_evictions SET removed=1 WHERE asset_id=?1", [&id]).map_err(error)?;
        }
        transaction.commit().map_err(error)
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
