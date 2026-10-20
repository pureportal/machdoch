use super::*;

pub(super) fn validate_take_request(take: &Value, request: &Value) -> Result<(), String> {
    bounded_record(request)?;
    fields(request,&["segment","profile","dictionaries","references","connection","performanceNote"])?;
    if let Some(note)=request.get("performanceNote"){
        identifier(take,"parentTakeId")?;
        super::super::performance::direction("",note.as_str().ok_or("The director note must be text.")?)?;
    }
    validate_profile(&request["profile"])?;
    if request["profile"]["backend"] != take["backend"] || request["profile"]["model"] != take["model"] { return Err("The take's generation model differs from its request.".into()); }
    let segment = &request["segment"];
    fields(segment,&["id","text","spokenText","chapter","voiceIds","referenceAssetIds","referenceGroups","liveFragments","assistantRequest"])?;
    if super::super::assistant_requests::prepare_segment(segment,&request["profile"])?!=*segment{return Err("The saved assistant request is missing its exact provider parameters.".into());}
    super::super::contracts::validate_segment_references(segment,&request["profile"])?;
    for key in ["id","spokenText","chapter"] { if segment[key] != take[if key=="id" {"segmentId"} else {key}] { return Err("The take differs from its submitted script segment.".into()); } }
    text(segment,"text",1,2*1024*1024)?;
    for id in array(segment,"voiceIds",256)? { if id.as_str().is_none_or(|value|value.is_empty()||value.len()>256||value.chars().any(char::is_control)) { return Err("A submitted voice ID is invalid.".into()); } }
    if let Some(observations)=take["voiceObservations"].as_array(){
        let expected=SpeechStore::segment_voice_observations(&json!({"profile":request["profile"],"voiceObservations":observations}),segment)?;
        if expected!=take["voiceObservations"]{return Err("The take voice observations do not belong to its generation voices.".into());}
    }
    let dictionaries = array(request,"dictionaries",256)?;
    for dictionary in dictionaries { validate_dictionary(dictionary)?; }
    let expected:HashSet<_> = array(&request["profile"],"dictionaryIds",256)?.iter().map(Value::as_str).collect();
    let actual:HashSet<_> = dictionaries.iter().map(|dictionary|dictionary["id"].as_str()).collect();
    if expected != actual || actual.len() != dictionaries.len() { return Err("The pronunciation snapshot differs from its generation profile.".into()); }
    let references = request["references"].as_object().filter(|values|values.len()<=256).ok_or("The take reference snapshot is invalid.")?;
    let ids = array(segment,"referenceAssetIds",256)?;
    let expected:HashSet<_> = ids.iter().map(asset_identifier).collect::<Result<_,_>>()?;
    if expected.len()!=references.len() || expected.iter().any(|id|!references.contains_key(*id)) { return Err("The generation reference snapshot is incomplete.".into()); }
    for (id,reference) in references {
        fields(reference,&["assetId","sha256","transcript","rights"])?;
        if reference["assetId"] != *id || reference["sha256"] != *id { return Err("A generation reference failed its identity check.".into()); }
        if text(reference,"transcript",1,65_536)?.trim().is_empty() || text(reference,"rights",1,32_768)?.trim().is_empty() { return Err("A generation reference needs its transcript and permission evidence.".into()); }
    }
    let connection = &request["connection"];
    fields(connection,&["backend","model","url","runtimeVersion"])?;
    if connection["backend"] != take["backend"] || connection["model"] != take["model"] { return Err("The generation connection differs from the take's provider.".into()); }
    nullable_text(connection,"url",32_768)?;
    nullable_text(connection,"runtimeVersion",512)?;
    if let Some(value) = connection["url"].as_str() {
        let url=url::Url::parse(value).map_err(|_|"The generation endpoint is invalid.")?;
        if !matches!(url.scheme(),"http"|"https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err("The generation endpoint must not include credentials, query parameters or fragments.".into()); }
    }
    if super::super::cache::request_hash(segment,&request["profile"],&request["dictionaries"],&request["references"],connection)? != take["requestHash"] { return Err("The take request hash does not match its immutable generation snapshot.".into()); }
    Ok(())
}
