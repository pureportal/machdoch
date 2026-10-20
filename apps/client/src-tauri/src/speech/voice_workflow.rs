use super::store::SpeechStore;
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};
use std::collections::HashSet;

pub fn schema(store:&SpeechStore)->Result<(),String>{
    store.connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_voice_workflow_results(job_id TEXT PRIMARY KEY REFERENCES jobs(id),data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE IF NOT EXISTS speech_design_origins(candidate_id TEXT PRIMARY KEY REFERENCES speech_design_candidates(id),job_id TEXT NOT NULL REFERENCES jobs(id));
        CREATE TRIGGER IF NOT EXISTS voice_workflow_results_no_update BEFORE UPDATE ON speech_voice_workflow_results BEGIN SELECT RAISE(ABORT,'Voice results are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS design_candidates_no_update BEFORE UPDATE ON speech_design_candidates BEGIN SELECT RAISE(ABORT,'Design candidates are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS design_origins_no_update BEFORE UPDATE ON speech_design_origins BEGIN SELECT RAISE(ABORT,'Design origins are immutable'); END;")
        .map_err(|error|error.to_string())
}

fn text<'a>(input:&'a Value,field:&str,maximum:usize)->Result<&'a str,String>{
    input[field].as_str().filter(|value|!value.trim().is_empty()&&value.chars().count()<=maximum).ok_or_else(||format!("Enter {field} within {maximum} characters."))
}

pub fn estimate(pricing:&Value,now:&str)->Result<Option<f64>,String>{
    if pricing.is_null(){return Ok(None);}
    let fields=pricing.as_object().ok_or("Record the account rate per request.")?;
    if fields.len()!=5||fields.keys().any(|field|!matches!(field.as_str(),"perRequest"|"currency"|"source"|"effectiveFrom"|"effectiveTo")){return Err("Record only the rate per request, currency, source and effective dates.".into());}
    let rate=pricing["perRequest"].as_f64().filter(|rate|rate.is_finite()&&(0.0..=1_000_000.0).contains(rate)).ok_or("Use a finite nonnegative rate per request.")?;
    if pricing["currency"].as_str().is_none_or(|currency|currency.len()!=3||!currency.bytes().all(|byte|byte.is_ascii_uppercase())){return Err("Use a three-letter uppercase currency.".into());}
    if text(pricing,"source",4096)?.chars().any(char::is_control){return Err("Remove control characters from the account rate source.".into());}
    let at=chrono::DateTime::parse_from_rfc3339(now).map_err(|_|"The voice request time is invalid.")?.date_naive();
    let from=chrono::NaiveDate::parse_from_str(text(pricing,"effectiveFrom",10)?,"%Y-%m-%d").map_err(|_|"Use valid effective pricing dates.")?;
    let to=chrono::NaiveDate::parse_from_str(text(pricing,"effectiveTo",10)?,"%Y-%m-%d").map_err(|_|"Use valid effective pricing dates.")?;
    if from>at||to<at{return Err("Verify an account rate effective today.".into());}Ok(Some(rate))
}

