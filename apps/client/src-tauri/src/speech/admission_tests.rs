use super::*;
use std::path::PathBuf;
use std::sync::{Arc, Barrier};

#[path="admission_lifecycle_tests.rs"]
mod lifecycle;
#[path="diagnostics_tests.rs"]
mod diagnostics;

#[test]
fn retries_preserve_the_original_cache_choice_and_never_convert_live_input(){
    for reuse in [false,true]{
        let snapshot=json!({"input":{"owner":"studio","reuseCache":reuse,"takes":2,"segments":[{"text":"Original."}]}});
        let retry=retry_input(&snapshot,"original-job",false).unwrap();
        assert_eq!(retry["reuseCache"],reuse);assert_eq!(retry["parentJobId"],"original-job");assert_eq!(retry["segments"],snapshot["input"]["segments"]);assert!(snapshot["input"].get("parentJobId").is_none());
        let mut live=snapshot.clone();live["liveInput"]=json!({"transport":"fish-live-v1"});assert!(retry_input(&live,"original-job",true).is_err());
        let mut alignment=snapshot;alignment["operation"]=json!("align");let retry=retry_input(&alignment,"original-job",true).unwrap();assert_eq!(retry["confirmedUncertain"],true);assert_eq!(retry["reuseCache"],reuse);
    }
}

#[test]
fn a_reviewed_profile_change_rejects_admission_without_a_job_snapshot_or_reservation(){
    let directory=TestStore::new();let mut store=directory.open();let mut request=input("batch","Hello 世界.");request["expectedProfile"]=profile();
    let mut changed=profile();changed["temperature"]=json!(0.1);store.execute("saveProfile",&json!({"profile":changed})).unwrap();
    assert!(admit_now(&mut store,request.clone(),settings(),"changed").unwrap_err().contains("reviewed speech profile changed"));
    for table in ["jobs","speech_requests","speech_budget"]{assert_eq!(store.connection.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get::<_,i64>(0)).unwrap(),0);}
    request["expectedProfile"]=changed.clone();admit_now(&mut store,request,settings(),"current").unwrap();let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='current'",[],|row|row.get(0)).unwrap();let recorded:Value=serde_json::from_str(&data).unwrap();assert_eq!(recorded["profile"],changed);assert_eq!(recorded["input"]["expectedProfile"],recorded["profile"]);
}

#[test]
fn inline_reference_limits_are_checked_before_reservation_and_count_duplicate_wire_uploads(){
    let directory=TestStore::new();let mut store=directory.open();
    for (index,data_bytes,count) in [(0,16*1024*1024-44,2),(1,16*1024*1024-42,1)]{
        let mut bytes=super::super::pcm::wav_header(data_bytes).unwrap().to_vec();bytes.resize(data_bytes as usize+44,0);let path=directory.0.join(format!("reference-{index}.wav"));std::fs::write(&path,bytes).unwrap();
        let asset=store.put_asset(&path,"audio/wav",data_bytes as f64/48000.0,24000,1).unwrap();let id=asset["id"].as_str().unwrap();store.connection.execute("INSERT INTO speech_references VALUES(?1,'Synthetic reference','Synthetic test permission')",[id]).unwrap();
        let mut request=input("studio","Hello.");request["segments"][0]["voiceIds"]=json!([]);request["segments"][0]["referenceAssetIds"]=json!(vec![id;count]);
        let message=admit_now(&mut store,request,settings(),&format!("rejected-{index}")).unwrap_err();assert!(message.contains(if count==2{"24 MiB aggregate"}else{"16 MiB"}));
    }
    for table in ["jobs","speech_requests","speech_budget"]{assert_eq!(store.connection.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get::<_,i64>(0)).unwrap(),0);}
}

