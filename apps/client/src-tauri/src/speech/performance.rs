use serde_json::Value;

pub fn direction(original:&str,note:&str)->Result<String,String>{
    if note.trim().is_empty()||note.len()>4096||note.chars().any(|character|character.is_control()||matches!(character,'<'|'>'|'['|']')){
        return Err("Enter a single-line director note without speech control delimiters, within 4,096 UTF-8 bytes.".into());
    }
    let combined=if original.is_empty(){note.to_owned()}else{format!("{original}; {note}")};
    if combined.len()>32_768{return Err("Shorten the director note or choose a take with a shorter original direction; the combined local limit is 32,768 UTF-8 bytes.".into());}
    Ok(combined)
}

pub fn validate_origin(request:&Value,parent:&Value)->Result<(),String>{
    let note=request["performanceNote"].as_str().ok_or("The director note is missing.")?;
    let backend=request["profile"]["backend"].as_str().ok_or("The performance backend is missing.")?;
    if !matches!(backend,"fish-cloud"|"sglang"|"drama3")||request["profile"]["model"]!="drama-3"{return Err("Director notes require a verified Drama 3 performance backend.".into());}
    let expected=direction(parent["profile"]["direction"].as_str().ok_or("The original direction is missing.")?,note)?;
    if request["profile"]["direction"]!=expected{return Err("The new performance direction differs from its original and director note.".into());}
    let mut original_profile=parent["profile"].as_object().ok_or("The original profile is invalid.")?.clone();
    let mut profile=request["profile"].as_object().ok_or("The performance profile is invalid.")?.clone();
    original_profile.remove("direction");profile.remove("direction");
    if profile!=original_profile{return Err("Director regeneration must preserve the original voice and generation settings.".into());}
    let mut original_segment=parent["segment"].as_object().ok_or("The original segment is invalid.")?.clone();
    original_segment.remove("liveFragments");
    if request["segment"]!=Value::Object(original_segment){return Err("Director regeneration must preserve the original script and cast.".into());}
    for field in ["dictionaries","references","connection"]{if request[field]!=parent[field]{return Err("Director regeneration must preserve the original pronunciation, references and connection.".into());}}
    Ok(())
}
