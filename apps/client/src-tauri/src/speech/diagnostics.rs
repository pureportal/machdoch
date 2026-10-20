use super::store::SpeechStore;
use rusqlite::params;
use serde_json::{json,Value};

fn provider_responses(store:&SpeechStore,job_id:&str)->Result<(u64,Vec<Value>),String>{
    let count=store.connection.query_row("SELECT count(*) FROM job_takes j JOIN takes t ON t.id=j.take_id WHERE j.job_id=?1 AND json_type(t.data,'$.providerResponse')='object'",[job_id],|row|row.get::<_,i64>(0)).map_err(|error|error.to_string())?;
    let count=u64::try_from(count).map_err(|_|"The diagnostic response count is invalid.")?;
    let mut statement=store.connection.prepare("SELECT t.id,json_extract(t.data,'$.backend'),json_extract(t.data,'$.providerResponse'),json_extract(t.data,'$.generatedAt'),json_extract(t.data,'$.reusedFromTakeId') IS NOT NULL FROM job_takes j JOIN takes t ON t.id=j.take_id WHERE j.job_id=?1 AND json_type(t.data,'$.providerResponse')='object' ORDER BY t.created_at DESC,t.id DESC LIMIT 10").map_err(|error|error.to_string())?;
    let rows=statement.query_map([job_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,bool>(4)?))).map_err(|error|error.to_string())?;
    let mut results=Vec::new();
    for row in rows{
        let (id,backend,response,generated_at,reused)=row.map_err(|error|error.to_string())?;
        let response:Value=serde_json::from_str(&response).map_err(|_|"A saved provider response is damaged. Inspect its take before preparing diagnostics.")?;
        super::provider_response::validate(&response,&backend)?;
        results.push(json!({"takeId":id,"generatedAt":generated_at,"reused":reused,"response":response}));
    }
    Ok((count,results))
}

pub fn collect(store:&SpeechStore,settings:&Value,input:&Value,application_version:&str,now:&str)->Result<Value,String>{
    let fields=input.as_object().ok_or("Choose a diagnostic job limit.")?;
    if fields.keys().any(|field|!matches!(field.as_str(),"owner"|"limit")){return Err("Choose only a diagnostic owner and job limit.".into());}
    let limit=input["limit"].as_u64().filter(|limit|(1..=100).contains(limit)).ok_or("Include between 1 and 100 recent jobs.")?;
    let owner=match input.get("owner"){None=>None,Some(owner)=>Some(owner.as_str().filter(|owner|!owner.is_empty()&&owner.len()<=512).ok_or("Choose a valid diagnostic speech owner.")?)};
    let mut statement=store.connection.prepare("SELECT json_object(
        'jobId',jobs.id,'state',jobs.state,'kind',json_extract(jobs.data,'$.kind'),
        'backend',CASE WHEN json_extract(request.snapshot,'$.operation') IN ('designVoice','createVoice') THEN 'fish-cloud' ELSE coalesce(json_extract(request.snapshot,'$.profile.backend'),json_extract(request.snapshot,'$.input.provider')) END,
        'model',coalesce(json_extract(request.snapshot,'$.profile.model'),json_extract(request.snapshot,'$.model'),json_extract(request.snapshot,'$.input.model')),
        'createdAt',jobs.created_at,'updatedAt',json_extract(jobs.data,'$.updatedAt'),'attempt',json_extract(jobs.data,'$.attempt'),
        'completedSegments',json_extract(jobs.data,'$.completedSegments'),'totalSegments',json_extract(jobs.data,'$.totalSegments'),
        'errorCategory',CASE WHEN request.snapshot IS NULL THEN 'missing-request' WHEN jobs.state='uncertain' THEN 'uncertain-completion' WHEN jobs.state='interrupted' THEN 'application-interrupted' WHEN jobs.state='failed' THEN 'request-failed' WHEN jobs.state='cancelled' THEN 'cancelled' ELSE NULL END,
        'usage',CASE WHEN json_type(jobs.data,'$.usage')='object' THEN json_object(
            'completedRequests',json_extract(jobs.data,'$.usage.completedRequests'),'reusedSegments',json_extract(jobs.data,'$.usage.reusedSegments'),
            'uncertainRequests',json_extract(jobs.data,'$.usage.uncertainRequests'),'characters',json_extract(jobs.data,'$.usage.characters'),
            'utf8Bytes',json_extract(jobs.data,'$.usage.utf8Bytes'),'producedAudioSeconds',json_extract(jobs.data,'$.usage.producedAudioSeconds'),
            'inputAudioSeconds',json_extract(jobs.data,'$.usage.inputAudioSeconds')) ELSE NULL END)
        FROM jobs LEFT JOIN speech_requests AS request ON request.job_id=jobs.id WHERE (?1 IS NULL OR jobs.owner=?1) ORDER BY jobs.created_at DESC,jobs.id LIMIT ?2").map_err(|error|error.to_string())?;
    let rows=statement.query_map(params![owner,limit as i64],|row|row.get::<_,String>(0)).map_err(|error|error.to_string())?;
    let mut jobs=rows.map(|row|serde_json::from_str::<Value>(&row.map_err(|error|error.to_string())?).map_err(|_|"The diagnostic job projection is invalid.".to_string())).collect::<Result<Vec<_>,_>>()?;
    for job in &mut jobs{let id=job["jobId"].as_str().ok_or("A diagnostic job ID is missing.")?.to_owned();let (count,responses)=provider_responses(store,&id)?;job["providerResponseTakeCount"]=json!(count);job["providerResponses"]=json!(responses);job["performance"]=store.generation_performance(&id)?;}
    let connections=settings["connections"].as_array().ok_or("Load speech connection settings before preparing diagnostics.")?.iter().map(|connection|json!({
        "backend":connection["backend"],"model":connection["model"],"configured":connection["configured"],"healthy":connection["healthy"],
        "runtimePinned":connection["runtimeVersion"].as_str().is_some_and(|version|!version.is_empty()),"nativeRevision":connection["nativeRevision"]
    })).collect::<Vec<_>>();
    Ok(json!({"schema":"machdoch-speech-diagnostics","version":1,"createdAt":now,"applicationVersion":application_version,
        "platform":{"os":std::env::consts::OS,"architecture":std::env::consts::ARCH},
        "settings":{"cloudConsent":settings["cloudConsent"],"maxConcurrent":settings["maxConcurrent"],"answerCharacterLimit":settings["answerCharacterLimit"],"cacheRetentionDays":settings["cacheRetentionDays"]},
        "connections":connections,"jobs":jobs,"playbackPerformance":store.playback_performance(owner)?}))
}
