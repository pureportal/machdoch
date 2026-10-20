use serde_json::{json,Value};
use sha2::{Digest,Sha256};

pub fn normalize(value:&Value,favorite:bool,at:&str)->Result<Value,String>{
    let id=value["_id"].as_str().filter(|id|!id.is_empty()&&id.len()<=128&&id.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"_-".contains(&byte))).ok_or("Fish returned an invalid voice ID.")?;
    let name=value["title"].as_str().filter(|name|!name.trim().is_empty()&&name.chars().count()<=200&&!name.chars().any(char::is_control)).ok_or("Fish returned an invalid voice name.")?;
    let visibility=value["visibility"].as_str().filter(|visibility|matches!(*visibility,"private"|"unlist"|"public")).ok_or("Fish returned an invalid voice visibility.")?;
    let languages=value["languages"].as_array().filter(|languages|languages.len()<=256).ok_or("Fish returned an invalid voice language list.")?;
    if languages.iter().any(|language|language.as_str().is_none_or(|language|language.is_empty()||language.len()>35||language.chars().any(char::is_control))){return Err("Fish returned an invalid voice language tag.".into());}
    let preview=value["samples"].as_array().and_then(|samples|samples.first()).and_then(|sample|sample["audio"].as_str());
    if let Some(preview)=preview{
        let url=url::Url::parse(preview).map_err(|_|"Fish returned an invalid voice preview URL.")?;
        if url.scheme()!="https"||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some(){return Err("Fish returned an unsafe voice preview URL.".into());}
    }
    let optional=|value:&Value,maximum:usize|->Result<Value,String>{
        if value.is_null(){return Ok(Value::Null);}
        let text=value.as_str().filter(|text|text.len()<=maximum&&!text.chars().any(char::is_control)).ok_or("Fish returned invalid voice source metadata.")?;Ok(json!(text))
    };
    let author=optional(&value["author"]["nickname"],512)?;
    let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(value).map_err(|_|"Fish voice metadata could not be hashed.")?));
    Ok(json!({"id":id,"name":name,"author":author,"languages":languages,"visibility":visibility,"previewUrl":preview,
        "rights":if value["licensed"]==true{json!("Fish reports licensed voice-owner rights; verify the account's output-use terms.")}else{Value::Null},"favorite":favorite,
        "evidence":{"provider":"fish-cloud","url":format!("https://api.fish.audio/model/{id}"),"observedAt":at,"responseSha256":hash,
            "authorId":optional(&value["author"]["_id"],128)?,"source":optional(&value["source"],128)?,
            "providerCreatedAt":optional(&value["created_at"],128)?,"providerUpdatedAt":optional(&value["updated_at"],128)?}}))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn voice_metadata_preserves_available_source_evidence_without_inventing_rights_or_an_immutable_model_version(){
        let response=json!({"_id":"voice","title":"Voice","languages":["de"],"visibility":"private","samples":[],"author":{"_id":"author","nickname":"Owner"},"source":"voice_design","created_at":"2026-10-20T00:00:00Z","updated_at":"2026-10-20T01:00:00Z"});
        let voice=normalize(&response,false,"2026-10-20T02:00:00Z").unwrap();assert_eq!(voice["author"],"Owner");assert!(voice["rights"].is_null());assert_eq!(voice["evidence"]["source"],"voice_design");assert_eq!(voice["evidence"]["providerUpdatedAt"],response["updated_at"]);assert_eq!(voice["evidence"]["responseSha256"].as_str().unwrap().len(),64);assert!(voice["evidence"].get("modelVersion").is_none());
        let mut public=response;public["visibility"]=json!("public");public["licensed"]=json!(true);let public=normalize(&public,true,"2026-10-20T02:00:00Z").unwrap();assert!(public["rights"].as_str().unwrap().contains("verify"));assert_ne!(voice["evidence"]["responseSha256"],public["evidence"]["responseSha256"]);
    }
    #[test]
    fn voice_metadata_rejects_invalid_identity_and_unsafe_preview_urls(){
        let response=json!({"_id":"voice","title":"Voice","languages":[],"visibility":"private","samples":[]});
        assert!(normalize(&response,false,"2026-10-20T00:00:00Z").is_ok());
        for (field,value) in [("_id",json!("bad/id")),("title",json!("Voice\nName")),("visibility",json!("unknown")),("samples",json!([{"audio":"http://private.example/audio.wav"}])),("languages",json!(["de\nDE"]))]{let mut invalid=response.clone();invalid[field]=value;assert!(normalize(&invalid,false,"2026-10-20T00:00:00Z").is_err());}
    }
}
