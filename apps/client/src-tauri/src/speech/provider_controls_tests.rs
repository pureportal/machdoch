use super::*;
use serde_json::json;

fn profile(backend:&str)->Value{
    let (model,voice)=match backend{"openai"=>("gpt-4o-mini-tts","cedar"),"google"=>("gemini-3.1-flash-tts-preview","Kore"),_=>("drama-3","")};
    json!({"id":"profile","name":"Test","backend":backend,"model":model,"voiceId":voice,"language":"","direction":"calm","temperature":0.7,"topP":0.7,"chunkLength":300,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1})
}

#[test]
fn provider_controls_reject_ignored_parameters_and_validate_documented_language_fields(){
    for backend in ["fish-cloud","sglang","openai","google"]{validate_profile(&profile(backend)).unwrap();}
    for backend in ["sglang","openai","google"]{
        for (field,value) in [("normalize",json!(false)),("dictionaryIds",json!(["dictionary"])),("chunkLength",json!(200)),("minChunkLength",json!(20)),("latency",json!("low"))]{
            let mut changed=profile(backend);changed[field]=value;assert!(validate_profile(&changed).is_err(),"{backend}: {field}");
        }
    }
    let mut fish=profile("fish-cloud");fish["normalize"]=json!(false);fish["language"]=json!("es-MX");validate_profile(&fish).unwrap();
    for language in ["wrong language","日本語","en\nUS",&"a".repeat(36)]{fish["language"]=json!(language);assert!(validate_profile(&fish).is_err());}
    let mut google=profile("google");google["language"]=json!("de-DE");validate_profile(&google).unwrap();google["language"]=json!("de");assert!(validate_profile(&google).is_err());
    let mut openai=profile("openai");openai["language"]=json!("de-DE");assert!(validate_profile(&openai).is_err());openai["language"]=json!("");openai["temperature"]=json!(0.2);assert!(validate_profile(&openai).is_err());
}

#[test]
fn assistant_requests_remove_only_routing_cues_and_pin_the_actual_parameters_into_cache_identity(){
    let profile=profile("openai");
    let segment=json!({"id":"segment","text":"<|speaker:0|>Hello.\n<|speaker:0|>東京 🚀","spokenText":"Hello.\n東京 🚀","voiceIds":["cedar"],"referenceAssetIds":[],"chapter":null});
    validate_segment_references(&segment,&profile).unwrap();
    assert_eq!(provider_text(&segment,&profile).unwrap(),"Hello.\n東京 🚀");
    let prepared=super::super::assistant_requests::prepare_segment(&segment,&profile).unwrap();
    assert_eq!(prepared["text"],segment["text"]);assert_eq!(prepared["assistantRequest"]["input"],segment["spokenText"]);assert_eq!(prepared["assistantRequest"]["instructions"],"calm");
    assert_eq!(super::super::assistant_requests::prepare_segment(&prepared,&profile).unwrap(),prepared);
    let hash=|segment:&Value|super::super::cache::request_hash(segment,&profile,&json!([]),&json!({}),&json!({"model":profile["model"]})).unwrap();
    assert_ne!(hash(&segment),hash(&prepared));
    let mut forged=prepared.clone();forged["assistantRequest"]["instructions"]=json!("changed");assert!(super::super::assistant_requests::prepare_segment(&forged,&profile).is_err());
    for text in ["<|speaker:0|>[quiet]Hello.","<|speaker:0|><whisper>Hello.</whisper>","<|phoneme_start|>HH AH0<|phoneme_end|>","<|speaker:x|>Hello.","<|speaker:0Hello."]{
        let mut invalid=segment.clone();invalid["text"]=json!(text);assert!(provider_text(&invalid,&profile).is_err(),"{text}");
    }
    let mut wrong=segment;wrong["spokenText"]=json!("Different.");assert!(provider_text(&wrong,&profile).is_err());
    let text="世".repeat(4096);let allowed=json!({"text":text,"spokenText":text});super::super::assistant_requests::prepare_segment(&allowed,&profile).unwrap();
    let text="世".repeat(4097);let too_long=json!({"text":text,"spokenText":text});assert!(super::super::assistant_requests::prepare_segment(&too_long,&profile).unwrap_err().contains("4,096"));
}
