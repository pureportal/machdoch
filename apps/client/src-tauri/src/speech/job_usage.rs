use rusqlite::{params,OptionalExtension,Transaction};
use serde_json::{json,Value};

pub fn validate(usage:&Value)->Result<(),String>{
    let fields=usage.as_object().ok_or("Speech usage must be a measured record.")?;
    let required=["estimatedCommittedCost","estimatedUncertainCost","currency","pricing","characters","utf8Bytes","completedRequests","reusedSegments","uncertainRequests","producedAudioSeconds","inputAudioSeconds"];
    if fields.len()!=required.len()||required.iter().any(|key|!fields.contains_key(*key)){return Err("The speech usage record has unsupported fields.".into());}
    for key in ["estimatedCommittedCost","estimatedUncertainCost"]{if !usage[key].is_null()&&usage[key].as_f64().is_none_or(|value|!value.is_finite()||value<0.0){return Err("Speech usage estimates must be nonnegative or unavailable.".into());}}
    for key in ["characters","utf8Bytes","completedRequests","reusedSegments","uncertainRequests"]{if usage[key].as_u64().is_none(){return Err("Speech usage counts must be nonnegative integers.".into());}}
    for key in ["producedAudioSeconds","inputAudioSeconds"]{if usage[key].as_f64().is_none_or(|value|!value.is_finite()||value<0.0){return Err("Speech usage durations must be finite and nonnegative.".into());}}
    if !usage["currency"].is_null()&&usage["currency"].as_str().is_none_or(|currency|currency.len()!=3||!currency.bytes().all(|byte|byte.is_ascii_uppercase())){return Err("Speech usage currency must be an uppercase three-letter code.".into());}
    Ok(())
}

pub fn settle(transaction:&Transaction<'_>,job:&mut Value,uncertain:bool)->Result<(),String>{
    let id=job["id"].as_str().ok_or("The speech job identity is missing.")?;
    let reserved:Option<f64>=transaction.query_row("SELECT amount FROM speech_budget WHERE job_id=?1",[id],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
    if reserved.is_none(){return Ok(());}
    let data:String=transaction.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).map_err(|error|error.to_string())?;
    let snapshot:Value=serde_json::from_str(&data).map_err(|_|"The speech usage snapshot is damaged.")?;
    let resumed=snapshot["resumedSegments"].as_u64().ok_or("The admitted usage recovery position is missing.")? as usize;
    let completed=job["completedSegments"].as_u64().ok_or("The committed speech count is invalid.")? as usize;
    let total=job["totalSegments"].as_u64().ok_or("The speech request count is invalid.")? as usize;
    if resumed>completed||completed>total{return Err("The speech usage recovery position is inconsistent.".into());}
    let mut committed=Some(0.0);let mut possible=Some(0.0);let mut characters=0u64;let mut bytes=0u64;
    let mut requests=0usize;let mut reused=0usize;let mut audio=0.0;let mut input_audio=0.0;
    if matches!(snapshot["operation"].as_str(),Some("designVoice"|"createVoice")){
        let amount=if snapshot["estimate"].is_null(){None}else{Some(snapshot["estimate"].as_f64().filter(|value|value.is_finite()&&*value>=0.0).ok_or("The voice request estimate is damaged.")?)};
        if completed>resumed{
            committed=amount;requests=completed-resumed;
            characters=snapshot["characters"].as_u64().ok_or("The voice request character count is missing.")?;
            bytes=snapshot["textBytes"].as_u64().ok_or("The voice request byte count is missing.")?;
            audio=transaction.query_row("SELECT coalesce(sum(assets.duration),0.0) FROM speech_design_origins AS origin JOIN speech_design_candidates AS candidate ON candidate.id=origin.candidate_id JOIN assets ON assets.id=candidate.asset_id WHERE origin.job_id=?1",[id],|row|row.get(0)).map_err(|error|error.to_string())?;
        }
        if uncertain&&completed<total{possible=amount;}
    }else if snapshot["operation"]=="align"{
        if snapshot["reusedTimingId"].is_string(){reused=completed-resumed;}
        else{
            let plan=snapshot["chunks"].as_array().ok_or("The transcription usage windows are missing.")?;
            let windows=plan.get(resumed..completed).ok_or("The transcription usage position is invalid.")?;
            let at=chrono::DateTime::parse_from_rfc3339(snapshot["admittedAt"].as_str().ok_or("The transcription quote time is missing.")?).map_err(|_|"The transcription quote time is damaged.")?.date_naive();
            committed=if windows.is_empty(){Some(0.0)}else{super::transcript_timing::estimate(&snapshot["pricing"],windows,at)?};
            requests=windows.len();
            input_audio=windows.iter().map(|window|window["to"].as_f64().unwrap_or(0.0)-window["from"].as_f64().unwrap_or(0.0)).sum();
            if uncertain&&completed<total{possible=super::transcript_timing::estimate(&snapshot["pricing"],plan.get(completed..completed+1).ok_or("The uncertain transcription window is missing.")?,at)?;}
        }
    }else{
        let segments=snapshot["input"]["segments"].as_array().filter(|segments|!segments.is_empty()).ok_or("The speech usage segments are missing.")?;
        let takes=job["takeIds"].as_array().ok_or("The speech usage take log is missing.")?;
        for ordinal in resumed..completed{
            let take_id=takes.get(ordinal).and_then(Value::as_str).ok_or("The committed speech usage take is missing.")?;
            let data:String=transaction.query_row("SELECT data FROM takes WHERE id=?1",[take_id],|row|row.get(0)).map_err(|error|error.to_string())?;
            let take:Value=serde_json::from_str(&data).map_err(|_|"A committed speech usage take is damaged.")?;
            audio+=take["asset"]["duration"].as_f64().ok_or("A committed audio duration is invalid.")?;
            if take["reusedFromTakeId"].is_string(){reused+=1;continue;}
            let (unit_characters,unit_bytes)=text_counts(&snapshot,&segments[ordinal%segments.len()],false)?;
            characters+=unit_characters;bytes+=unit_bytes;requests+=1;
            committed=add(committed,text_cost(&snapshot,unit_characters,unit_bytes)?);
        }
        if uncertain&&completed<total{
            let (unit_characters,unit_bytes)=text_counts(&snapshot,&segments[completed%segments.len()],true)?;
            possible=text_cost(&snapshot,unit_characters,unit_bytes)?;
        }
    }
    let amount=committed.unwrap_or(0.0)+possible.unwrap_or(0.0);
    if !amount.is_finite()||amount<0.0{return Err("The settled speech estimate is invalid. Review its account rate.".into());}
    transaction.execute("UPDATE speech_budget SET amount=?2 WHERE job_id=?1",params![id,amount]).map_err(|error|error.to_string())?;
    job["usage"]=json!({"estimatedCommittedCost":committed,"estimatedUncertainCost":possible,"currency":snapshot["pricing"]["currency"],"pricing":snapshot["pricing"],"characters":characters,"utf8Bytes":bytes,"completedRequests":requests,"reusedSegments":reused,"uncertainRequests":usize::from(uncertain&&completed<total),"producedAudioSeconds":audio,"inputAudioSeconds":input_audio});
    Ok(())
}