#[test]
fn assistant_admission_pins_the_actual_request_and_rejects_unsupported_controls_before_queuing(){
    let directory=TestStore::new();let mut store=directory.open();
    let mut profile=profile();profile["backend"]=json!("openai");profile["model"]=json!("gpt-4o-mini-tts");profile["voiceId"]=json!("cedar");profile["chunkLength"]=json!(300);profile["direction"]=json!("quiet and thoughtful");
    store.execute("saveProfile",&json!({"profile":profile})).unwrap();
    let mut settings=settings();settings["connections"]=json!([{"backend":"openai","model":"gpt-4o-mini-tts","configured":true,"runtimeVersion":null}]);
    let mut request=input("manual","<|speaker:0|>Hello 世界.");request["segments"][0]["spokenText"]=json!("Hello 世界.");request["segments"][0]["voiceIds"]=json!(["cedar"]);
    admit_now(&mut store,request.clone(),settings.clone(),"assistant").unwrap();
    let snapshot:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='assistant'",[],|row|row.get(0)).unwrap();let snapshot:Value=serde_json::from_str(&snapshot).unwrap();
    let wire=&snapshot["input"]["segments"][0]["assistantRequest"];
    assert_eq!(wire["input"],"Hello 世界.");assert_eq!(wire["instructions"],"quiet and thoughtful");assert_eq!(wire["speed"],1.0);assert!(wire.get("temperature").is_none());
    assert_eq!(snapshot["characters"],wire["input"].as_str().unwrap().chars().count());assert_eq!(snapshot["textBytes"],wire["input"].as_str().unwrap().len());
    request["segments"][0]["text"]=json!("<|speaker:0|>[quiet]Hello 世界.");assert!(admit_now(&mut store,request,settings,"unsupported").unwrap_err().contains("markup"));
    assert_eq!(store.connection.query_row("SELECT count(*) FROM jobs",[],|row|row.get::<_,i64>(0)).unwrap(),1);
}

struct TestStore(PathBuf);

impl TestStore {
    fn new() -> Self {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).unwrap();
        let path = std::env::temp_dir().join(format!("speech-admission-{:x}", u128::from_le_bytes(bytes)));
        let mut store = SpeechStore::open(path.clone()).unwrap();
        store.execute("saveProfile", &json!({"profile":profile()})).unwrap();
        Self(path)
    }

    fn open(&self) -> SpeechStore { SpeechStore::open(self.0.clone()).unwrap() }
}

impl Drop for TestStore {
    fn drop(&mut self) { std::fs::remove_dir_all(&self.0).unwrap(); }
}

fn profile() -> Value {
    json!({"id":"profile","name":"Test","backend":"fish-cloud","model":"drama-3","voiceId":"voice","direction":"","temperature":0.7,"topP":0.7,"chunkLength":200,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1.0})
}

fn settings() -> Value {
    json!({"connections":[{"backend":"fish-cloud","configured":true,"model":"drama-3","runtimeVersion":null,"nativeRevision":false}],"cloudConsent":true,"answerCharacterLimit":1000,"budgetLimit":null,"answerBudgetLimit":null,"pricing":{"unit":"characters","perMillion":1000000.0,"currency":"USD","source":"https://example.test/fixture-rate","effectiveFrom":"2000-01-01","effectiveTo":"2099-01-01"}})
}

fn input(owner: &str, text: &str) -> Value {
    json!({"owner":owner,"projectId":null,"revisionId":"answer","profileId":"profile","segments":[{"id":"segment","text":text,"spokenText":text,"chapter":null,"voiceIds":["voice"],"referenceAssetIds":[]}],"takes":1,"priority":0,"reuseCache":false,"cloudConsent":true,"budgetLimit":null})
}

fn admit_now(store: &mut SpeechStore, input: Value, settings: Value, id: &str) -> Result<Value, String> {
    admit(store, input, settings, chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), id.to_string())
}

#[test]
fn local_drama3_admits_without_cloud_consent_or_a_billing_rate() {
    let directory = TestStore::new();
    let mut store = directory.open();
    let mut local = profile();
    local["backend"] = json!("drama3");
    local["voiceId"] = json!("");
    local["chunkLength"] = json!(300);
    store.execute("saveProfile", &json!({"profile":local})).unwrap();
    let mut request = input("local", "Hello from the local model.");
    request["segments"][0]["voiceIds"] = json!([]);
    request["cloudConsent"] = json!(false);
    request["budgetLimit"] = json!(0);
    let mut settings = settings();
    settings["connections"] = json!([{"backend":"drama3","model":"drama-3","configured":true,"runtimeVersion":"audio.cpp/test"}]);
    settings["cloudConsent"] = json!(false);
    settings["pricing"] = Value::Null;
    admit_now(&mut store, request.clone(), settings.clone(), "native").unwrap();
    let snapshot: String = store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='native'", [], |row| row.get(0)).unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot["estimate"], 0.0);
    request["segments"][0]["voiceIds"] = json!(["cloud-library-voice"]);
    assert!(admit_now(&mut store, request, settings, "invalid").unwrap_err().contains("Fish library"));
}

