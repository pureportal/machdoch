use super::store::SpeechStore;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

pub fn schema(store: &SpeechStore) -> Result<(), String> {
    store.connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_live_inputs(job_id TEXT PRIMARY KEY REFERENCES jobs(id),maximum_characters INTEGER NOT NULL,characters INTEGER NOT NULL,next_sequence INTEGER NOT NULL,consumed_sequence INTEGER NOT NULL,finished INTEGER NOT NULL CHECK(finished IN(0,1)),answer_revision TEXT,final_text TEXT);
        CREATE TABLE IF NOT EXISTS speech_live_fragments(job_id TEXT NOT NULL REFERENCES speech_live_inputs(job_id),sequence INTEGER NOT NULL,text TEXT NOT NULL,finished INTEGER NOT NULL CHECK(finished IN(0,1)),PRIMARY KEY(job_id,sequence));").map_err(|error|error.to_string())
}

pub fn validate_text(text: &str) -> Result<(), String> {
    if text.is_empty() || text.len()>16_384 || text.chars().count()>4096 || text.chars().any(|value|matches!(value,'<'|'>'|'['|']')||value.is_control()) {
        return Err("Send 1 to 4,096 literal speech characters without markup or control characters per live fragment.".into());
    }
    Ok(())
}

pub fn ensure_snapshot_capacity(initial_bytes:usize,maximum_characters:u64)->Result<(),String>{
    let final_transcripts=maximum_characters.checked_mul(4*2);
    let fragment_log=maximum_characters.checked_mul(4+3);
    let maximum=final_transcripts.and_then(|text|fragment_log.and_then(|fragments|text.checked_add(fragments))).and_then(|growth|growth.checked_add(32)).and_then(|growth|growth.checked_add(initial_bytes as u64));
    if maximum.is_none_or(|bytes|bytes>super::store::MAX_METADATA_BYTES as u64){return Err("The live answer can exceed the local 16 MiB take snapshot limit. Reduce dictionaries/references or the live character limit before rendering.".into());}
    Ok(())
}

