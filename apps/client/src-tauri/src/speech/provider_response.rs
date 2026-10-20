use serde_json::{json,Map,Value};

const GOOGLE_COUNTS:[&str;6]=["promptTokenCount","cachedContentTokenCount","candidatesTokenCount","toolUsePromptTokenCount","thoughtsTokenCount","totalTokenCount"];

fn identifier(value:&Value)->Result<&str,String>{
    value.as_str().filter(|value|!value.is_empty()&&value.len()<=512&&value.bytes().all(|byte|byte.is_ascii_graphic())).ok_or_else(||"The provider returned an invalid response identifier or model version.".into())
}

pub fn google(response:&Value)->Result<Value,String>{
    let mut evidence=Map::new();evidence.insert("provider".into(),json!("google"));
    for key in ["modelVersion","responseId"]{
        if let Some(value)=response.get(key).filter(|value|!value.is_null()){
            evidence.insert(key.into(),json!(identifier(value)?));
        }
    }
    if let Some(usage)=response.get("usageMetadata").filter(|value|!value.is_null()){
        let usage=usage.as_object().ok_or("Google returned invalid usage metadata.")?;let mut counts=Map::new();
        for key in GOOGLE_COUNTS{
            if let Some(value)=usage.get(key).filter(|value|!value.is_null()){
                let count=value.as_u64().filter(|count|*count<=9_007_199_254_740_991).ok_or("Google returned an invalid token count.")?;counts.insert(key.into(),json!(count));
            }
        }
        if !counts.is_empty(){evidence.insert("usageMetadata".into(),Value::Object(counts));}
    }
    if evidence.len()==1{Ok(Value::Null)}else{Ok(Value::Object(evidence))}
}

pub fn openai(headers:&reqwest::header::HeaderMap)->Result<Value,String>{
    let mut evidence=Map::new();evidence.insert("provider".into(),json!("openai"));
    if let Some(value)=headers.get("x-request-id"){
        let value=value.to_str().map_err(|_|"OpenAI returned an invalid request ID.")?;
        evidence.insert("requestId".into(),json!(identifier(&json!(value))?));
    }
    if let Some(value)=headers.get("openai-processing-ms"){
        let value=value.to_str().ok().and_then(|value|value.parse::<f64>().ok()).filter(|value|value.is_finite()&&*value>=0.0).ok_or("OpenAI returned an invalid processing time.")?;
        evidence.insert("processingMs".into(),json!(value));
    }
    if evidence.len()==1{Ok(Value::Null)}else{Ok(Value::Object(evidence))}
}

pub fn sglang(request_id:&str,terminal:&Value)->Result<Value,String>{
    if terminal["type"]!="speech.audio.done"||terminal["finish_reason"]!="stop"{return Err("The self-hosted speech stream did not confirm normal completion. Review the job before retrying.".into());}
    let mut evidence=json!({"provider":"sglang","requestId":identifier(&json!(request_id))?,"finishReason":"stop"});
    if let Some(usage)=terminal.get("usage").filter(|value|!value.is_null()){
        let usage=usage.as_object().ok_or("The self-hosted speech usage is invalid.")?;let mut counts=Map::new();
        for key in ["input_tokens","output_tokens","total_tokens"]{if let Some(value)=usage.get(key).filter(|value|!value.is_null()){let count=value.as_u64().filter(|value|*value<=9_007_199_254_740_991).ok_or("The self-hosted speech token count is invalid.")?;counts.insert(key.into(),json!(count));}}
        if !counts.is_empty(){evidence["usage"]=Value::Object(counts);}
    }
    Ok(evidence)
}

pub fn validate(evidence:&Value,backend:&str)->Result<(),String>{
    let fields=evidence.as_object().filter(|fields|fields.len()>1).ok_or("Include actual provider response evidence.")?;
    if evidence["provider"]!=backend{return Err("The response evidence belongs to a different provider.".into());}
    match backend{
        "google"=>{
            if fields.keys().any(|key|!matches!(key.as_str(),"provider"|"modelVersion"|"responseId"|"usageMetadata")){return Err("The Google response evidence contains unsupported fields.".into());}
            let decoded=google(evidence)?;
            if decoded!=*evidence{return Err("Preserve only the actual supported Google response fields.".into());}
        },
        "openai"=>{
            if fields.keys().any(|key|!matches!(key.as_str(),"provider"|"requestId"|"processingMs")){return Err("The OpenAI response evidence contains unsupported fields.".into());}
            if let Some(id)=evidence.get("requestId"){identifier(id)?;}
            if evidence.get("processingMs").is_some_and(|value|value.as_f64().is_none_or(|value|!value.is_finite()||value<0.0)){return Err("The returned OpenAI processing time is invalid.".into());}
        },
        "sglang"=>{
            if fields.keys().any(|key|!matches!(key.as_str(),"provider"|"requestId"|"finishReason"|"usage")){return Err("The self-hosted response evidence contains unsupported fields.".into());}
            let id=identifier(&evidence["requestId"])?;let decoded=sglang(id,&json!({"type":"speech.audio.done","finish_reason":evidence["finishReason"],"usage":evidence["usage"]}))?;
            if decoded!=*evidence{return Err("Preserve only actual supported self-hosted speech response fields.".into());}
        },
        _=>return Err("This speech provider has no configured response-evidence contract.".into()),
    }
    Ok(())
}

#[cfg(test)]
#[path="provider_response_tests.rs"]
mod tests;
