use super::store::SpeechStore;
use rusqlite::{params, OptionalExtension};

#[derive(Clone)]
pub struct StreamFile{pub path:std::path::PathBuf,pub sample_rate:Option<u32>,pub channels:Option<u16>}

pub fn completed_asset(store:&SpeechStore,owner:&str,job_id:&str,segment_id:&str)->Result<Option<String>,String>{
    let record:Option<(String,Option<String>,Option<String>,bool)>=store.connection.query_row(
        "SELECT jobs.state,json_extract(jobs.data,'$.error'),json_extract(request.snapshot,'$.profile.backend'),EXISTS(SELECT 1 FROM json_each(request.snapshot,'$.input.segments') AS segment WHERE json_extract(segment.value,'$.id')=?3) FROM jobs JOIN speech_requests AS request ON request.job_id=jobs.id WHERE jobs.id=?1 AND jobs.owner=?2",
        params![job_id,owner,segment_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(|error|error.to_string())?;
    let (state,error,backend,contains_segment)=record.ok_or("This speech stream is unavailable to the requesting owner.")?;
    if matches!(state.as_str(),"failed"|"cancelled"|"uncertain"|"interrupted"){
        return Err(error.unwrap_or_else(||"The speech stream is no longer active.".into()));
    }
    if !matches!(backend.as_deref(),Some("fish-cloud"|"sglang")){
        return Err("Live PCM playback is unavailable for this backend. Play its completed audio asset.".into());
    }
    if !contains_segment{return Err("Choose a segment from this speech job.".into());}
    let asset:Option<String>=store.connection.query_row(
        "SELECT takes.asset_id FROM takes JOIN job_takes ON job_takes.take_id=takes.id WHERE job_takes.job_id=?1 AND json_extract(takes.data,'$.segmentId')=?2 ORDER BY takes.created_at,takes.id LIMIT 1",
        params![job_id,segment_id],|row|row.get(0),
    ).optional().map_err(|error|error.to_string())?;
    if asset.as_deref().is_some_and(|id|id.len()!=64||!id.bytes().all(|byte|byte.is_ascii_hexdigit())){
        return Err("The stream asset ID is invalid.".into());
    }
    if state=="completed"&&asset.is_none(){return Err("The completed speech job is missing this segment's audio. Review it in Jobs.".into());}
    Ok(asset)
}
