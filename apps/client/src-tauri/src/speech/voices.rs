use super::{settings, SpeechService};
use futures_util::StreamExt;
use reqwest::Response;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::sync::Arc;

async fn response_json(response:Response,limit:usize)->Result<Value,String>{
    if !response.status().is_success(){return Err(match response.status().as_u16(){401|403=>"Fish authentication failed. Check the API key and voice access.",402=>"Fish credit is insufficient. Add credit before retrying.",404=>"This Fish voice is unavailable or private. Choose an accessible voice.",429=>"Fish concurrency is exhausted. Wait for other requests before retrying.",400|422=>"Fish rejected this request. Check the voice parameters.",_=>"Fish could not complete the request. Review it before retrying."}.to_string())}
    let mut stream=response.bytes_stream();let mut bytes=Vec::new();
    while let Some(fragment)=stream.next().await{let fragment=fragment.map_err(|_|"Fish disconnected before returning a complete response.")?;if bytes.len()+fragment.len()>limit{return Err("Fish response exceeded the local size guard.".to_string())}bytes.extend_from_slice(&fragment)}
    serde_json::from_slice(&bytes).map_err(|_|"Fish returned malformed response data.".to_string())
}

fn voice(service:&Arc<SpeechService>,value:&Value)->Result<Value,String>{
    let id=value["_id"].as_str().ok_or("Fish returned a voice without an ID.")?;
    let favorite=service.with_store(|store|store.connection.query_row("SELECT 1 FROM speech_voice_favorites WHERE id=?1",[id],|_|Ok(true)).optional().map(|value|value.unwrap_or(false)).map_err(|error|error.to_string()))?;
    let normalized=super::voice_metadata::normalize(value,favorite,&super::timestamp())?;
    service.with_store(|store|super::store::SpeechStore::record_voice_observation(&store.connection,&normalized))?;
    Ok(normalized)
}

fn voice_id(input:&Value)->Result<&str,String>{
    input["id"].as_str().filter(|id|!id.is_empty()&&id.len()<=128&&id.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"_-".contains(&byte))).ok_or_else(||"Enter a valid Fish voice ID.".to_string())
}

pub async fn execute(service:&Arc<SpeechService>,operation:&str,input:Value)->Result<Value,String>{
    if operation=="favoriteVoice"{return service.with_store(|store|store.execute(operation,&input));}
    let key=settings::credential("fish-cloud")?.ok_or("Save a Fish Audio API key before using its voice library.")?;
    match operation{
        "listVoices"=>{
            let page=input["page"].as_u64().filter(|page|*page>=1).ok_or("Use a voice page starting at 1.")?;
            let page_size=input["pageSize"].as_u64().filter(|size|(1..=100).contains(size)).ok_or("Use a voice page size from 1 to 100.")?;
            let mut query=vec![("page_number",page.to_string()),("page_size",page_size.to_string()),("self",(input["own"]==true).to_string())];
            if let Some(search)=input["search"].as_str(){query.push(("title",search.to_string()))}if let Some(language)=input["language"].as_str(){query.push(("language",language.to_string()))}
            let response=service.client.get("https://api.fish.audio/model").bearer_auth(&key).header("model","drama-3").query(&query).timeout(std::time::Duration::from_secs(60)).send().await.map_err(|_|"Fish voice discovery could not connect.")?;
            let data=response_json(response,8*1024*1024).await?;let voices=data["items"].as_array().ok_or("Fish returned an invalid voice page.")?.iter().map(|value|voice(service,value)).collect::<Result<Vec<_>,_>>()?;
            Ok(json!({"voices":voices,"total":data["total"]}))
        },
        "getVoice"=>{let id=voice_id(&input)?;let response=service.client.get(format!("https://api.fish.audio/model/{id}")).bearer_auth(&key).header("model","drama-3").timeout(std::time::Duration::from_secs(60)).send().await.map_err(|_|"Fish voice lookup could not connect.")?;voice(service,&response_json(response,8*1024*1024).await?)},
        "deleteVoice"|"updateVoice"=>{
            let id=voice_id(&input)?;
            let action=if operation=="deleteVoice"{"delete"}else{"update"};
            let pending=service.with_store(|store|store.begin_voice_mutation(action,&input,&super::timestamp()))?;
            let attempt=pending["id"].as_str().ok_or("The voice change attempt is missing.")?;
            let response=super::voice_mutation_transport::execute(&service.client,"https://api.fish.audio",id,action,&pending["changes"],&key).await;
            service.with_store(|store|store.finish_voice_mutation(attempt,response.ok(),&super::timestamp()))
        },
        "checkVoiceMutation"=>{
            if input.as_object().is_none_or(|fields|fields.len()!=1||!fields.contains_key("id")){return Err("Choose one voice change attempt to check.".into());}
            let attempt=voice_id(&input)?;
            let pending=service.with_store(|store|store.voice_mutation_for_check(attempt,&super::timestamp()))?;
            if pending["state"]!="uncertain"{return Ok(pending);}
            let id=pending["voiceId"].as_str().ok_or("The voice deletion target is unavailable.")?;
            let response=service.client.get(format!("https://api.fish.audio/model/{id}")).bearer_auth(&key).header("model","drama-3").timeout(std::time::Duration::from_secs(60)).send().await.map_err(|_|"The voice change is still uncertain. Check again when Fish is reachable.")?;
            let status=response.status().as_u16();
            let observed=if status==200{Some(voice(service,&response_json(response,8*1024*1024).await?)?)}else{None};
            service.with_store(|store|store.observe_voice_mutation(attempt,status,observed.as_ref(),&super::timestamp()))
        },
        _=>Err("Unknown speech voice operation.".to_string()),
    }
}
