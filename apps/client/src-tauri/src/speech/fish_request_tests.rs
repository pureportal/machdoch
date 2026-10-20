use super::*;

fn snapshot() -> Value {
    json!({"profile":{"backend":"fish-cloud","model":"drama-3","direction":"calm",
        "temperature":0.6,"topP":0.8,"chunkLength":200,"minChunkLength":20,"latency":"low",
        "dictionaryIds":["names"],"normalize":false,"language":"es-MX"},
        "dictionaries":[{"rules":[{"text":"Machdoch","phonemes":"M AE1 K","alphabet":"arpabet","caseSensitive":true}]}],
        "references":{"a":{"transcript":"Pinned transcript"}}})
}

#[test]
fn compiled_library_dialogue_keeps_order_controls_and_inline_dictionary_contract() {
    let segment = json!({"text":"<|speaker:0|>Hello.<|speaker:1|>Hallo.","voiceIds":["first","second"],"referenceAssetIds":[]});
    let request = build(&snapshot(), &segment, |_| panic!("Library voices must not upload references")).unwrap();
    assert_eq!(request, json!({"text":"[calm]<|speaker:0|>Hello.<|speaker:1|>Hallo.",
        "reference_id":["first","second"],"temperature":0.6,"top_p":0.8,
        "chunk_length":200,"min_chunk_length":20,"latency":"low","normalize":false,"language":"es-MX",
        "pronunciation_dictionary":[{"items":[{"key":"Machdoch","value":"M AE1 K","case_sensitive":true}]}]}));
}

#[test]
fn single_speaker_references_use_only_the_pinned_transcript_and_no_synthetic_model_id() {
    let segment = json!({"text":"<|speaker:0|>Hello.","voiceIds":[],"referenceAssetIds":["a"]});
    let request = build(&snapshot(), &segment, |id| { assert_eq!(id,"a"); Ok(vec![1,2]) }).unwrap();
    assert!(request.get("reference_id").is_none());
    assert_eq!(request["references"],json!([{"audio":"AQI=","text":"Pinned transcript"}]));
    let mut missing = snapshot(); missing["references"] = json!({});
    assert!(build(&missing, &segment, |_| panic!("Missing provenance must fail before reading audio")).is_err());
    let mut mixed = segment.clone(); mixed["voiceIds"] = json!(["voice"]);
    assert!(build(&snapshot(), &mixed, |_| panic!("Mixed bindings must fail before reading audio")).is_err());
    assert!(build(&snapshot(), &segment, |_| Err("Reference content hash failed".into())).unwrap_err().contains("hash"));
}

#[test]
fn repeated_reference_uploads_count_toward_the_actual_wire_limit() {
    let segment = json!({"text":"Hello.","voiceIds":[],"referenceAssetIds":["a","a"]});
    assert!(build(&snapshot(), &segment, |_| Ok(vec![0; 13*1024*1024])).unwrap_err().contains("aggregate"));
    assert!(build(&snapshot(), &segment, |_| Ok(vec![0; 16*1024*1024+1])).unwrap_err().contains("each"));
    let mut wrong = segment; wrong["referenceGroups"] = json!([["a"],["b"]]);
    assert!(build(&snapshot(), &wrong, |_| panic!("Invalid group order must fail before reading audio")).is_err());
}
