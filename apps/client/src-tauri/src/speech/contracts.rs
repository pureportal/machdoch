use serde_json::Value;

pub fn validate_segment_references(segment:&Value,profile:&Value)->Result<(),String>{
    let fields=segment.as_object().ok_or("Supply a compiled speech segment.")?;
    if fields.keys().any(|field|!matches!(field.as_str(),"id"|"text"|"spokenText"|"chapter"|"voiceIds"|"referenceAssetIds"|"referenceGroups"|"liveFragments"|"assistantRequest")){return Err("Remove unsupported settings from the compiled speech segment.".into());}
    let backend=profile["backend"].as_str().ok_or("Choose a speech backend.")?;
    if let Some(fragments)=segment.get("liveFragments"){
        let fragments=fragments.as_array().filter(|values|!values.is_empty()&&values.len()<=100_000).ok_or("Include the exact live fragment log.")?;
        let mut text=String::new();
        for fragment in fragments{let fragment=fragment.as_str().ok_or("A live fragment is invalid.")?;super::live_input::validate_text(fragment)?;text.push_str(fragment);if text.len()>2*1024*1024{return Err("The live fragment log exceeds the request guard.".into());}}
        if backend!="fish-cloud"||segment["text"]!=text||segment["spokenText"]!=text.trim(){return Err("The live request differs from its exact fragment log.".into());}
    }
    let voices=segment["voiceIds"].as_array().ok_or("Supply the segment voice list.")?;
    let references=segment["referenceAssetIds"].as_array().ok_or("Supply the segment reference list.")?;
    if matches!(backend,"openai"|"google")&&(!references.is_empty()||voices.iter().any(|voice|voice!=&profile["voiceId"])){return Err("This backend supports its configured assistant voice. Choose that voice and remove cloning references.".into());}
    if backend=="sglang"&&(!voices.is_empty()||references.is_empty()||profile["voiceId"].as_str().is_some_and(|voice|!voice.is_empty())){return Err("Bind reference recordings for the selected self-hosted runtime. Fish library voice IDs require Fish Cloud.".into());}
    if backend=="drama3"&&(!voices.is_empty()||profile["voiceId"].as_str().is_some_and(|voice|!voice.is_empty())){return Err("Use reference recordings for local voice cloning. Fish library voices require Fish Cloud.".into());}
    if !voices.is_empty()&&!references.is_empty(){return Err("Choose either stored voice IDs or inline reference sets for this request.".into());}
    let mut slots=voices.len().max(1);
    if let Some(groups)=segment.get("referenceGroups"){
        if !matches!(backend,"fish-cloud"|"drama3"){return Err("Grouped inline dialogue references require the verified Fish Cloud contract.".into());}
        let groups=groups.as_array().filter(|groups|groups.len()>1&&groups.len()<=if backend=="drama3"{16}else{256}).ok_or("Use one nonempty reference group for each dialogue speaker.")?;
        if !voices.is_empty(){return Err("Use stored voices or grouped references for every dialogue speaker.".into());}
        let flattened:Vec<&Value>=groups.iter().map(|group|group.as_array().filter(|ids|!ids.is_empty()&&ids.len()<=256).ok_or("Every dialogue speaker needs a reference set.")).collect::<Result<Vec<_>,_>>()?.into_iter().flatten().collect();
        if flattened!=references.iter().collect::<Vec<_>>(){return Err("The reference groups must preserve the exact ordered segment reference inventory.".into());}
        slots=groups.len();
    }
    if let Some(text)=segment["text"].as_str(){
        for cue in text.split("<|speaker:").skip(1){
            let index=cue.split("|>").next().and_then(|index|index.parse::<usize>().ok()).ok_or("A speaker cue is invalid.")?;
            if index>=slots{return Err("A speaker cue has no matching voice or reference group.".into());}
        }
    }
    Ok(())
}

