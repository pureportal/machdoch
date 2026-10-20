use super::store::SpeechStore;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::collections::HashSet;

pub fn admit(store:&mut SpeechStore,input:Value,settings:Value,now:String,id:String)->Result<Value,String>{
    let fields=input.as_object().ok_or("Supply a voice comparison request.")?;
    let required=["owner","profileId","segment","voiceIds","cloudConsent","budgetLimit"];
    if fields.len()!=required.len()||required.iter().any(|field|!fields.contains_key(*field)){return Err("Supply a profile, one compiled passage, selected voices, owner, cloud consent and budget.".into());}
    let profiles=store.execute("listProfiles",&json!({}))?;
    let profile=profiles.as_array().and_then(|values|values.iter().find(|profile|profile["id"]==input["profileId"])).ok_or("Choose a saved speech profile.")?;
    if profile["backend"]!="fish-cloud"||profile["model"]!="drama-3"{return Err("Choose a Fish Cloud Drama 3 profile for library voice comparison.".into());}
    let source=&input["segment"];
    super::contracts::validate_segment_references(source,profile)?;
    if source["text"].as_str().is_none_or(|text|text.len()>65536)||source["voiceIds"].as_array().is_none_or(|values|values.len()>1)||source["referenceAssetIds"].as_array().is_none_or(|values|!values.is_empty())||source.get("referenceGroups").is_some(){return Err("Use one audition passage below 64 KiB with one library voice and no inline references.".into());}
    let voices=input["voiceIds"].as_array().filter(|values|(2..=32).contains(&values.len())).ok_or("Choose 2 to 32 voices for one comparison.")?;
    let mut known=HashSet::new();let mut segments=Vec::new();
    for voice in voices{
        let voice=voice.as_str().filter(|voice|!voice.trim().is_empty()&&voice.trim()==*voice&&voice.len()<=256&&!voice.chars().any(char::is_control)).ok_or("Choose valid library voice IDs without surrounding whitespace.")?;
        if !known.insert(voice){return Err("Select each comparison voice once.".into());}
        let mut segment=source.clone();segment["id"]=json!(format!("voice-{:x}",Sha256::digest(voice.as_bytes())));segment["voiceIds"]=json!([voice]);segments.push(segment);
    }
    let render=json!({"owner":input["owner"],"projectId":null,"revisionId":format!("comparison-{id}"),"profileId":input["profileId"],"segments":segments,"takes":1,"priority":75,"reuseCache":false,"cloudConsent":input["cloudConsent"],"budgetLimit":input["budgetLimit"]});
    super::admission::admit(store,render,settings,now,id)
}

#[cfg(test)]
#[path="voice_comparison_tests.rs"]
mod tests;
