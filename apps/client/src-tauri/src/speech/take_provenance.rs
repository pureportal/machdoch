use serde_json::{json,Value};

pub fn summarize(request:&Value)->Result<Value,String>{
    let dictionaries=request["dictionaries"].as_array().ok_or("The take dictionary snapshot is damaged.")?.iter().map(|dictionary|json!({"id":dictionary["id"],"name":dictionary["name"],"revision":dictionary["revision"]})).collect::<Vec<_>>();
    let references=request["references"].as_object().ok_or("The take reference snapshot is damaged.")?.iter().map(|(id,reference)|(id.clone(),reference["sha256"].clone())).collect::<serde_json::Map<_,_>>();
    let mut summary=json!({"segment":request["segment"],"profile":request["profile"],"dictionaries":dictionaries,"referenceHashes":references,"connection":request["connection"]});
    if let Some(note)=request.get("performanceNote"){summary["performanceNote"]=note.clone();}
    Ok(summary)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn audition_provenance_keeps_exact_configuration_and_ids_without_copying_rules_or_reference_transcripts(){
        let request=json!({"segment":{"text":"Actual audition passage","voiceIds":["voice"]},"profile":{"name":"Profile","direction":"calm"},"dictionaries":[{"id":"dict","name":"Names","revision":"pinned","rules":[{"text":"private-pronunciation-rule"}]}],"references":{"asset":{"sha256":"hash","transcript":"private-reference-transcript","rights":"private-rights-record"}},"connection":{"model":"drama-3"},"performanceNote":"thoughtful"});
        let summary=summarize(&request).unwrap();assert_eq!(summary["segment"],request["segment"]);assert_eq!(summary["profile"],request["profile"]);assert_eq!(summary["performanceNote"],"thoughtful");assert_eq!(summary["referenceHashes"]["asset"],"hash");assert_eq!(summary["dictionaries"],json!([{"id":"dict","name":"Names","revision":"pinned"}]));
        let serialized=summary.to_string();for private in ["private-pronunciation-rule","private-reference-transcript","private-rights-record"]{assert!(!serialized.contains(private));}
    }
}
