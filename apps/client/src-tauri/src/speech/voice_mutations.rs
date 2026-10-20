use super::*;

const ACTIVE:&str="('pending','uncertain')";
const BUSY:&str="This Fish voice has an unresolved deletion. Resolve it in Voices before assigning it.";

fn requested_voice(snapshot:&str,voice:&str)->String{
    format!("json_extract({snapshot},'$.profile.backend')='fish-cloud' AND COALESCE(json_extract({snapshot},'$.billableBytesEstimate'),0)>0 AND (json_extract({snapshot},'$.profile.voiceId')={voice} OR EXISTS(SELECT 1 FROM json_each({snapshot},'$.input.segments') segment,json_each(segment.value,'$.voiceIds') binding WHERE binding.value={voice}))")
}

pub(super) fn schema(connection:&Connection)->Result<(),String>{
    connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_voice_mutations(id TEXT PRIMARY KEY,voice_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN('delete','update')),state TEXT NOT NULL CHECK(state IN('pending','uncertain','deleted','updated','unavailable','rejected','superseded')),created_at TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE UNIQUE INDEX IF NOT EXISTS speech_voice_mutation_active ON speech_voice_mutations(voice_id) WHERE state IN('pending','uncertain');
        CREATE INDEX IF NOT EXISTS speech_voice_mutation_history ON speech_voice_mutations(created_at,id);").map_err(error)?;
    for (table,column) in [("projects","data"),("templates","document")]{
        for operation in ["INSERT","UPDATE"]{
            connection.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS speech_voice_mutation_{table}_{operation} BEFORE {operation} ON {table} WHEN NEW.deleted=0 AND EXISTS(SELECT 1 FROM speech_voice_mutations deletion,json_tree(NEW.{column},'$.cast') binding WHERE deletion.operation='delete' AND deletion.state IN {ACTIVE} AND binding.key='voiceId' AND binding.value=deletion.voice_id) BEGIN SELECT RAISE(ABORT,'{BUSY}'); END;")).map_err(error)?;
        }
    }
    for operation in ["INSERT","UPDATE"]{
        connection.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS speech_voice_mutation_profiles_{operation} BEFORE {operation} ON profiles WHEN NEW.deleted=0 AND json_extract(NEW.data,'$.backend')='fish-cloud' AND EXISTS(SELECT 1 FROM speech_voice_mutations deletion WHERE deletion.operation='delete' AND deletion.state IN {ACTIVE} AND deletion.voice_id=json_extract(NEW.data,'$.voiceId')) BEGIN SELECT RAISE(ABORT,'{BUSY}'); END;")).map_err(error)?;
    }
    let requested=requested_voice("NEW.snapshot","deletion.voice_id");
    connection.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS speech_voice_mutation_admission BEFORE INSERT ON speech_requests WHEN EXISTS(SELECT 1 FROM speech_voice_mutations deletion WHERE deletion.operation='delete' AND deletion.state IN {ACTIVE} AND ({requested})) BEGIN SELECT RAISE(ABORT,'{BUSY}'); END;")).map_err(error)?;
    let requested=requested_voice("request.snapshot","deletion.voice_id");
    connection.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS speech_voice_mutation_dispatch BEFORE UPDATE ON jobs WHEN NEW.state IN('queued','running') AND EXISTS(SELECT 1 FROM speech_requests request,speech_voice_mutations deletion WHERE request.job_id=NEW.id AND deletion.operation='delete' AND deletion.state IN {ACTIVE} AND ({requested})) BEGIN SELECT RAISE(ABORT,'{BUSY}'); END;")).map_err(error)?;
    Ok(())
}

