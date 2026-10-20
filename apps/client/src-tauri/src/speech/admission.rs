use super::store::SpeechStore;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub fn retry_input(snapshot:&Value,job_id:&str,confirmed_uncertain:bool)->Result<Value,String>{
    if !snapshot["liveInput"].is_null(){return Err("Live input cannot be retried as a fixed-text request. Replay the completed answer deliberately.".into());}
    let mut input=snapshot["input"].as_object().ok_or("The original request snapshot is damaged.")?.clone();
    input.insert("parentJobId".into(),json!(job_id));
    if snapshot["operation"]=="align"{input.insert("confirmedUncertain".into(),json!(confirmed_uncertain));}
    Ok(Value::Object(input))
}

pub fn admit(store: &mut SpeechStore, input: Value, settings: Value, now: String, job_id: String) -> Result<Value, String> {
    admit_request(store,input,settings,now,job_id,None,None)
}

pub fn admit_live(store: &mut SpeechStore, input: Value, settings: Value, now: String, job_id: String, maximum: u64) -> Result<Value, String> {
    admit_request(store,input,settings,now,job_id,Some(maximum),None)
}

pub fn admit_generation(store:&mut SpeechStore,input:Value,settings:Value,now:String,job_id:String,generation:super::generation::GenerationSnapshot)->Result<Value,String>{
    admit_request(store,input,settings,now,job_id,None,Some(generation))
}