pub fn admit(store:&mut SpeechStore,operation:&str,input:Value,settings:Value,now:String,id:String)->Result<Value,String>{
    let kind=match operation{"designVoice"=>"voice-design","createVoice"=>"voice-creation",_=>return Err("Choose voice design or voice creation.".into())};
    let fields=input.as_object().ok_or("Supply a voice workflow request.")?;
    let common=["owner","cloudConsent","budgetLimit","pricing","parentJobId"];
    let specific=if operation=="designVoice"{vec!["description","text"]}else{vec!["name","referenceAssetIds","transcripts","rightsEvidence","permissionConfirmed","designCandidateId"]};
    if fields.keys().any(|field|!common.contains(&field.as_str())&&!specific.contains(&field.as_str()))||["owner","cloudConsent","budgetLimit","pricing"].iter().any(|field|!fields.contains_key(*field)){return Err("Supply the explicit voice owner, consent, pricing and budget without unsupported settings.".into());}
    let owner=text(&input,"owner",512)?.to_owned();
    if input["cloudConsent"]!=true||settings["cloudConsent"]!=true{return Err("Allow this cloud request before sending voice material to Fish.".into());}
    if !settings["connections"].as_array().is_some_and(|connections|connections.iter().any(|connection|connection["backend"]=="fish-cloud"&&connection["configured"]==true)){return Err("Configure Fish Audio before queueing voice work.".into());}
    let mut references=Vec::new();let mut candidate=Value::Null;
    let (characters,bytes)=if operation=="designVoice"{
        let description=text(&input,"description",2000)?;let preview=text(&input,"text",150)?;
        (description.chars().count()+preview.chars().count(),description.len()+preview.len())
    }else{
        let name=text(&input,"name",200)?;if name.chars().any(char::is_control){return Err("Use a voice name without control characters.".into());}let rights=text(&input,"rightsEvidence",32768)?;
        if input["permissionConfirmed"]!=true{return Err("Confirm permission to use this material and create the voice.".into());}
        let ids=input["referenceAssetIds"].as_array().ok_or("Choose reference recordings or a design candidate.")?;
        let transcripts=input["transcripts"].as_array().filter(|values|values.len()==ids.len()).ok_or("Attach an accurate transcript to every recording.")?;
        if let Some(candidate_id)=input["designCandidateId"].as_str(){
            if !ids.is_empty(){return Err("Choose recordings or one design candidate for the voice.".into());}
            let saved:Option<(String,String,String)>=store.connection.query_row("SELECT candidates.asset_id,candidates.metadata,json_extract(request.snapshot,'$.input.text') FROM speech_design_candidates AS candidates JOIN speech_design_origins AS origin ON origin.candidate_id=candidates.id JOIN jobs ON jobs.id=origin.job_id JOIN speech_requests AS request ON request.job_id=jobs.id WHERE candidates.id=?1 AND jobs.owner=?2",params![candidate_id,owner],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|error|error.to_string())?;
            let (asset_id,metadata,preview)=saved.ok_or("Choose a saved design candidate owned by this speech session.")?;
            candidate=serde_json::from_str(&metadata).map_err(|_|"The saved design metadata is damaged.")?;
            if candidate.get("voice_design_signature").is_some_and(|value|!value.is_null()){
                text(&candidate,"voice_design_signature",32768).map_err(|_|"The returned candidate signature is invalid. Review the candidate metadata before creating a voice.".to_string())?;
            }
            if preview.trim().is_empty()||preview.chars().count()>150{return Err("The saved design request has an invalid preview transcript.".into());}
            let transcript=preview;
            let asset=store.execute("asset",&json!({"id":asset_id}))?;
            references.push(json!({"asset":asset,"transcript":transcript,"rights":rights}));
        }else{
            if input.get("designCandidateId").is_some()||!(1..=20).contains(&ids.len()){return Err("Choose between 1 and 20 reference recordings, or one saved design candidate.".into());}
            let mut known=HashSet::new();
            for (index,id) in ids.iter().enumerate(){
                let id=id.as_str().filter(|id|known.insert(*id)).ok_or("Choose distinct saved reference recordings.")?;
                let transcript=transcripts[index].as_str().filter(|value|!value.trim().is_empty()&&value.chars().count()<=65536).ok_or("Attach an accurate transcript within 65,536 characters to every recording.")?;
                let asset=store.execute("asset",&json!({"id":id}))?;
                references.push(json!({"asset":asset,"transcript":transcript,"rights":rights}));
            }
        }
        let mut total=0u64;
        for reference in &references{
            let asset=&reference["asset"];
            if asset["mimeType"]!="audio/wav"{return Err("Use validated WAV references for voice creation.".into());}
            let size=asset["bytes"].as_u64().filter(|size|*size<=16*1024*1024).ok_or("Trim each voice reference below the local 16 MiB upload guard.")?;total+=size;
            if total>128*1024*1024{return Err("Trim voice references below the local 128 MiB aggregate upload guard.".into());}
        }
        (name.chars().count()+references.iter().map(|reference|reference["transcript"].as_str().unwrap_or("").chars().count()).sum::<usize>(),name.len()+references.iter().map(|reference|reference["transcript"].as_str().unwrap_or("").len()).sum::<usize>())
    };
    let price=input["pricing"].clone();let amount=estimate(&price,&now)?;
    let requested=if input["budgetLimit"].is_null(){None}else{Some(input["budgetLimit"].as_f64().filter(|value|value.is_finite()&&*value>=0.0).ok_or("Use a nonnegative voice request budget.")?)};
    let configured=settings["budgetLimit"].as_f64();let limit=match(requested,configured){(Some(a),Some(b))=>Some(a.min(b)),(a,b)=>a.or(b)};
    let parent=if let Some(parent_id)=input["parentJobId"].as_str(){
        let saved:Option<(String,String)>=store.connection.query_row("SELECT jobs.data,request.snapshot FROM jobs JOIN speech_requests AS request ON request.job_id=jobs.id WHERE jobs.id=?1 AND jobs.owner=?2",params![parent_id,owner],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|error|error.to_string())?;
        let (job,snapshot)=saved.ok_or("Choose a stopped voice job owned by this speech session.")?;
        let job:Value=serde_json::from_str(&job).map_err(|_|"The voice job metadata is damaged.")?;let snapshot:Value=serde_json::from_str(&snapshot).map_err(|_|"The voice job snapshot is damaged.")?;
        if !matches!(job["state"].as_str(),Some("failed"|"cancelled"|"uncertain"|"interrupted"))||job["completedSegments"]!=0||job["kind"]!=kind{return Err("Retry only stopped, uncommitted voice requests; open saved results for completed work.".into());}
        let mut previous=snapshot["input"].clone();previous.as_object_mut().ok_or("The original voice input is damaged.")?.remove("parentJobId");let mut current=input.clone();current.as_object_mut().ok_or("The voice input is invalid.")?.remove("parentJobId");
        if previous!=current||snapshot["references"]!=json!(references)||snapshot["candidate"]!=candidate{return Err("The voice input changed. Review a new request instead of retrying this one.".into());}Some(job)
    }else{if input.get("parentJobId").is_some(){return Err("Choose a valid retry parent job ID.".into());}None};
    let job=json!({"id":id,"owner":owner,"projectId":null,"revisionId":format!("{kind}-{id}"),"state":"queued","completedSegments":0,"totalSegments":1,"takeIds":[],"error":null,"createdAt":now,"updatedAt":now,"priority":50,"attempt":parent.as_ref().map_or(1,|job|job["attempt"].as_u64().unwrap_or(0)+1),"parentJobId":input["parentJobId"],"kind":kind});
    let snapshot=json!({"jobId":id,"operation":operation,"model":if operation=="designVoice"{json!("voice-design-1")}else{Value::Null},"input":input,"references":references,"candidate":candidate,"pricing":price,"estimate":amount,"characters":characters,"textBytes":bytes,"resumedSegments":0});
    super::store::bounded_record(&snapshot)?;
    let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
    super::budget::check(&transaction,&owner,amount,limit,&price)?;
    SpeechStore::put_job_in_transaction(&transaction,&job)?;
    transaction.execute("INSERT INTO speech_budget(job_id,scope,amount) VALUES(?1,?2,?3)",params![id,owner,amount.unwrap_or(0.0)]).map_err(|error|error.to_string())?;
    transaction.execute("INSERT INTO speech_requests(job_id,snapshot) VALUES(?1,?2)",params![id,snapshot.to_string()]).map_err(|error|error.to_string())?;
    transaction.commit().map_err(|error|error.to_string())?;Ok(job)
}

pub fn result(store:&mut SpeechStore,input:&Value)->Result<Value,String>{
    let fields=input.as_object().ok_or("Choose a saved voice result.")?;
    if fields.len()!=2||fields.keys().any(|field|!matches!(field.as_str(),"owner"|"jobId")){return Err("Choose the owning speech session and voice job.".into());}
    let owner=text(input,"owner",512)?;let id=text(input,"jobId",128)?;
    let data:Option<String>=store.connection.query_row("SELECT result.data FROM speech_voice_workflow_results AS result JOIN jobs ON jobs.id=result.job_id WHERE jobs.id=?1 AND jobs.owner=?2",params![id,owner],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
    let mut result:Value=serde_json::from_str(&data.ok_or("This voice result is unavailable to the requesting speech session.")?).map_err(|_|"The saved voice result is damaged.")?;
    for candidate in result["candidates"].as_array_mut().ok_or("The saved candidate inventory is damaged.")?{
        candidate["asset"]=store.execute("asset",&json!({"id":candidate["assetId"]}))?;
        candidate.as_object_mut().ok_or("The saved candidate is damaged.")?.remove("assetId");
    }
    Ok(result)
}

#[cfg(test)]
#[path="voice_workflow_tests.rs"]
mod tests;
