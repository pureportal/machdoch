use super::*;
use std::collections::{BTreeMap,HashMap};

pub fn records(manifest:&Value)->Result<&[Value],String>{
    match manifest.get("timingResults"){None=>Ok(&[]),Some(value)=>value.as_array().filter(|values|values.len()<=MAX_ITEMS).map(Vec::as_slice).ok_or("The archive timing inventory is invalid.".into())}
}

pub fn collect(
    store: &SpeechStore,
    takes: &[Value],
    budget: &mut super::portable::budget::ArchiveBudget,
) -> Result<Vec<Value>,String> {
    let mut records = BTreeMap::new();
    let mut visited = HashSet::new();
    for take in takes {
        let id = identifier(take, "id")?;
        if !visited.insert(id) { continue; }
        for record in super::portable::budget::records(&store.connection,
            "SELECT length(CAST(data AS BLOB)),data FROM speech_timings WHERE take_id=?1 ORDER BY created_at,id",
            [id], budget)? {
            timing_store::validate_record(&record, take)?;
            let id = identifier(&record, "id")?.to_owned();
            if records.insert(id, record).is_some() {
                return Err("The stored timing history contains duplicate identifiers.".into());
            }
        }
    }
    Ok(records.into_values().collect())
}

pub fn validate(manifest:&Value)->Result<(),String>{
    let takes:HashMap<_,_>=array(manifest,"takes",MAX_ITEMS)?.iter().map(|take|(take["id"].as_str().unwrap_or_default(),take)).collect();
    let mut by_id=HashMap::new();
    for record in records(manifest)?{
        let id=identifier(record,"id")?;
        if by_id.insert(id,record).is_some(){return Err("The archive has duplicate timing IDs.".into());}
        let take=takes.get(identifier(record,"takeId")?).ok_or("An archived timing take is missing.")?;
        timing_store::validate_record(record,take)?;
    }
    for record in by_id.values(){if let Some(id)=record["reusedFromTimingId"].as_str(){
        if id==record["id"].as_str().ok_or("A timing ID is invalid.")?{return Err("Timing cache lineage cannot refer to itself.".into());}
        let original=by_id.get(id).ok_or("An archived timing cache source is missing.")?;
        for field in ["takeId","assetId","assetSha256","provider","model","languageHint","transcript","words","measuredAt","requestHash","provenance","pricing","estimatedCost"]{if original[field]!=record[field]{return Err("The archived cached timing differs from its source evidence.".into());}}
        let mut seen=HashSet::new();let mut parent=Some(id);
        while let Some(id)=parent{if !seen.insert(id){return Err("Archived timing cache lineage contains a cycle.".into());}parent=by_id.get(id).ok_or("An archived timing cache source is missing.")?["reusedFromTimingId"].as_str();}
    }}
    for project in array(manifest,"revisions",MAX_ITEMS)?{
        for (take,id) in timing_store::selection_ids(project)?{
            let record=by_id.get(id).ok_or("A revision's selected word timing is missing from the archive.")?;
            if record["takeId"]!=take||takes.get(take).is_none_or(|take|take["projectId"]!=project["id"])||record["words"].as_array().is_none_or(Vec::is_empty){return Err("A revision selects timing without usable words for its own take.".into());}
        }
    }
    Ok(())
}

pub fn map_project(project:&mut Value,takes:&HashMap<String,String>,timings:&HashMap<String,String>)->Result<(),String>{
    let Some(selections)=project.get_mut("timingSelections")else{return Ok(())};
    let mut mapped=serde_json::Map::new();
    for (take,id) in selections.as_object().ok_or("Archived timing selections are invalid.")?{
        mapped.insert(takes.get(take).ok_or("An archived timing take is missing.")?.clone(),json!(timings.get(value_identifier(id)?).ok_or("An archived timing result is missing.")?));
    }
    *selections=Value::Object(mapped);Ok(())
}

pub fn map_record(record:&Value,takes:&HashMap<String,String>,timings:&HashMap<String,String>)->Result<Value,String>{
    let mut record=record.clone();
    record["id"]=json!(timings.get(identifier(&record,"id")?).ok_or("An archived timing ID is missing.")?);
    record["takeId"]=json!(takes.get(identifier(&record,"takeId")?).ok_or("An archived timing take is missing.")?);
    if let Some(id)=record["reusedFromTimingId"].as_str(){record["reusedFromTimingId"]=json!(timings.get(id).ok_or("An archived timing cache source is missing.")?);}
    Ok(record)
}