pub fn append(store: &mut SpeechStore, input: &Value) -> Result<Value,String> {
    let object=input.as_object().ok_or("Supply a live speech fragment.")?;
    if object.keys().any(|key|!matches!(key.as_str(),"jobId"|"owner"|"sequence"|"text"|"finish"|"answerRevision"|"finalText")){return Err("Unknown live input field.".into());}
    let id=input["jobId"].as_str().ok_or("Choose a live speech job.")?;
    let owner=input["owner"].as_str().ok_or("Supply the speech owner.")?;
    let sequence=input["sequence"].as_u64().filter(|value|*value<i64::MAX as u64).ok_or("Use a nonnegative live sequence.")? as i64;
    let text=input["text"].as_str().ok_or("Supply the literal live fragment.")?;
    let finish=input["finish"].as_bool().ok_or("Choose whether this ends the answer.")?;
    if !text.is_empty(){validate_text(text)?;}
    if text.is_empty()&&!finish{return Err("Send text or finish the live answer.".into());}
    let revision=if finish {Some(input["answerRevision"].as_str().filter(|value|!value.is_empty()&&value.len()<=128&&value.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"_-".contains(&byte))).ok_or("Include the completed answer revision.")?)} else {None};
    let final_text=if finish {Some(input["finalText"].as_str().filter(|value|!value.is_empty()&&value.len()<=4*1024*1024).ok_or("Include the complete literal answer transcript.")?)}else{None};
    if !finish&&(input.get("answerRevision").is_some()||input.get("finalText").is_some()){return Err("Complete the answer before supplying its final revision.".into());}
    let transaction=store.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
    let (job_owner,state,cancelling):(String,String,bool)=transaction.query_row("SELECT owner,state,json_type(data,'$.cancelRequestedAt')='text' FROM jobs WHERE id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get::<_,Option<bool>>(2)?.unwrap_or(false)))).map_err(|_|"The live speech job is missing.")?;
    if job_owner!=owner{return Err("This live speech job belongs to another owner.".into());}
    if cancelling{return Err("This live speech job is cancelling. Replay the completed answer deliberately.".into());}
    let (maximum,characters,next,consumed,closed):(i64,i64,i64,i64,bool)=transaction.query_row("SELECT maximum_characters,characters,next_sequence,consumed_sequence,finished FROM speech_live_inputs WHERE job_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|_|"This job does not accept live input.")?;
    if sequence<next {
        let previous:(String,bool)=transaction.query_row("SELECT text,finished FROM speech_live_fragments WHERE job_id=?1 AND sequence=?2",params![id,sequence],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|error|error.to_string())?;
        if previous!=(text.to_owned(),finish){return Err("This live sequence was already committed with different content. Stop and replay the corrected answer.".into());}
        if finish {
            let original:(Option<String>,Option<String>)=transaction.query_row("SELECT answer_revision,final_text FROM speech_live_inputs WHERE job_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|error|error.to_string())?;
            if original!=(revision.map(str::to_owned),final_text.map(str::to_owned)){return Err("The completed live answer changed. Stop and replay the corrected answer.".into());}
        }
        return Ok(json!({"accepted":true,"nextSequence":next,"finished":closed}));
    }
    if !matches!(state.as_str(),"queued"|"running")||closed{return Err("The live speech job no longer accepts text. Replay the completed answer deliberately.".into());}
    if sequence!=next{return Err("Append live answer fragments in sequence.".into());}
    let count=text.chars().count() as i64;
    if characters+count>maximum{return Err("This answer reached the reserved speech limit. Read a shorter selection or change the answer limit in Text to Speech.".into());}
    if next-consumed>=8{return Ok(json!({"accepted":false,"nextSequence":next,"finished":false}));}
    if let Some(expected)=final_text {
        let mut statement=transaction.prepare("SELECT text FROM speech_live_fragments WHERE job_id=?1 ORDER BY sequence").map_err(|error|error.to_string())?;
        let rows=statement.query_map([id],|row|row.get::<_,String>(0)).map_err(|error|error.to_string())?;
        let mut delivered=String::new();
        for row in rows{delivered.push_str(&row.map_err(|error|error.to_string())?);}
        delivered.push_str(text);
        if delivered.trim()!=expected{return Err("The completed answer differs from the committed speech. Stop and replay the corrected answer.".into());}
    }
    transaction.execute("INSERT INTO speech_live_fragments(job_id,sequence,text,finished) VALUES(?1,?2,?3,?4)",params![id,sequence,text,finish]).map_err(|error|error.to_string())?;
    transaction.execute("UPDATE speech_live_inputs SET characters=?2,next_sequence=?3,finished=?4,answer_revision=?5,final_text=?6 WHERE job_id=?1",params![id,characters+count,next+1,finish,revision,final_text]).map_err(|error|error.to_string())?;
    transaction.commit().map_err(|error|error.to_string())?;
    Ok(json!({"accepted":true,"nextSequence":next+1,"finished":finish}))
}

pub fn consume(store: &mut SpeechStore, id: &str) -> Result<Option<(String,bool)>,String> {
    let transaction=store.connection.transaction().map_err(|error|error.to_string())?;
    let value:Option<(i64,String,bool)>=transaction.query_row("SELECT f.sequence,f.text,f.finished FROM speech_live_fragments f JOIN speech_live_inputs l ON l.job_id=f.job_id WHERE f.job_id=?1 AND f.sequence=l.consumed_sequence",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|error|error.to_string())?;
    if let Some((sequence,_,_))=&value{transaction.execute("UPDATE speech_live_inputs SET consumed_sequence=?2 WHERE job_id=?1",params![id,sequence+1]).map_err(|error|error.to_string())?;}
    transaction.commit().map_err(|error|error.to_string())?;
    Ok(value.map(|(_,text,finished)|(text,finished)))
}

pub fn completed_segment(store: &SpeechStore,id: &str,initial: &Value) -> Result<Value,String> {
    let (finished,next,consumed):(bool,i64,i64)=store.connection.query_row("SELECT finished,next_sequence,consumed_sequence FROM speech_live_inputs WHERE job_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|error|error.to_string())?;
    if !finished||next!=consumed{return Err("The live answer has not consumed a complete input log.".into());}
    let mut statement=store.connection.prepare("SELECT text FROM speech_live_fragments WHERE job_id=?1 AND length(text)>0 ORDER BY sequence").map_err(|error|error.to_string())?;
    let fragments=statement.query_map([id],|row|row.get::<_,String>(0)).map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
    let mut segment=initial.clone();
    let text=fragments.concat();
    segment["text"]=json!(text);
    segment["spokenText"]=json!(text.trim());
    segment["liveFragments"]=json!(fragments);
    Ok(segment)
}

#[cfg(test)]
#[path="live_input_tests.rs"]
mod tests;
