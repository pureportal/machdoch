use super::*;

pub fn schema(connection:&Connection)->Result<(),String>{
    connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_timing_chunks(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(job_id,ordinal));
        CREATE TABLE IF NOT EXISTS speech_timings(id TEXT PRIMARY KEY,take_id TEXT NOT NULL REFERENCES takes(id),request_hash TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX IF NOT EXISTS speech_timing_take ON speech_timings(take_id,request_hash,created_at);
        CREATE TABLE IF NOT EXISTS revision_timings(revision_id TEXT NOT NULL REFERENCES revisions(id),timing_id TEXT NOT NULL REFERENCES speech_timings(id),PRIMARY KEY(revision_id,timing_id));
        CREATE TRIGGER IF NOT EXISTS immutable_speech_timing BEFORE UPDATE ON speech_timings BEGIN SELECT RAISE(ABORT,'Transcript timing provenance is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_speech_timing_chunk BEFORE UPDATE ON speech_timing_chunks BEGIN SELECT RAISE(ABORT,'Completed transcription chunks are immutable'); END;").map_err(error)
}

pub fn selection_ids(project:&Value)->Result<Vec<(&str,&str)>,String>{
    let Some(selections)=project.get("timingSelections")else{return Ok(Vec::new())};
    let selections=selections.as_object().filter(|selections|selections.len()<=MAX_ITEMS).ok_or("Select at most 10,000 take timing results.")?;
    let mut result=Vec::new();
    for (take,id) in selections{validate_id(take)?;result.push((take.as_str(),value_identifier(id)?));}
    Ok(result)
}

pub fn validate_record(record:&Value,take:&Value)->Result<(),String>{
    bounded_record(record)?;
    fields(record,&["id","takeId","assetId","assetSha256","provider","model","languageHint","transcript","words","createdAt","measuredAt","jobId","requestHash","provenance","pricing","estimatedCost","reusedFromTimingId"])?;
    for field in ["id","takeId","jobId"]{identifier(record,field)?;}
    nullable_identifier(record,"reusedFromTimingId")?;
    if record["takeId"]!=take["id"]||record["assetId"]!=take["asset"]["id"]||record["assetSha256"]!=take["asset"]["sha256"]{return Err("The timing evidence belongs to different audio.".into());}
    if record["provider"]!="openai"||record["model"]!=super::super::transcript_timing::MODEL{return Err("Use the verified timestamp-capable transcription model.".into());}
    let language=super::super::transcript_timing::validate_language(&record["languageHint"])?;
    let created=parse_time(text(record,"createdAt",1,128)?)?;
    let measured=parse_time(text(record,"measuredAt",1,128)?)?;
    if measured>created{return Err("Timing measurement cannot follow its saved record.".into());}
    text(record,"transcript",0,4*1024*1024)?;
    let provenance=&record["provenance"];
    fields(provenance,&["encoderSha256","sourceDuration","admittedAt","sampleRate","channels","pipeline","chunks"])?;
    let encoder=asset_identifier(required(provenance,"encoderSha256")?)?;
    let admitted=parse_time(text(provenance,"admittedAt",1,128)?)?;
    if admitted>measured{return Err("Timing measurement cannot precede its admitted request.".into());}
    if record["requestHash"]!=super::super::transcript_timing::request_hash(asset_identifier(&record["assetSha256"])? ,language,encoder){return Err("The timing request identity differs from its audio and preprocessing snapshot.".into());}
    let duration=number(&take["asset"],"duration",0.0,f64::MAX)?;
    if provenance["sourceDuration"]!=take["asset"]["duration"]||provenance["sampleRate"]!=16000||provenance["channels"]!=1||provenance["pipeline"]!=1{return Err("The timing preprocessing contract differs from the source take.".into());}
    let windows=super::super::transcript_timing::chunks(duration)?;
    let chunks=array(provenance,"chunks",MAX_ITEMS)?;
    if chunks.len()!=windows.len(){return Err("The timing evidence is missing an audio chunk.".into());}
    for (chunk,window) in chunks.iter().zip(&windows){
        fields(chunk,&["window","audioSha256","responseSha256","uploadDuration","providerText","language","usage"])?;
        text(chunk,"providerText",0,2*1024*1024)?;
        if chunk["window"]!=*window{return Err("The timing evidence has a different chunk window.".into());}
        asset_identifier(required(chunk,"audioSha256")?)?;asset_identifier(required(chunk,"responseSha256")?)?;
        let actual=number(chunk,"uploadDuration",0.0,602.0)?;
        let expected=window["to"].as_f64().ok_or("Invalid timing window")?-window["from"].as_f64().ok_or("Invalid timing window")?;
        if (actual-expected).abs()>1.0/16000.0{return Err("A transcription upload differs from its measured source window.".into());}
        nullable_text(chunk,"language",128)?;
        if !chunk["usage"].is_null(){fields(&chunk["usage"],&["type","seconds"])?;if chunk["usage"]["type"]!="duration"{return Err("Unknown transcription usage unit.".into());}number(&chunk["usage"],"seconds",0.0,f64::MAX)?;}
    }
    let combined=super::super::transcript_timing::combine(&[json!({"words":array(record,"words",100_000)?})],duration)?;
    if combined["transcript"]!=record["transcript"]{return Err("The timed transcript differs from its measured words.".into());}
    let estimate=super::super::transcript_timing::estimate(&record["pricing"],&windows,admitted.date_naive())?;
    match estimate{None if !record["estimatedCost"].is_null()=>return Err("The timing estimate has no verified rate.".into()),Some(expected) if record["estimatedCost"].as_f64().is_none_or(|actual|!actual.is_finite()||(actual-expected).abs()>1e-12*expected.max(1.0))=>return Err("The timing estimate differs from its pinned quote and upload windows.".into()),_=>{}}
    Ok(())
}

impl SpeechStore{
    pub fn timing(&self,id:&str)->Result<Value,String>{
        let data:String=self.connection.query_row("SELECT data FROM speech_timings WHERE id=?1",[id],|row|row.get(0)).optional().map_err(error)?.ok_or("This transcript timing result is unavailable.")?;
        let record=parse_json(data)?;validate_record(&record,&self.timing_take(identifier(&record,"takeId")?)?)?;Ok(record)
    }

    pub fn timing_take(&self,id:&str)->Result<Value,String>{
        let data:String=self.connection.query_row("SELECT data FROM takes WHERE id=?1",[id],|row|row.get(0)).optional().map_err(error)?.ok_or("Choose an existing audio take for transcription.")?;
        parse_json(data)
    }

    pub fn timing_asset_path(&self,take:&Value)->Result<PathBuf,String>{
        let id=asset_identifier(&take["asset"]["id"])?;
        let path=self.root.join("blobs").join(&id[..2]).join(id).canonicalize().map_err(|_|"The transcription source audio is unavailable.")?;
        let blobs=self.root.join("blobs").canonicalize().map_err(error)?;
        if !blobs.starts_with(&self.root)||!path.starts_with(blobs)||!path.is_file(){return Err("The transcription audio is outside its asset store.".into());}
        Ok(path)
    }

    pub fn timing_candidate(&self,take:&Value,hash:&str)->Result<Option<String>,String>{
        self.connection.query_row("SELECT id FROM speech_timings WHERE take_id=?1 AND request_hash=?2 ORDER BY created_at DESC,id DESC LIMIT 1",params![identifier(take,"id")?,hash],|row|row.get(0)).optional().map_err(error)
    }

    pub fn project_timings(&self,project:&Value)->Result<Value,String>{
        let mut records=Vec::new();
        for (take_id,id) in selection_ids(project)?{
            let take=self.timing_take(take_id)?;
            if take["projectId"]!=project["id"]{return Err("Choose timing for a take owned by this project.".into());}
            let record=self.timing(id)?;validate_record(&record,&take)?;records.push(record);
        }
        Ok(json!(records))
    }

    pub fn apply_project_timing(&self,project:&Value,takes:&mut Value)->Result<Value,String>{
        let records=self.project_timings(project)?;
        for record in records.as_array().ok_or("The project timing list is invalid.")?{
            let take=takes.as_array_mut().and_then(|takes|takes.iter_mut().find(|take|take["id"]==record["takeId"])).ok_or("A selected timing take is unavailable.")?;
            take["alignment"]=record["words"].clone();
        }
        Ok(records)
    }

    pub fn put_timing(&mut self,record:&Value,job:&Value)->Result<(),String>{
        if job["kind"]!="alignment"||job["timingId"]!=record["id"]||job["id"]!=record["jobId"]||job["completedSegments"]!=job["totalSegments"]{return Err("Commit timing evidence only for its completed transcription job.".into());}
        if job["takeIds"]!=json!([record["takeId"]]){return Err("The timing result belongs to a different transcription take.".into());}
        let snapshot:String=self.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[identifier(job,"id")?],|row|row.get(0)).map_err(error)?;
        let snapshot=parse_json(snapshot)?;
        if snapshot["requestHash"]!=record["requestHash"]||snapshot["input"]["language"]!=record["languageHint"]||snapshot["encoderSha256"]!=record["provenance"]["encoderSha256"]||snapshot["reusedTimingId"]!=record["reusedFromTimingId"]{return Err("The timing result differs from its admitted transcription snapshot.".into());}
        if record["reusedFromTimingId"].is_null()&&snapshot["pricing"]!=record["pricing"]{return Err("The transcription rate changed after admission.".into());}
        let take=self.timing_take(identifier(record,"takeId")?)?;validate_record(record,&take)?;
        if let Some(id)=record["reusedFromTimingId"].as_str(){
            let original=self.timing(id)?;
            for field in ["takeId","assetId","assetSha256","provider","model","languageHint","transcript","words","measuredAt","requestHash","provenance","pricing","estimatedCost"]{if original[field]!=record[field]{return Err("Cached timing differs from its original measurement evidence.".into());}}
        }
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let state:String=transaction.query_row("SELECT state FROM jobs WHERE id=?1",[identifier(job,"id")?],|row|row.get(0)).map_err(error)?;
        if state!="running"{return Err("The transcription job no longer accepts a result.".into());}
        transaction.execute("INSERT INTO speech_timings(id,take_id,request_hash,created_at,data) VALUES(?1,?2,?3,?4,?5)",params![identifier(record,"id")?,identifier(record,"takeId")?,record["requestHash"].as_str(),record["createdAt"].as_str(),encode(record)?]).map_err(error)?;
        Self::put_job_in_transaction(&transaction,job)?;transaction.commit().map_err(error)
    }

    pub fn put_timing_chunk(&mut self,job:&Value,ordinal:usize,data:&Value)->Result<(),String>{
        bounded_record(data)?;
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let id=identifier(job,"id")?;
        let used:i64=transaction.query_row("SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM speech_timing_chunks WHERE job_id=?1",[id],|row|row.get(0)).map_err(error)?;
        if used as usize+encode(data)?.len()>32*1024*1024{return Err("Timing evidence exceeds the local 32 MiB take guard. Transcribe shorter production takes.".into());}
        let (state,previous):(String,String)=transaction.query_row("SELECT state,data FROM jobs WHERE id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(error)?;
        if state!="running"||parse_json(previous)?["completedSegments"]!=ordinal as u64{return Err("The transcription chunk no longer belongs to the active job position.".into());}
        transaction.execute("INSERT INTO speech_timing_chunks VALUES(?1,?2,?3)",params![id,ordinal as i64,encode(data)?]).map_err(error)?;
        Self::put_job_in_transaction(&transaction,job)?;transaction.commit().map_err(error)
    }

    pub fn timing_chunks(&self,job_id:&str)->Result<Vec<Value>,String>{
        let mut statement=self.connection.prepare("SELECT data FROM speech_timing_chunks WHERE job_id=?1 ORDER BY ordinal").map_err(error)?;
        let rows=statement.query_map([job_id],|row|row.get::<_,String>(0)).map_err(error)?;
        rows.map(|row|parse_json(row.map_err(error)?)).collect()
    }
}

pub fn clean_workspaces(connection:&Connection,root:&Path,project_id:Option<&str>)->Result<(),String>{
    let directory=root.join("temporary");
    if !directory.exists(){return Ok(());}
    let directory=directory.canonicalize().map_err(error)?;
    if !directory.starts_with(root){return Err("Transcription working storage is outside its project store.".into());}
    for entry in fs::read_dir(&directory).map_err(error)?{
        let entry=entry.map_err(error)?;
        let name=entry.file_name();let Some(name)=name.to_str()else{continue};
        let Some(id)=name.strip_prefix("timing-")else{continue};
        if validate_id(id).is_err(){continue;}
        let state:Option<String>=connection.query_row("SELECT state FROM jobs WHERE id=?1 AND (?2 IS NULL OR project_id=?2)",params![id,project_id],|row|row.get(0)).optional().map_err(error)?;
        if state.as_deref().is_none_or(|state|matches!(state,"queued"|"running")){continue;}
        let path=entry.path().canonicalize().map_err(error)?;
        if path.parent()!=Some(directory.as_path())||path.file_name().and_then(|name|name.to_str())!=Some(name){return Err("A transcription working directory failed its scope check.".into());}
        if path.is_dir(){fs::remove_dir_all(path).map_err(|_|"Transcription working files could not be removed. Close file viewers and clean expired audio again.")?;}
    }
    Ok(())
}