fn admit_request(store: &mut SpeechStore, mut input: Value, settings: Value, now: String, job_id: String, live_maximum: Option<u64>, generation:Option<super::generation::GenerationSnapshot>) -> Result<Value, String> {
    let fields=input.as_object().ok_or("Supply a speech render request.")?;
    if fields.keys().any(|key|!matches!(key.as_str(),"owner"|"projectId"|"revisionId"|"profileId"|"segments"|"takes"|"priority"|"reuseCache"|"cloudConsent"|"budgetLimit"|"parentJobId"|"dictionaryRevisions"|"expectedProfile")){return Err("Remove unsupported render settings before submitting speech.".into());}
    if !input["reuseCache"].is_boolean()||!input["cloudConsent"].is_boolean(){return Err("Choose explicit cache reuse and cloud-upload consent values.".into());}
    let owner = input["owner"].as_str().filter(|value| !value.is_empty() && value.len() <= 512).ok_or("A speech owner is required.")?.to_owned();
    let segments = input["segments"].as_array().filter(|values| !values.is_empty() && values.len() <= 10000).ok_or("Choose between 1 and 10,000 speech segments.")?;
    let takes = input["takes"].as_u64().filter(|count| (1..=32).contains(count)).ok_or("Choose between 1 and 32 takes.")?;
    if segments.len() as u64 * takes > 10_000 { return Err("Keep each job within the local 10,000-take storage guard.".into()); }
    let mut profile=if let Some(generation)=&generation{generation.profile.clone()}else{
        let profiles = store.execute("listProfiles", &json!({}))?;
        profiles.as_array().and_then(|values| values.iter().find(|value| value["id"] == input["profileId"])).cloned().ok_or("Choose a saved speech profile.")?
    };
    if input.get("expectedProfile").is_some_and(|expected|*expected!=profile){return Err("The reviewed speech profile changed. Review the scripts and estimate again before rendering.".into());}
    if generation.is_some()&&input.get("dictionaryRevisions").is_some(){return Err("Keep the original dictionaries when requesting another performance.".into());}
    let pinned_dictionaries=super::dictionary_snapshots::resolve(store,&input,&mut profile)?;
    super::store::validate_profile(&profile)?;
    let backend = profile["backend"].as_str().ok_or("Choose a speech backend.")?;
    if let Some(maximum)=live_maximum {
        if backend!="fish-cloud" || takes!=1 || segments.len()!=1 || !input["projectId"].is_null() || input["parentJobId"].is_string() || input["reuseCache"]!=false {
            return Err("Live input requires a new, single-take Fish Cloud answer job.".into());
        }
        if maximum==0 || maximum>100_000 || maximum>settings["answerCharacterLimit"].as_u64().ok_or("Configure an answer character limit.")? { return Err("Keep the live reservation within the configured answer limit and the local 100,000-character stream guard.".into()); }
    }
    super::contracts::validate_profile(&profile)?;
    input["segments"]=json!(input["segments"].as_array().ok_or("Supply speech segments.")?.iter().map(|segment|super::profile_binding::apply(segment,&profile).and_then(|segment|super::assistant_requests::prepare_segment(&segment,&profile))).collect::<Result<Vec<_>,_>>()?);
    let segments=input["segments"].as_array().ok_or("Supply speech segments.")?;
    let direction=profile["direction"].as_str().ok_or("The profile direction is invalid.")?;
    let direction_bytes=if matches!(backend,"fish-cloud"|"sglang"|"drama3")&&!direction.is_empty(){direction.len() as u64+2}else{0};
    let direction_characters=if direction_bytes>0{direction.chars().count() as u64+2}else{0};
    let mut text_bytes = 0u64;
    let mut characters = 0u64;
    let mut segment_ids = std::collections::HashSet::new();
    let mut reference_snapshots = serde_json::Map::new();
    let mut reference_sizes=std::collections::HashMap::new();
    for segment in segments {
        if segment.get("liveFragments").is_some(){return Err("Recorded live fragments are immutable provenance. Use beginLive to stream new answer text.".into());}
        let text = segment["text"].as_str().filter(|value| !value.trim().is_empty()).ok_or("Every speech segment needs text.")?;
        let transcript=segment["spokenText"].as_str().filter(|value|!value.trim().is_empty()&&value.len()<=2*1024*1024).ok_or("Include the compiled spoken transcript for every segment.")?;
        if owner.starts_with("chat:")&&(text!=transcript||text.chars().any(|value|matches!(value,'<'|'>'|'['|']')||value.is_control())){return Err("Convert AI answers into literal speech text before submitting them.".into());}
        super::contracts::validate_segment_references(segment,&profile)?;
        let measured_text=super::contracts::provider_text(segment,&profile)?;
        if !segment["chapter"].is_null() && (!segment["chapter"].is_object() || segment["chapter"]["id"].as_str().is_none_or(|value| value.is_empty() || value.len()>128) || segment["chapter"]["title"].as_str().is_none_or(|value| value.len() > 4096 || value.chars().any(char::is_control))) { return Err("Include a stable chapter ID and a title without control characters.".into()); }
        if text.len() > 2*1024*1024 { return Err("Shorten this segment below the local 2 MiB request guard.".to_string()); }
        if segment["id"].as_str().filter(|value| !value.is_empty() && value.bytes().all(|byte|byte.is_ascii_alphanumeric() || b"_-".contains(&byte))).is_none() { return Err("Use stable alphanumeric speech segment IDs.".to_string()); }
        if !segment_ids.insert(segment["id"].as_str().ok_or("A segment ID is missing.")?) { return Err("Use distinct speech segment IDs within a job.".into()); }
        let voice_ids = segment["voiceIds"].as_array().filter(|ids|ids.len()<=256).ok_or("Supply the segment's voice list within the local 256-entry guard.")?;
        if voice_ids.iter().any(|id|id.as_str().is_none_or(|id|id.is_empty()||id.len()>256||id.chars().any(char::is_control))) { return Err("Use valid provider voice IDs without control characters.".into()); }
        let reference_ids = segment["referenceAssetIds"].as_array().filter(|ids|ids.len()<=256).ok_or("Supply the segment's reference list within the local 256-entry guard.")?;
        let mut reference_bytes=0u64;
        for asset_id in reference_ids {
            let id = asset_id.as_str().ok_or("Use a saved reference asset ID.")?;
            if let Some(size)=reference_sizes.get(id){reference_bytes+=size;if reference_bytes>24*1024*1024{return Err("Trim the segment's inline references below the local 24 MiB aggregate upload guard.".into());}continue;}
            let asset = store.execute("asset", &json!({"id":id}))?;
            let size=asset["bytes"].as_u64().filter(|size|*size<=16*1024*1024).ok_or("Trim each inline reference below the local 16 MiB upload guard before rendering.")?;
            reference_bytes+=size;if reference_bytes>24*1024*1024{return Err("Trim the segment's inline references below the local 24 MiB aggregate upload guard.".into());}reference_sizes.insert(id.to_owned(),size);
            let reference=if let Some(generation)=&generation{
                let reference=generation.references.get(id).ok_or("A pinned performance reference is missing.")?;
                if reference["assetId"]!=id||reference["sha256"]!=asset["sha256"]{return Err("A performance reference no longer matches its original audio.".into());}
                reference.clone()
            }else{
                let (transcript,rights):(String,String) = store.connection.query_row("SELECT transcript,rights FROM speech_references WHERE asset_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|error|error.to_string())?.ok_or("Attach a transcript and permission evidence to every reference before rendering.")?;
                json!({"assetId":id,"sha256":asset["sha256"],"transcript":transcript,"rights":rights})
            };
            reference_snapshots.insert(id.to_string(),reference);
        }
        text_bytes += measured_text.len() as u64+direction_bytes;
        characters += measured_text.chars().count() as u64+direction_characters;
    }
    if owner.starts_with("chat:") && segments.iter().map(|segment|segment["spokenText"].as_str().unwrap_or_default().chars().count() as u64).sum::<u64>() > settings["answerCharacterLimit"].as_u64().unwrap_or(10000) { return Err("This answer exceeds the configured speech character limit.".to_string()); }
    let mut dictionaries = Vec::new();
    let available=if let Some(dictionaries)=pinned_dictionaries{json!(dictionaries)}else if let Some(generation)=&generation{json!(generation.dictionaries)}else{store.execute("listDictionaries",&json!({}))?};
    for id in profile["dictionaryIds"].as_array().ok_or("Invalid profile dictionaries")? {
        dictionaries.push(available.as_array().and_then(|values|values.iter().find(|dictionary|dictionary["id"] == *id)).cloned().ok_or("A pronunciation dictionary is missing.")?);
    }
    super::dictionary_snapshots::validate_set(&dictionaries)?;
    let connection = settings["connections"].as_array().and_then(|values|values.iter().find(|value|value["backend"] == backend)).cloned().ok_or("The speech connection is missing.")?;
    if let Some(generation)=&generation{
        if input["reuseCache"]!=false{return Err("Keep cache reuse off when requesting another performance.".into());}
        for field in ["backend","model","url","runtimeVersion"]{if generation.connection[field]!=connection[field]{return Err("The original performance connection changed. Restore that connection before regenerating.".into());}}
        if profile["id"]!=input["profileId"]||reference_snapshots!=generation.references{return Err("The performance input differs from its pinned configuration.".into());}
        let parent=store.timing_take(&generation.parent_take_id)?;
        if segments.len()!=1||parent["projectId"]!=input["projectId"]||parent["revisionId"]!=input["revisionId"]{return Err("Regenerate the exact source performance revision.".into());}
        let original=store.execute("takeRequest",&json!({"id":generation.parent_take_id}))?;
        let candidate=json!({"segment":segments[0],"profile":profile,"dictionaries":dictionaries,"references":reference_snapshots,"performanceNote":generation.note,"connection":{"backend":connection["backend"],"model":connection["model"],"url":connection["url"],"runtimeVersion":connection["runtimeVersion"]}});
        super::performance::validate_origin(&candidate,&original)?;
    }
    let parent = if let Some(parent_id) = input["parentJobId"].as_str() {
        let data: String = store.connection.query_row("SELECT data FROM jobs WHERE id=?1", [parent_id], |row| row.get(0)).map_err(|_| "The retry parent job is missing.")?;
        let parent: Value = serde_json::from_str(&data).map_err(|_| "The retry parent job is damaged.")?;
        if parent["owner"] != owner || !matches!(parent["state"].as_str(), Some("failed" | "cancelled" | "uncertain" | "interrupted")) { return Err("Retry a stopped job owned by this speech session.".into()); }
        let data: String = store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1", [parent_id], |row| row.get(0)).map_err(|_| "The retry snapshot is missing.")?;
        let previous: Value = serde_json::from_str(&data).map_err(|_| "The retry snapshot is damaged.")?;
        for field in ["projectId", "revisionId", "profileId", "segments", "takes"] {
            if previous["input"][field] != input[field] { return Err("Retry the exact submitted revision, or create a new render for changed work.".into()); }
        }
        if previous["profile"] != profile || previous["dictionaries"] != json!(dictionaries) || previous["references"] != json!(reference_snapshots) || previous["connection"] != connection { return Err("The generation configuration changed. Submit a new render instead of retrying the old snapshot.".into()); }
        Some(parent)
    } else { None };
    let resumed = parent.as_ref().map_or(0, |job| job["completedSegments"].as_u64().unwrap_or(0));
    let mut billable_bytes=text_bytes*takes;
    let mut billable_characters=characters*takes;
    if let Some(maximum)=live_maximum {
        if characters-direction_characters>maximum {return Err("The first live fragment exceeds the reserved answer limit.".into());}
        billable_characters=maximum+direction_characters;
        billable_bytes=maximum.checked_mul(4).ok_or("The live reservation is too large.")?+direction_bytes;
    }
    for ordinal in 0..resumed {
        let text=super::contracts::provider_text(&segments[ordinal as usize % segments.len()],&profile)?;
        billable_bytes = billable_bytes.checked_sub(text.len() as u64+direction_bytes).ok_or("Completed segment recovery is inconsistent.")?;
        billable_characters = billable_characters.checked_sub(text.chars().count() as u64+direction_characters).ok_or("Completed segment recovery is inconsistent.")?;
    }
    let mut cached_takes=serde_json::Map::new();
    if input["reuseCache"]==true {
        for (index, segment) in segments.iter().enumerate() {
            if (index as u64) < resumed { continue; }
            let hash=super::cache::request_hash(segment,&profile,&json!(dictionaries),&json!(reference_snapshots),&connection)?;
            let cached:Option<String>=store.connection.query_row("SELECT data FROM takes WHERE json_extract(data,'$.requestHash')=?1 AND NOT EXISTS(SELECT 1 FROM speech_cache_evictions e WHERE e.asset_id=takes.asset_id) ORDER BY created_at DESC LIMIT 1",[hash],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
            if let Some(cached)=cached {
                let cached:Value=serde_json::from_str(&cached).map_err(|_|"Speech cache metadata is damaged.")?;
                store.asset_path(cached["asset"]["id"].as_str().ok_or("The cached asset ID is missing.")?)?;
                cached_takes.insert(segment["id"].as_str().ok_or("The cached segment identity is missing.")?.to_owned(),cached["id"].clone());
                let text=super::contracts::provider_text(segment,&profile)?;
                billable_bytes-=text.len() as u64+direction_bytes;
                billable_characters-=text.chars().count() as u64+direction_characters;
            }
        }
    }
    if billable_bytes>0 {
        if connection["configured"]!=true{return Err("Configure the selected speech backend before rendering.".into());}
        if !matches!(backend,"sglang"|"drama3")&&(input["cloudConsent"]!=true||settings["cloudConsent"]!=true){return Err("Enable cloud synthesis before sending text or references to this provider.".into());}
    }
    let estimate = estimate(&settings, backend, billable_bytes, billable_characters)?;
    let requested_limit = input["budgetLimit"].as_f64();
    if !input["budgetLimit"].is_null() && requested_limit.filter(|value| value.is_finite() && *value >= 0.0).is_none() { return Err("Use a nonnegative spending limit.".into()); }
    let configured_limit = settings[if owner.starts_with("chat:auto:") { "answerBudgetLimit" } else { "budgetLimit" }].as_f64();
    let limit = match (requested_limit, configured_limit) { (Some(requested), Some(configured)) => Some(requested.min(configured)), (requested, configured) => requested.or(configured) };
    if limit.is_some() && estimate.is_none() { return Err("A verified rate and billing unit are required to enforce a spending limit for this backend.".to_string()); }
    let scope = if owner.starts_with("chat:auto:") { "automatic-answer" } else { input["projectId"].as_str().unwrap_or(&owner) };
    let attempt = parent.as_ref().map_or(1, |job| job["attempt"].as_u64().unwrap_or(0) + 1);
    let previous_takes = parent.as_ref().map_or_else(|| json!([]), |job| job["takeIds"].clone());
    let job = json!({"id":job_id,"owner":owner,"projectId":input["projectId"],"revisionId":input["revisionId"],"state":"queued","completedSegments":resumed,"totalSegments":segments.len() as u64*takes,"takeIds":previous_takes,"error":null,"createdAt":now,"updatedAt":now,"priority":input["priority"],"attempt":attempt,"parentJobId":input["parentJobId"]});
    let mut observed_ids=std::collections::HashSet::new();
    if backend=="fish-cloud"&&billable_bytes>0{
        for segment in segments{for voice in segment["voiceIds"].as_array().into_iter().flatten(){if let Some(id)=voice.as_str(){observed_ids.insert(id.to_string());}}}
        if let Some(id)=profile["voiceId"].as_str(){observed_ids.insert(id.to_string());}
    }
    let voice_observations=store.voice_observations(&observed_ids.into_iter().collect::<Vec<_>>())?;
    let transaction = store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
    super::budget::check(&transaction,scope,estimate,limit,&settings["pricing"])?;
    super::store::SpeechStore::put_job_in_transaction(&transaction, &job)?;
    transaction.execute("INSERT INTO speech_budget(job_id,scope,amount) VALUES(?1,?2,?3)",params![job_id,scope,estimate.unwrap_or(0.0)]).map_err(|error|error.to_string())?;
    let mut snapshot=json!({"jobId":job_id,"input":input,"profile":profile,"dictionaries":dictionaries,"references":reference_snapshots,"connection":connection,"textBytes":text_bytes,"characters":characters,"billableBytesEstimate":billable_bytes,"billableCharactersEstimate":billable_characters,"estimate":estimate,"pricing":settings["pricing"],"resumedSegments":resumed,"cachedTakes":cached_takes});
    snapshot["voiceObservations"]=voice_observations;
    if let Some(generation)=generation{snapshot["parentTakeId"]=json!(generation.parent_take_id);snapshot["performanceNote"]=json!(generation.note);}
    if let Some(maximum)=live_maximum {
        let first=input["segments"][0]["text"].as_str().ok_or("Include the first live fragment.")?;
        super::live_input::validate_text(first)?;
        if input["segments"][0]["spokenText"]!=first {return Err("Use the literal spoken transcript for live answers.".into());}
        snapshot["liveInput"]=json!({"maximumCharacters":maximum,"transport":"fish-live-v1"});
        transaction.execute("INSERT INTO speech_live_inputs(job_id,maximum_characters,characters,next_sequence,consumed_sequence,finished) VALUES(?1,?2,?3,1,0,0)",params![job_id,maximum as i64,first.chars().count() as i64]).map_err(|error|error.to_string())?;
        transaction.execute("INSERT INTO speech_live_fragments(job_id,sequence,text,finished) VALUES(?1,0,?2,0)",params![job_id,first]).map_err(|error|error.to_string())?;
    }
    super::store::bounded_record(&snapshot).map_err(|_|"This render exceeds the local 16 MiB snapshot limit. Reduce the batch or dictionary contents before rendering.")?;
    if let Some(maximum)=live_maximum{super::live_input::ensure_snapshot_capacity(serde_json::to_vec(&snapshot).map_err(|_|"The live snapshot could not be measured.")?.len(),maximum)?;}
    transaction.execute("INSERT INTO speech_requests(job_id,snapshot) VALUES(?1,?2)",params![job_id,snapshot.to_string()]).map_err(|error|error.to_string())?;
    transaction.commit().map_err(|error|error.to_string())?;
    Ok(job)
}

fn estimate(settings: &Value, backend:&str, bytes:u64, characters:u64)->Result<Option<f64>,String>{
    if backend=="drama3"{return Ok(Some(0.0))}
    if bytes==0&&characters==0{return Ok(Some(0.0))}
    if backend!="fish-cloud" || settings["pricing"].is_null(){return Ok(None)}
    let price=&settings["pricing"];
    let today=chrono::Utc::now().date_naive();
    for (field,before) in [("effectiveFrom",true),("effectiveTo",false)]{let date=chrono::NaiveDate::parse_from_str(price[field].as_str().ok_or("Enter effective pricing dates.")?,"%Y-%m-%d").map_err(|_|"Use YYYY-MM-DD pricing dates.")?;if (before&&today<date)||(!before&&today>date){return Err("The saved speech rate is outside its effective dates. Verify the current account rate.".to_string())}}
    let count=match price["unit"].as_str(){Some("characters")=>characters,Some("utf8Bytes")=>bytes,_=>return Err("Choose a verified speech billing unit.".to_string())};
    Ok(Some(count as f64/1_000_000.0*price["perMillion"].as_f64().ok_or("Enter a verified speech rate.")?))
}

#[cfg(test)]
#[path = "admission_tests.rs"]
mod tests;
