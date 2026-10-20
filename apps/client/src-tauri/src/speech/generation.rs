use super::store::SpeechStore;
use serde_json::{json,Value};

pub struct GenerationSnapshot{
    pub profile:Value,
    pub dictionaries:Vec<Value>,
    pub references:serde_json::Map<String,Value>,
    pub connection:Value,
    pub parent_take_id:String,
    pub note:String,
}

impl GenerationSnapshot{
    pub fn from_request(request:&Value,parent_take_id:String,note:String)->Result<Self,String>{
        Ok(Self{profile:request["profile"].clone(),dictionaries:request["dictionaries"].as_array().ok_or("The pinned dictionaries are damaged.")?.clone(),references:request["references"].as_object().ok_or("The pinned references are damaged.")?.clone(),connection:request["connection"].clone(),parent_take_id,note})
    }
}

pub fn admit_performance(store:&mut SpeechStore,input:Value,settings:Value,now:String,id:String)->Result<Value,String>{
    let fields=input.as_object().ok_or("Supply a performance request.")?;
    let required=["owner","takeId","note","takes","cloudConsent","budgetLimit"];
    if fields.len()!=required.len()||required.iter().any(|field|!fields.contains_key(*field)){return Err("Supply the source take, director note, takes, owner, upload consent and budget.".into());}
    if !input["cloudConsent"].is_boolean(){return Err("Choose whether this performance may use cloud synthesis.".into());}
    let take=store.timing_take(input["takeId"].as_str().ok_or("Choose a source take.")?)?;
    if take["projectId"].is_null(){return Err("Save this performance to a project before requesting another take.".into());}
    let original=store.execute("takeRequest",&json!({"id":take["id"]}))?;
    if !matches!(take["backend"].as_str(),Some("fish-cloud"|"sglang"|"drama3"))||take["model"]!="drama-3"{return Err("Choose a Drama 3 take for director-note regeneration.".into());}
    let note=input["note"].as_str().ok_or("Enter a director note.")?;
    let mut request=original.clone();
    request["profile"]["direction"]=json!(super::performance::direction(original["profile"]["direction"].as_str().ok_or("The original direction is missing.")?,note)?);
    request["segment"].as_object_mut().ok_or("The original segment is invalid.")?.remove("liveFragments");
    request["performanceNote"]=json!(note);
    super::performance::validate_origin(&request,&original)?;
    let generation=GenerationSnapshot::from_request(&request,take["id"].as_str().ok_or("The source take identity is missing.")?.into(),note.into())?;
    let render=json!({"owner":input["owner"],"projectId":take["projectId"],"revisionId":take["revisionId"],"profileId":request["profile"]["id"],"segments":[request["segment"]],"takes":input["takes"],"priority":50,"reuseCache":false,"cloudConsent":input["cloudConsent"],"budgetLimit":input["budgetLimit"]});
    super::admission::admit_generation(store,render,settings,now,id,generation)
}