pub fn validate_profile(profile:&Value)->Result<(),String>{
    let backend=profile["backend"].as_str().ok_or("Choose a speech backend.")?;
    if matches!(backend,"fish-cloud"|"sglang"|"drama3")&&profile["model"]!="drama-3"{return Err("This speech backend requires Drama 3.".to_string())}
    if matches!(backend,"fish-cloud"|"drama3"){
        for field in ["temperature","topP"]{if profile[field].as_f64().filter(|value|value.is_finite()&&(0.0..=1.0).contains(value)).is_none(){return Err(format!("Use {field} from 0 to 1."))}}
    }
    if backend=="fish-cloud"{
        if profile["chunkLength"].as_u64().filter(|value|(100..=300).contains(value)).is_none()||profile["minChunkLength"].as_u64().filter(|value|*value<=100).is_none(){return Err("Use chunk length 100–300 and minimum chunk length 0–100.".to_string())}
        if profile["dictionaryIds"].as_array().filter(|values|values.len()<=3).is_none(){return Err("Use up to three pronunciation dictionaries.".to_string())}
        if let Some(language)=profile["language"].as_str(){if language.len()>35||!language.bytes().all(|value|value.is_ascii_alphanumeric()||b"_-".contains(&value)){return Err("Use a normalization language tag of at most 35 letters, digits, hyphens or underscores, or leave it empty for mixed-language text.".into());}}
        if profile.get("normalize").is_some_and(|value|!value.is_boolean()){return Err("Choose whether to normalize text.".into());}
    }else{
        if profile.get("normalize").is_some(){return Err("Text normalization control requires Fish Cloud. Remove it for this backend.".into());}
        if profile["dictionaryIds"].as_array().is_none_or(|ids|!ids.is_empty()){return Err("This backend has no verified pronunciation-dictionary contract. Use Fish Cloud for dictionaries.".into());}
        if profile["chunkLength"].as_u64()!=Some(300)||profile["minChunkLength"].as_u64()!=Some(50)||profile["latency"]!="normal"{return Err("This backend has no chunking or latency controls. Use the profile defaults (300, 50 and normal).".into());}
        if !matches!(backend,"sglang"|"drama3")&&(profile["temperature"].as_f64()!=Some(0.7)||profile["topP"].as_f64()!=Some(0.7)){return Err("This assistant backend has no configured sampling controls. Use the profile defaults (0.7 and 0.7).".into());}
        if backend!="google"&&profile["language"].as_str().is_some_and(|value|!value.is_empty()){return Err("This backend does not accept a language setting. Leave it empty and write the intended spoken language in the script.".into());}
    }
    if matches!(backend,"openai"|"google"){
        let (model,voice)=if backend=="openai"{("gpt-4o-mini-tts","cedar")}else{("gemini-3.1-flash-tts-preview","Kore")};
        if profile["model"]!=model||profile["voiceId"]!=voice{return Err("Use this provider's configured assistant model and voice.".into());}
        if backend=="google"{if let Some(language)=profile["language"].as_str().filter(|value|!value.is_empty()){if !GOOGLE_SPEECH_LANGUAGES.contains(&language){return Err("Choose a documented Google speech language or leave it empty for automatic detection.".into());}}}
    }
    if profile["direction"].as_str().unwrap_or("").contains(['<','>','[',']','\r','\n']){return Err("Use plain speech direction without control delimiters.".to_string())}
    Ok(())
}

const GOOGLE_SPEECH_LANGUAGES:[&str;30]=["de-DE","en-AU","en-GB","en-IN","en-US","es-US","fr-FR","hi-IN","pt-BR","ar-XA","es-ES","fr-CA","id-ID","it-IT","ja-JP","tr-TR","vi-VN","bn-IN","gu-IN","kn-IN","ml-IN","mr-IN","ta-IN","te-IN","nl-NL","ko-KR","cmn-CN","pl-PL","ru-RU","th-TH"];

pub fn provider_text(segment:&Value,profile:&Value)->Result<String,String>{
    let text=segment["text"].as_str().ok_or("Supply compiled speech text.")?;
    if !matches!(profile["backend"].as_str(),Some("openai"|"google")){return Ok(text.into());}
    let mut plain=String::with_capacity(text.len());let mut remaining=text;
    while let Some(start)=remaining.find("<|speaker:"){
        plain.push_str(&remaining[..start]);
        let cue=&remaining[start+10..];let end=cue.find("|>").ok_or("A compiled speaker cue is incomplete.")?;
        if cue[..end].is_empty()||!cue[..end].bytes().all(|value|value.is_ascii_digit()){return Err("A compiled speaker cue is invalid.".into());}
        remaining=&cue[end+2..];
    }
    plain.push_str(remaining);
    if plain.contains(['<','>','[',']']){return Err("Choose Drama 3 for performance markup, or use plain text with the speech profile direction for this provider.".into());}
    if plain.trim()!=segment["spokenText"].as_str().ok_or("Supply the compiled spoken transcript.")?{return Err("The compiled text differs from the spoken transcript. Recompile the script before rendering.".into());}
    Ok(plain)
}

#[cfg(test)]
#[path="provider_controls_tests.rs"]
mod provider_controls_tests;

#[cfg(test)]
mod tests{
    use super::*;
    use serde_json::json;
    #[test]
    fn reference_groups_preserve_cast_order_and_reject_missing_or_ambiguous_bindings(){
        let profile=json!({"backend":"fish-cloud"});
        let valid=json!({"text":"<|speaker:0|>Hello.<|speaker:1|>Hallo.","voiceIds":[],"referenceAssetIds":["a","b","c"],"referenceGroups":[["a"],["b","c"]]});
        validate_segment_references(&valid,&profile).unwrap();
        let mut flattened=valid.clone();flattened.as_object_mut().unwrap().remove("referenceGroups");
        assert!(validate_segment_references(&flattened,&profile).unwrap_err().contains("no matching"));
        let mut wrong=valid.clone();wrong["referenceGroups"]=json!([["b","a"],["c"]]);
        assert!(validate_segment_references(&wrong,&profile).is_err());
        let mut mixed=valid.clone();mixed["voiceIds"]=json!(["stored"]);
        assert!(validate_segment_references(&mixed,&profile).is_err());
    }
    #[test]
    fn explicit_backend_choice_never_substitutes_unsupported_voices_or_reference_contracts(){
        let local=json!({"backend":"sglang"});
        let inline=json!({"text":"<|speaker:0|>Hello.","voiceIds":[],"referenceAssetIds":["a"]});
        validate_segment_references(&inline,&local).unwrap();
        let stored=json!({"text":"Hello.","voiceIds":["fish-voice"],"referenceAssetIds":[]});
        assert!(validate_segment_references(&stored,&local).is_err());
        assert!(validate_segment_references(&stored,&json!({"backend":"openai","voiceId":"cedar"})).is_err());
        let assistant=json!({"text":"Hello.","voiceIds":["cedar"],"referenceAssetIds":[]});
        validate_segment_references(&assistant,&json!({"backend":"openai","voiceId":"cedar"})).unwrap();
    }
}