fn add(left:Option<f64>,right:Option<f64>)->Option<f64>{left.zip(right).map(|(left,right)|left+right)}

fn text_counts(snapshot:&Value,segment:&Value,uncertain:bool)->Result<(u64,u64),String>{
    let direction=snapshot["profile"]["direction"].as_str().ok_or("The speech usage direction is missing.")?;
    let prefix=matches!(snapshot["profile"]["backend"].as_str(),Some("fish-cloud"|"sglang"|"drama3"))&&!direction.is_empty();
    let direction_characters=if prefix{direction.chars().count() as u64+2}else{0};
    let direction_bytes=if prefix{direction.len() as u64+2}else{0};
    if uncertain&&!snapshot["liveInput"].is_null(){
        let maximum=snapshot["liveInput"]["maximumCharacters"].as_u64().ok_or("The uncertain live reservation is missing.")?;
        return Ok((maximum+direction_characters,maximum*4+direction_bytes));
    }
    let text=super::contracts::provider_text(segment,&snapshot["profile"])?;
    Ok((text.chars().count() as u64+direction_characters,text.len() as u64+direction_bytes))
}

fn text_cost(snapshot:&Value,characters:u64,bytes:u64)->Result<Option<f64>,String>{
    if snapshot["profile"]["backend"]=="drama3"{return Ok(Some(0.0));}
    if characters==0&&bytes==0{return Ok(Some(0.0));}
    if snapshot["profile"]["backend"]!="fish-cloud"||snapshot["pricing"].is_null(){return Ok(None);}
    let price=&snapshot["pricing"];
    let count=match price["unit"].as_str(){Some("characters")=>characters,Some("utf8Bytes")=>bytes,_=>return Err("The pinned speech billing unit is invalid.".into())};
    let rate=price["perMillion"].as_f64().filter(|rate|rate.is_finite()&&*rate>=0.0).ok_or("The pinned speech rate is invalid.")?;
    Ok(Some(count as f64/1_000_000.0*rate))
}
