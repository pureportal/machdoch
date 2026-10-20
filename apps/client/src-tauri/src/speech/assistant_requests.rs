use serde_json::{json,Value};

pub fn prepare_segment(segment:&Value,profile:&Value)->Result<Value,String>{
    let backend=profile["backend"].as_str().ok_or("Choose a speech backend.")?;
    if !matches!(backend,"openai"|"google"){
        if segment.get("assistantRequest").is_some(){return Err("Remove assistant request parameters from this backend's speech segment.".into());}
        return Ok(segment.clone());
    }
    let text=super::contracts::provider_text(segment,profile)?;
    if backend=="openai"&&text.chars().count()>4096{return Err("Shorten this OpenAI speech segment to 4,096 characters or split it at sentence boundaries.".into());}
    let direction=profile["direction"].as_str().ok_or("Supply the speech profile direction.")?;
    let request=if backend=="openai"{openai(&text,direction)}else{google(&text,direction,profile["language"].as_str())};
    if segment.get("assistantRequest").is_some_and(|value|*value!=request){return Err("The pinned assistant request differs from its profile and transcript. Submit a newly compiled render.".into());}
    let mut prepared=segment.clone();prepared["assistantRequest"]=request;
    Ok(prepared)
}

pub(super) fn openai(text:&str,direction:&str)->Value{
    json!({"model":"gpt-4o-mini-tts","voice":"cedar","input":text,"instructions":direction,"response_format":"wav","speed":1.0})
}

pub(super) fn google(text:&str,direction:&str,language:Option<&str>)->Value{
    let mut speech_config=json!({"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}});
    if let Some(language)=language.filter(|value|!value.is_empty()){speech_config["languageCode"]=json!(language);}
    let prompt=if direction.is_empty(){format!("### TRANSCRIPT\n{text}")}else{format!("### DELIVERY\n{direction}\n\n### TRANSCRIPT\n{text}")};
    json!({
        "systemInstruction":{"parts":[{"text":"You are a text-to-speech model. Generate speech audio only. Speak only the transcript content. Do not speak section labels or instructions."}]},
        "contents":[{"parts":[{"text":prompt}]}],
        "generationConfig":{"responseModalities":["AUDIO"],"speechConfig":speech_config}
    })
}

#[cfg(test)]
mod tests{
    use super::*;

    #[test]
    fn assistant_requests_keep_direction_separate_from_the_transcript_and_playback_rate(){
        let text="Guten Tag. 東京 🚀";let direction="quiet, thoughtful";
        let openai=openai(text,direction);
        assert_eq!(openai["input"],text);assert_eq!(openai["instructions"],direction);assert_eq!(openai["speed"],1.0);
        for key in ["language","normalize","temperature","top_p","chunk_length","pronunciation_dictionary"]{assert!(openai.get(key).is_none());}
        let google=google(text,direction,Some("de-DE"));
        assert_eq!(google["contents"][0]["parts"][0]["text"],format!("### DELIVERY\n{direction}\n\n### TRANSCRIPT\n{text}"));
        assert_eq!(google["generationConfig"]["speechConfig"]["languageCode"],"de-DE");
        for key in ["temperature","topP","speed","normalize"]{assert!(google["generationConfig"].get(key).is_none());}
    }

    #[test]
    fn unset_language_and_direction_stay_unset(){
        let request=google("Spoken words.","",None);
        assert!(request["generationConfig"]["speechConfig"].get("languageCode").is_none());
        assert_eq!(request["contents"][0]["parts"][0]["text"],"### TRANSCRIPT\nSpoken words.");
        assert_eq!(openai("Spoken words.","")["instructions"],"");
    }
}
