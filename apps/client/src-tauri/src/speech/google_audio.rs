use base64::{engine::general_purpose::STANDARD,Engine};
use serde_json::Value;
use std::collections::HashSet;

pub fn pcm(response:&Value)->Result<Vec<u8>,String>{
    if response["promptFeedback"]["blockReason"].as_str().is_some_and(|value|value!="BLOCK_REASON_UNSPECIFIED"){return Err("Google blocked this speech request. Review the text and account policy before retrying.".into());}
    let candidates=response["candidates"].as_array().filter(|values|values.len()==1).ok_or("Google returned no single speech performance. Review usage before retrying.")?;
    let candidate=&candidates[0];
    if candidate["finishReason"]!="STOP"{return Err("Google did not finish the speech performance. Review usage before retrying.".into());}
    let parts=candidate["content"]["parts"].as_array().filter(|values|!values.is_empty()&&values.len()<=10_000).ok_or("Google returned no complete audio content. Review usage before retrying.")?;
    let mut pcm=Vec::new();
    for part in parts{
        if part["thought"]==true||part.get("thought").is_some_and(|value|!value.is_boolean())||part.get("thoughtSignature").is_some(){return Err("Google returned internal content in the speech output. Review usage before retrying.".into());}
        if ["text","functionCall","functionResponse","toolCall","toolResponse","executableCode","codeExecutionResult","fileData"].iter().any(|field|!part[*field].is_null()){return Err("Google returned unexpected non-audio speech content. Review usage before retrying.".into());}
        let inline=&part["inlineData"];
        mime(inline["mimeType"].as_str().ok_or("Google did not identify its speech audio format.")?)?;
        let audio=STANDARD.decode(inline["data"].as_str().filter(|value|!value.is_empty()).ok_or("Google returned empty audio data.")?).map_err(|_|"Google returned invalid speech audio encoding.")?;
        if audio.len()>48*1024*1024-pcm.len(){return Err("Google audio exceeded the local 48 MiB decoded-response guard.".into());}
        pcm.extend_from_slice(&audio);
    }
    super::pcm::wav_header(pcm.len() as u64)?;Ok(pcm)
}

fn mime(value:&str)->Result<(),String>{
    let mut parts=value.split(';');
    if parts.next().is_none_or(|value|!value.trim().eq_ignore_ascii_case("audio/l16")){return Err("Google returned a different audio format from the selected model's 24 kHz PCM contract.".into());}
    let mut known=HashSet::new();
    for part in parts{
        let (name,value)=part.trim().split_once('=').ok_or("Google returned invalid speech format parameters.")?;
        let name=name.to_ascii_lowercase();let value=value.trim();
        if !known.insert(name.clone())||!match name.as_str(){"rate"=>value=="24000","channels"=>value=="1","codec"=>value.eq_ignore_ascii_case("pcm"),_=>false}{return Err("Google speech format differs from the selected model's 24 kHz mono PCM contract.".into());}
    }
    Ok(())
}

#[cfg(test)]
#[path="google_audio_tests.rs"]
mod tests;