#[test]
fn independent_connections_reserve_parallel_automatic_speech_budget_atomically() {
    let directory = TestStore::new();
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for index in 0..2 {
        let path = directory.0.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let mut store = SpeechStore::open(path).unwrap();
            let mut settings = settings();
            settings["answerBudgetLimit"] = json!(3.0);
            barrier.wait();
            admit_now(&mut store, input(&format!("chat:auto:{index}"), "ab"), settings, &format!("job-{index}"))
        }));
    }
    let admitted = handles.into_iter().map(|handle| handle.join().unwrap()).filter(Result::is_ok).count();
    assert_eq!(admitted, 1);
    let store = directory.open();
    let reserved: f64 = store.connection.query_row("SELECT sum(amount) FROM speech_budget WHERE scope='automatic-answer'", [], |row| row.get(0)).unwrap();
    assert_eq!(reserved, 2.0);
    let requests: i64 = store.connection.query_row("SELECT count(*) FROM speech_requests", [], |row| row.get(0)).unwrap();
    assert_eq!(requests, 1);
}

#[test]
fn pricing_preserves_distinct_character_and_utf8_units() {
    let directory = TestStore::new();
    let mut store = directory.open();
    admit_now(&mut store, input("manual", "你好"), settings(), "characters").unwrap();
    let mut bytes = settings();
    bytes["pricing"]["unit"] = json!("utf8Bytes");
    admit_now(&mut store, input("manual", "你好"), bytes, "bytes").unwrap();
    let cost = |id: &str| store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id=?1", [id], |row| row.get::<_, f64>(0)).unwrap();
    assert_eq!(cost("characters"), 2.0);
    assert_eq!(cost("bytes"), 6.0);
}

#[test]
fn unknown_rates_and_missing_cloud_consent_do_not_dispatch_or_reserve() {
    let directory = TestStore::new();
    let mut store = directory.open();
    let mut unknown = settings();
    unknown["pricing"] = Value::Null;
    unknown["budgetLimit"] = json!(1.0);
    assert!(admit_now(&mut store, input("manual", "ab"), unknown, "unknown").unwrap_err().contains("verified rate"));
    let mut no_consent = input("manual", "ab");
    no_consent["cloudConsent"] = json!(false);
    assert!(admit_now(&mut store, no_consent, settings(), "unapproved").unwrap_err().contains("Enable cloud"));
    let jobs: i64 = store.connection.query_row("SELECT count(*) FROM jobs", [], |row| row.get(0)).unwrap();
    assert_eq!(jobs, 0);
}

#[test]
fn invalid_revision_rolls_back_admission_snapshot_and_budget_together() {
    let directory = TestStore::new();
    let mut store = directory.open();
    let mut request = input("manual", "ab");
    request["projectId"] = json!("missing-project");
    assert!(admit_now(&mut store, request, settings(), "invalid").is_err());
    for table in ["jobs", "speech_requests", "speech_budget"] {
        let count: i64 = store.connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}

#[test]
fn retry_keeps_owner_attempt_and_immutable_configuration() {
    let directory = TestStore::new();
    let mut store = directory.open();
    let mut parent = admit_now(&mut store, input("manual", "ab"), settings(), "parent").unwrap();
    parent["state"] = json!("running");
    store.put_job(&parent).unwrap();
    parent["state"] = json!("failed");
    store.put_job(&parent).unwrap();
    let mut request = input("manual", "ab");
    request["parentJobId"] = json!("parent");
    request["reuseCache"] = json!(true);
    let retried = admit_now(&mut store, request.clone(), settings(), "retry").unwrap();
    assert_eq!(retried["attempt"], 2);
    assert_eq!(retried["parentJobId"], "parent");
    request["owner"] = json!("other");
    assert!(admit_now(&mut store, request.clone(), settings(), "foreign").is_err());
    request["owner"] = json!("manual");
    let mut changed = profile();
    changed["temperature"] = json!(0.9);
    store.execute("saveProfile", &json!({"profile":changed})).unwrap();
    assert!(admit_now(&mut store, request, settings(), "changed").unwrap_err().contains("configuration changed"));
}
