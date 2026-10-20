use super::*;

struct Directory(std::path::PathBuf);
impl Directory{fn new()->Self{let mut bytes=[0u8;16];getrandom::fill(&mut bytes).unwrap();Self(std::env::temp_dir().join(format!("speech-comparison-{:x}",u128::from_le_bytes(bytes))))}fn open(&self)->SpeechStore{let mut store=SpeechStore::open(self.0.clone()).unwrap();store.execute("saveProfile",&json!({"profile":profile()})).unwrap();store}}
impl Drop for Directory{fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}

fn profile()->Value{json!({"id":"profile","name":"Comparison","backend":"fish-cloud","model":"drama-3","voiceId":"default","direction":"calm","normalize":false,"temperature":0.7,"topP":0.7,"chunkLength":300,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1.25})}
fn settings()->Value{json!({"connections":[{"backend":"fish-cloud","model":"drama-3","configured":true}],"cloudConsent":true,"pricing":{"unit":"characters","perMillion":1_000_000,"currency":"USD","source":"Synthetic test rate","effectiveFrom":"2000-01-01","effectiveTo":"2099-01-01"},"budgetLimit":null,"answerBudgetLimit":null,"answerCharacterLimit":1000})}
fn input()->Value{json!({"owner":"comparison","profileId":"profile","segment":{"id":"source","text":"<|speaker:0|>Hello 世界.","spokenText":"Hello 世界.","chapter":null,"voiceIds":["template"],"referenceAssetIds":[]},"voiceIds":["voice-a","voice-b","voice-c"],"cloudConsent":true,"budgetLimit":null})}
fn snapshot(store:&SpeechStore,id:&str)->Value{let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).unwrap();serde_json::from_str(&data).unwrap()}

#[test]
fn voice_comparison_pins_one_shared_passage_profile_and_budget_for_explicit_voices(){
    let directory=Directory::new();let mut store=directory.open();let source=input();let job=admit(&mut store,source.clone(),settings(),"2026-10-20T00:00:00.000Z".into(),"one".into()).unwrap();
    assert_eq!(job["totalSegments"],3);assert!(job["projectId"].is_null());assert_eq!(job["revisionId"],"comparison-one");
    let recorded=snapshot(&store,"one");let segments=recorded["input"]["segments"].as_array().unwrap();
    assert_eq!(recorded["profile"],profile());assert_eq!(recorded["input"]["reuseCache"],false);
    for (index,segment) in segments.iter().enumerate(){assert_eq!(segment["text"],source["segment"]["text"]);assert_eq!(segment["spokenText"],source["segment"]["spokenText"]);assert_eq!(segment["voiceIds"],json!([source["voiceIds"][index]]));}
    assert_eq!(segments.iter().map(|segment|segment["id"].as_str().unwrap()).collect::<HashSet<_>>().len(),3);
    let expected=(source["segment"]["text"].as_str().unwrap().chars().count()+"[calm]".chars().count())*3;
    assert_eq!(recorded["billableCharactersEstimate"],expected);assert_eq!(recorded["estimate"],expected as f64);
    assert_eq!(store.execute("listProfiles",&json!({})).unwrap(),json!([profile()]));assert_eq!(source,input());
    let mut reversed=source;reversed["voiceIds"].as_array_mut().unwrap().reverse();admit(&mut store,reversed,settings(),"2026-10-20T00:00:01.000Z".into(),"two".into()).unwrap();
    let second=snapshot(&store,"two");assert_eq!(segments[0]["id"],second["input"]["segments"][2]["id"]);
    assert_eq!(store.execute("listJobs",&json!({"owner":"comparison","limit":1})).unwrap()[0]["id"],"two");assert_eq!(store.execute("listJobs",&json!({"owner":"comparison","limit":1,"offset":1})).unwrap()[0]["id"],"one");
    assert_eq!(store.execute("listJobs",&json!({"owner":"other","id":"one","limit":1})).unwrap(),json!([]));assert_eq!(store.execute("listJobs",&json!({"owner":"comparison","id":"one","limit":1})).unwrap().as_array().unwrap().len(),1);
    for page in [json!({"limit":0}),json!({"limit":501}),json!({"limit":null}),json!({"offset":-1})]{assert!(store.execute("listJobs",&page).is_err());}
}

#[test]
fn comparison_rejection_is_atomic_for_invalid_voices_controls_upload_consent_and_total_budget(){
    let directory=Directory::new();let mut store=directory.open();
    let mut invalid=Vec::new();
    for voices in [json!(["only-one"]),json!(["voice-a","voice-a"]),json!([" ","voice-b"]),json!((0..33).map(|index|format!("voice-{index}")).collect::<Vec<_>>())]{let mut value=input();value["voiceIds"]=voices;invalid.push(value);}
    let mut value=input();value["cloudConsent"]=json!(false);invalid.push(value);
    let mut value=input();value["segment"]["undocumented"]=json!(true);invalid.push(value);
    let mut value=input();value["segment"]["referenceAssetIds"]=json!(["private-reference"]);invalid.push(value);
    let mut value=input();value["segment"]["text"]=json!("<|speaker:1|>Another speaker.");invalid.push(value);
    let mut value=input();value["budgetLimit"]=json!(1);invalid.push(value);
    for value in invalid{assert!(admit(&mut store,value,settings(),"2026-10-20T00:00:00.000Z".into(),"invalid".into()).is_err());}
    assert_eq!(store.connection.query_row("SELECT count(*) FROM jobs",[],|row|row.get::<_,i64>(0)).unwrap(),0);assert_eq!(store.connection.query_row("SELECT count(*) FROM speech_budget",[],|row|row.get::<_,i64>(0)).unwrap(),0);
}
