use super::*;

pub fn schema(connection:&Connection)->Result<(),String>{
    connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_playback_leases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS speech_playback_lease_owner ON speech_playback_leases(owner);
        CREATE TABLE IF NOT EXISTS speech_playback_assets(lease_id TEXT NOT NULL REFERENCES speech_playback_leases(id) ON DELETE CASCADE,asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(lease_id,asset_id));
        CREATE INDEX IF NOT EXISTS speech_playback_asset ON speech_playback_assets(asset_id);
        CREATE TABLE IF NOT EXISTS speech_playback_jobs(lease_id TEXT NOT NULL REFERENCES speech_playback_leases(id) ON DELETE CASCADE,job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,PRIMARY KEY(lease_id,job_id));
        CREATE INDEX IF NOT EXISTS speech_playback_job ON speech_playback_jobs(job_id);").map_err(error)
}

fn ids(input:&Value,key:&str)->Result<Vec<String>,String>{
    let values=required(input,key)?.as_array().filter(|values|values.len()<=MAX_ITEMS).ok_or("Protect at most 10,000 playback resources at once.")?;
    let mut unique=HashSet::new();
    for value in values{
        let id=identifier(&json!({"id":value}),"id")?.to_owned();
        if !unique.insert(id){return Err("Remove duplicate playback resources.".into());}
    }
    Ok(unique.into_iter().collect())
}

pub fn execute(store:&mut SpeechStore,operation:&str,input:&Value,now:DateTime<Utc>)->Result<Value,String>{
    fields(input,if operation=="retainPlayback"{&["id","owner","assetIds","jobIds"]}else{&["id","owner"]})?;
    let id=identifier(input,"id")?;let owner=text(input,"owner",1,512)?;
    let transaction=store.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
    let existing:Option<String>=transaction.query_row("SELECT owner FROM speech_playback_leases WHERE id=?1",[id],|row|row.get(0)).optional().map_err(error)?;
    if existing.as_deref().is_some_and(|actual|actual!=owner){return Err("This playback lease belongs to another speech owner.".into());}
    if operation=="releasePlayback"{
        transaction.execute("DELETE FROM speech_playback_leases WHERE id=?1 AND owner=?2",params![id,owner]).map_err(error)?;
        transaction.commit().map_err(error)?;return Ok(Value::Null);
    }
    transaction.execute("DELETE FROM speech_playback_leases WHERE id<>?1 AND julianday(expires_at)<=julianday(?2)",params![id,now.to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;
    let assets=ids(input,"assetIds")?;let jobs=ids(input,"jobIds")?;
    if existing.is_none(){
        if assets.is_empty()&&jobs.is_empty(){return Err("Playback protection expired. Open the cached audio again.".into());}
        let (total,owned):(i64,i64)=transaction.query_row("SELECT count(*),coalesce(sum(owner=?1),0) FROM speech_playback_leases",[owner],|row|Ok((row.get(0)?,row.get(1)?))).map_err(error)?;
        if total>=512||owned>=64{return Err("Close an unused speech player before opening more audio.".into());}
    }
    let expires=(now+chrono::Duration::minutes(10)).to_rfc3339_opts(SecondsFormat::Millis,true);
    transaction.execute("INSERT INTO speech_playback_leases(id,owner,expires_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",params![id,owner,expires]).map_err(error)?;
    for asset in &assets{
        asset_identifier(&json!(asset))?;
        let available:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM assets a WHERE a.id=?1 AND NOT EXISTS(SELECT 1 FROM speech_cache_evictions e WHERE e.asset_id=a.id))",[asset],|row|row.get(0)).map_err(error)?;
        let path=store.root.join("blobs").join(&asset[..2]).join(asset);
        if !available||!path.is_file(){return Err("The cached playback audio is unavailable. Open its saved take or generate another take deliberately.".into());}
        transaction.execute("INSERT INTO speech_playback_assets VALUES(?1,?2) ON CONFLICT DO NOTHING",params![id,asset]).map_err(error)?;
    }
    for job in &jobs{
        let owned:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND owner=?2)",params![job,owner],|row|row.get(0)).map_err(error)?;
        if !owned{return Err("Protect only speech jobs owned by this playback session.".into());}
        transaction.execute("INSERT INTO speech_playback_jobs VALUES(?1,?2) ON CONFLICT DO NOTHING",params![id,job]).map_err(error)?;
    }
    let resources:i64=transaction.query_row("SELECT (SELECT count(*) FROM speech_playback_assets WHERE lease_id=?1)+(SELECT count(*) FROM speech_playback_jobs WHERE lease_id=?1)",[id],|row|row.get(0)).map_err(error)?;
    if resources>MAX_ITEMS as i64{return Err("Protect at most 10,000 playback resources at once.".into());}
    transaction.commit().map_err(error)?;Ok(json!({"id":id,"expiresAt":expires}))
}