fn used(connection:&Connection,id:&str)->Result<bool,String>{
    let requested=requested_voice("request.snapshot","?1");
    connection.query_row(&format!("SELECT EXISTS(SELECT 1 FROM projects project,json_tree(project.data,'$.cast') binding WHERE project.deleted=0 AND binding.key='voiceId' AND binding.value=?1)
        OR EXISTS(SELECT 1 FROM profiles WHERE deleted=0 AND json_extract(data,'$.backend')='fish-cloud' AND json_extract(data,'$.voiceId')=?1)
        OR EXISTS(SELECT 1 FROM templates template,json_tree(template.document,'$.cast') binding WHERE template.deleted=0 AND binding.key='voiceId' AND binding.value=?1)
        OR EXISTS(SELECT 1 FROM jobs job JOIN speech_requests request ON request.job_id=job.id WHERE job.state IN('queued','running') AND ({requested}))"),[id],|row|row.get(0)).map_err(error)
}

fn mutation(connection:&Connection,id:&str)->Result<Value,String>{
    let data:String=connection.query_row("SELECT data FROM speech_voice_mutations WHERE id=?1",[id],|row|row.get(0)).optional().map_err(error)?.ok_or("The voice change attempt is unavailable.")?;parse_json(data)
}

fn write(connection:&Connection,value:&Value)->Result<(),String>{
    let changed=connection.execute("UPDATE speech_voice_mutations SET state=?2,data=?3 WHERE id=?1",params![identifier(value,"id")?,text(value,"state",1,32)?,encode(value)?]).map_err(error)?;
    if changed!=1{return Err("The voice change attempt changed. Refresh its history.".into());}Ok(())
}

fn changes(input:&Value)->Result<Value,String>{
    fields(input,&["name","visibility"])?;
    let mut changes=serde_json::Map::new();
    if input.get("name").is_some(){let name=text(input,"name",1,1024)?;if name.trim().is_empty()||name.trim()!=name||name.chars().any(char::is_control){return Err("Enter a voice name without control characters or surrounding spaces, within 1,024 UTF-8 bytes.".into());}changes.insert("name".into(),json!(name));}
    if let Some(visibility)=input.get("visibility"){if !matches!(visibility.as_str(),Some("private"|"unlist")){return Err("Choose private or unlisted visibility; publish public voices through Fish's website.".into());}changes.insert("visibility".into(),visibility.clone());}
    if changes.is_empty(){return Err("Choose a voice name or visibility to update.".into());}Ok(Value::Object(changes))
}

impl SpeechStore{
    pub(crate) fn begin_voice_mutation(&mut self,operation:&str,input:&Value,now:&str)->Result<Value,String>{
        if !matches!(operation,"delete"|"update"){return Err("Choose a supported voice change.".into());}
        let allowed=if operation=="update"{vec!["id","confirmed","retryMutationId","changes"]}else{vec!["id","confirmed","retryMutationId"]};fields(input,&allowed)?;
        let voice_id=identifier(input,"id")?;if !boolean(input,"confirmed")?{return Err("Confirm the change to the remote Fish voice.".into());}
        let changes=if operation=="update"{changes(required(input,"changes")?)?}else{Value::Null};
        let retry=optional_identifier(input,"retryMutationId")?;
        let current_time=parse_time(now)?;
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        if operation=="delete"&&used(&transaction,voice_id)?{return Err("This voice is assigned to a project, scene, profile, template or active render. Reassign it or stop that render before deleting the remote voice.".into());}
        let active:Option<String>=transaction.query_row("SELECT id FROM speech_voice_mutations WHERE voice_id=?1 AND state IN('pending','uncertain')",[voice_id],|row|row.get(0)).optional().map_err(error)?;
        let parent=if let Some(active)=active{
            let mut previous=mutation(&transaction,&active)?;
            if retry!=Some(active.as_str())||previous["operation"]!=operation||previous["changes"]!=changes{return Err("Retry the exact unresolved voice change, or check its status first.".into());}
            if previous["state"]=="pending"&&current_time<parse_time(text(&previous,"retryAfter",1,128)?)?{return Err("This voice change is still running. Wait for its result before retrying.".into());}
            previous["state"]=json!("superseded");previous["updatedAt"]=json!(now);write(&transaction,&previous)?;json!(active)
        }else{if retry.is_some(){return Err("The voice change attempt changed. Refresh its history before retrying.".into());}Value::Null};
        let id=uuid()?;
        let value=json!({"id":id,"voiceId":voice_id,"operation":operation,"changes":changes,"state":"pending","createdAt":now,"updatedAt":now,"retryAfter":(current_time+chrono::Duration::seconds(120)).to_rfc3339_opts(SecondsFormat::Millis,true),"parentId":parent,"httpStatus":null,"remoteStatus":null,"remoteVoice":null,"errorCategory":null});
        transaction.execute("INSERT INTO speech_voice_mutations(id,voice_id,operation,state,created_at,data) VALUES(?1,?2,?3,'pending',?4,?5)",params![id,voice_id,operation,now,encode(&value)?]).map_err(error)?;transaction.commit().map_err(error)?;Ok(value)
    }

    pub(crate) fn finish_voice_mutation(&mut self,id:&str,status:Option<u16>,now:&str)->Result<Value,String>{
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let mut value=mutation(&transaction,id)?;
        if !matches!(value["state"].as_str(),Some("pending"|"uncertain")){return Err("The voice change attempt changed. Refresh its history.".into());}
        let (state,category)=match status{Some(200)=>(if value["operation"]=="delete"{"deleted"}else{"updated"},None),Some(404)=>("unavailable",Some("voice-unavailable")),Some(401|403)=>("rejected",Some("authentication")),Some(402)=>("rejected",Some("credit")),Some(400|422)=>("rejected",Some("invalid-input")),Some(429)=>("rejected",Some("concurrency")),Some(_)=>("uncertain",Some("upstream")),None=>("uncertain",Some("network"))};
        value["state"]=json!(state);value["httpStatus"]=json!(status);value["errorCategory"]=json!(category);value["updatedAt"]=json!(now);write(&transaction,&value)?;
        if matches!(state,"deleted"|"unavailable"){transaction.execute("DELETE FROM speech_voice_observations WHERE id=?1",[value["voiceId"].as_str().ok_or("The voice change target is missing.")?]).map_err(error)?;}
        transaction.commit().map_err(error)?;Ok(value)
    }

    pub(crate) fn voice_mutation_for_check(&mut self,id:&str,now:&str)->Result<Value,String>{
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let mut value=mutation(&transaction,id)?;
        if value["state"]=="pending"{
            if parse_time(now)?<parse_time(text(&value,"retryAfter",1,128)?)?{return Err("This voice change is still running. Wait for its result before checking it.".into());}
            value["state"]=json!("uncertain");value["errorCategory"]=json!("interrupted");value["updatedAt"]=json!(now);write(&transaction,&value)?;
        }
        transaction.commit().map_err(error)?;Ok(value)
    }

    pub(crate) fn observe_voice_mutation(&mut self,id:&str,status:u16,voice:Option<&Value>,now:&str)->Result<Value,String>{
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let mut value=mutation(&transaction,id)?;
        if value["state"]!="uncertain"{return Err("The voice change attempt changed. Refresh its history.".into());}
        let remote=if let Some(voice)=voice{if status!=200||voice["id"]!=value["voiceId"]{return Err("The voice status response differs from its requested voice.".into());}json!({"name":text(voice,"name",1,1024)?,"visibility":text(voice,"visibility",1,32)?})}else{Value::Null};
        value["remoteStatus"]=json!(status);value["remoteVoice"]=remote;value["updatedAt"]=json!(now);write(&transaction,&value)?;transaction.commit().map_err(error)?;Ok(value)
    }

    pub(super) fn list_voice_mutations(&self,input:&Value)->Result<Value,String>{
        fields(input,&["offset","limit"])?;
        let offset=required(input,"offset")?.as_u64().filter(|offset|*offset<=9_007_199_254_740_991).ok_or("Use a nonnegative voice history offset.")? as i64;
        let limit=required(input,"limit")?.as_u64().filter(|limit|(1..=100).contains(limit)).ok_or("Use a voice history page size from 1 to 100.")? as i64;
        let transaction=self.connection.unchecked_transaction().map_err(error)?;
        let total:i64=transaction.query_row("SELECT COUNT(*) FROM speech_voice_mutations",[],|row|row.get(0)).map_err(error)?;
        let mut statement=transaction.prepare("SELECT data FROM speech_voice_mutations ORDER BY created_at DESC,id DESC LIMIT ?1 OFFSET ?2").map_err(error)?;
        let rows=statement.query_map(params![limit,offset],|row|row.get(0)).map_err(error)?;
        Ok(json!({"mutations":collect_json(rows)?,"total":total,"offset":offset,"limit":limit}))
    }
}
