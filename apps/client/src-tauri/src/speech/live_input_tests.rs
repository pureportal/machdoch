use super::*;

#[test]
fn live_snapshot_capacity_covers_actual_utf8_and_escaped_fragment_log_growth(){
    let maximum=1000usize;
    let initial=json!({"segment":{"text":"x","spokenText":"x"}});let initial_bytes=serde_json::to_vec(&initial).unwrap().len();
    for glyph in ["🚀","\"","\\"]{
        let text=glyph.repeat(maximum);let mut final_request=initial.clone();let mut fragments=vec![json!(glyph);maximum];fragments.push(json!(""));
        final_request["segment"]["text"]=json!(text);final_request["segment"]["spokenText"]=json!(text);final_request["segment"]["liveFragments"]=json!(fragments);
        let final_bytes=serde_json::to_vec(&final_request).unwrap().len();assert!(final_bytes-initial_bytes<=15*maximum+32);
    }
    ensure_snapshot_capacity(initial_bytes,maximum as u64).unwrap();assert!(ensure_snapshot_capacity(super::super::store::MAX_METADATA_BYTES-100,maximum as u64).is_err());assert!(ensure_snapshot_capacity(0,u64::MAX).is_err());
}

struct Cleanup(std::path::PathBuf);
impl Drop for Cleanup {fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}

fn fixture() -> (Cleanup,SpeechStore) {
    let mut random=[0u8;16];getrandom::fill(&mut random).unwrap();
    let path=std::env::temp_dir().join(format!("speech-live-{:x}",u128::from_le_bytes(random)));
    let mut store=SpeechStore::open(path.clone()).unwrap();
    store.execute("saveProfile",&json!({"profile":{"id":"profile","name":"Narrator","backend":"fish-cloud","model":"drama-3","voiceId":"voice","direction":"","temperature":0.7,"topP":0.7,"chunkLength":200,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1.0}})).unwrap();
    (Cleanup(path),store)
}

fn settings()->Value {json!({"connections":[{"backend":"fish-cloud","configured":true,"model":"drama-3","runtimeVersion":null}],"cloudConsent":true,"answerCharacterLimit":1000,"budgetLimit":null,"answerBudgetLimit":null,"pricing":{"unit":"characters","perMillion":1_000_000.0,"currency":"USD","source":"https://example.test/rate","effectiveFrom":"2000-01-01","effectiveTo":"2099-01-01"}})}
fn input()->Value {json!({"owner":"chat:auto:session","projectId":null,"revisionId":"stream","profileId":"profile","segments":[{"id":"answer","text":"Hello.","spokenText":"Hello.","chapter":null,"voiceIds":["voice"],"referenceAssetIds":[]}],"takes":1,"priority":100,"reuseCache":false,"cloudConsent":true,"budgetLimit":null})}
fn begin(store:&mut SpeechStore,settings:Value,id:&str)->Result<Value,String>{super::super::admission::admit_live(store,input(),settings,"2026-10-19T00:00:00Z".into(),id.into(),100)}
fn fragment(sequence:u64,text:&str)->Value{json!({"jobId":"job","owner":"chat:auto:session","sequence":sequence,"text":text,"finish":false})}

#[test]
fn live_reserves_full_cap_in_one_transaction_and_keeps_initial_snapshot_immutable(){
    let (_cleanup,mut store)=fixture();
    begin(&mut store,settings(),"job").unwrap();
    let reserved:f64=store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id='job'",[],|row|row.get(0)).unwrap();assert_eq!(reserved,100.0);
    let snapshot:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='job'",[],|row|row.get(0)).unwrap();
    append(&mut store,&fragment(1," World.")).unwrap();
    let after:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='job'",[],|row|row.get(0)).unwrap();assert_eq!(snapshot,after);
    let mut limited=settings();limited["answerBudgetLimit"]=json!(150.0);
    assert!(begin(&mut store,limited,"other").unwrap_err().contains("budget"));
    assert_eq!(store.connection.query_row("SELECT count(*) FROM speech_live_inputs",[],|row|row.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn live_utf8_reservation_counts_worst_case_bytes_separately(){
    let (_cleanup,mut store)=fixture();let mut rate=settings();rate["pricing"]["unit"]=json!("utf8Bytes");begin(&mut store,rate,"job").unwrap();
    assert_eq!(store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id='job'",[],|row|row.get::<_,f64>(0)).unwrap(),400.0);
}

#[test]
fn live_append_is_owned_ordered_idempotent_and_bounded(){
    let (_cleanup,mut store)=fixture();begin(&mut store,settings(),"job").unwrap();
    let mut other=fragment(1," No.");other["owner"]=json!("other");assert!(append(&mut store,&other).is_err());
    assert!(append(&mut store,&fragment(2," Later.")).is_err());
    for index in 1..8{assert_eq!(append(&mut store,&fragment(index," x")).unwrap()["accepted"],true);}
    assert_eq!(append(&mut store,&fragment(8," y")).unwrap()["accepted"],false);
    assert_eq!(append(&mut store,&fragment(1," x")).unwrap()["accepted"],true);
    assert!(append(&mut store,&fragment(1," changed")).unwrap_err().contains("different"));
    assert_eq!(consume(&mut store,"job").unwrap(),Some(("Hello.".into(),false)));
    assert_eq!(append(&mut store,&fragment(8," y")).unwrap()["accepted"],true);
    assert!(append(&mut store,&fragment(9,"[whisper]")).is_err());
    assert!(append(&mut store,&fragment(9,&"a".repeat(101))).unwrap_err().contains("limit"));
}

#[test]
fn live_finish_requires_exact_transcript_and_all_consumed_fragments(){
    let (_cleanup,mut store)=fixture();begin(&mut store,settings(),"job").unwrap();
    append(&mut store,&fragment(1," 世界.")).unwrap();
    let mut finish=fragment(2,"");finish["finish"]=json!(true);finish["answerRevision"]=json!("final");finish["finalText"]=json!("Wrong.");
    assert!(append(&mut store,&finish).unwrap_err().contains("differs"));
    finish["finalText"]=json!("Hello. 世界.");append(&mut store,&finish).unwrap();append(&mut store,&finish).unwrap();
    assert!(completed_segment(&store,"job",&input()["segments"][0]).is_err());
    while consume(&mut store,"job").unwrap().is_some(){}
    let segment=completed_segment(&store,"job",&input()["segments"][0]).unwrap();
    assert_eq!(segment["text"],"Hello. 世界.");assert_eq!(segment["liveFragments"],json!(["Hello."," 世界."]));
    assert!(append(&mut store,&fragment(3," Late.")).is_err());
    finish["answerRevision"]=json!("changed");assert!(append(&mut store,&finish).is_err());
    super::super::contracts::validate_segment_references(&segment,&json!({"backend":"fish-cloud"})).unwrap();
    let profile=store.execute("listProfiles",&json!({})).unwrap()[0].clone();
    let hash=super::super::cache::request_hash(&segment,&profile,&json!([]),&json!({}),&json!({})).unwrap();
    let mut changed=segment.clone();changed["liveFragments"]=json!(["Hello. 世界."]);
    assert_ne!(hash,super::super::cache::request_hash(&changed,&profile,&json!([]),&json!({}),&json!({})).unwrap());
}

#[test]
fn live_restart_does_not_dispatch_detached_inputs_or_release_uncertain_spend(){
    let (cleanup,mut store)=fixture();begin(&mut store,settings(),"queued").unwrap();begin(&mut store,settings(),"running").unwrap();
    let mut running=store.execute("listJobs",&json!({})).unwrap().as_array().unwrap().iter().find(|job|job["id"]=="running").unwrap().clone();
    running["state"]=json!("running");store.put_job(&running).unwrap();drop(store);
    let mut reopened=SpeechStore::open(cleanup.0.clone()).unwrap();
    let jobs=reopened.execute("listJobs",&json!({})).unwrap();
    assert_eq!(jobs.as_array().unwrap().iter().find(|job|job["id"]=="queued").unwrap()["state"],"interrupted");
    assert_eq!(jobs.as_array().unwrap().iter().find(|job|job["id"]=="running").unwrap()["state"],"uncertain");
    assert_eq!(reopened.connection.query_row("SELECT sum(amount) FROM speech_budget",[],|row|row.get::<_,f64>(0)).unwrap(),100.0);
    drop(reopened);
}

#[test]
fn live_reservation_includes_authored_direction_without_reducing_the_spoken_text_cap(){
    let (_cleanup,mut store)=fixture();
    let mut profile=store.execute("listProfiles",&json!({})).unwrap()[0].clone();profile["direction"]=json!("calm");store.execute("saveProfile",&json!({"profile":profile})).unwrap();
    begin(&mut store,settings(),"job").unwrap();
    assert_eq!(store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id='job'",[],|row|row.get::<_,f64>(0)).unwrap(),106.0);
    assert_eq!(store.connection.query_row("SELECT characters FROM speech_live_inputs WHERE job_id='job'",[],|row|row.get::<_,i64>(0)).unwrap(),6);
    append(&mut store,&fragment(1,&"x".repeat(94))).unwrap();
    assert!(append(&mut store,&fragment(2,"x")).is_err());
}

#[test]
fn answer_admission_counts_direction_but_only_literal_content_uses_the_answer_cap(){
    let (_cleanup,mut store)=fixture();
    let mut profile=store.execute("listProfiles",&json!({})).unwrap()[0].clone();profile["direction"]=json!("calm");store.execute("saveProfile",&json!({"profile":profile})).unwrap();
    let mut value=input();value["segments"][0]["text"]=json!("x".repeat(1000));value["segments"][0]["spokenText"]=value["segments"][0]["text"].clone();
    super::super::admission::admit(&mut store,value,settings(),"2026-10-19T00:00:00Z".into(),"ordinary".into()).unwrap();
    assert_eq!(store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id='ordinary'",[],|row|row.get::<_,f64>(0)).unwrap(),1006.0);
    for text in ["[whisper] Hello.","<|speaker:9|> Hello."]{
        let mut value=input();value["segments"][0]["text"]=json!(text);value["segments"][0]["spokenText"]=json!(text);
        assert!(super::super::admission::admit(&mut store,value,settings(),"2026-10-19T00:00:00Z".into(),"unsafe".into()).unwrap_err().contains("literal"));
    }
    let mut value=input();value["segments"][0]["spokenText"]=json!("Different.");
    assert!(super::super::admission::admit(&mut store,value,settings(),"2026-10-19T00:00:00Z".into(),"different".into()).is_err());
}

fn complete(store:&mut SpeechStore)->Value{
    let mut job=begin(store,settings(),"job").unwrap();job["state"]=json!("running");store.put_job(&job).unwrap();
    let finish=json!({"jobId":"job","owner":"chat:auto:session","sequence":1,"text":"","finish":true,"answerRevision":"final","finalText":"Hello."});append(store,&finish).unwrap();
    while consume(store,"job").unwrap().is_some(){}
    let segment=completed_segment(store,"job",&input()["segments"][0]).unwrap();
    let path=store.root.join("fixture.wav");let spec=hound::WavSpec{channels:1,sample_rate:24000,bits_per_sample:16,sample_format:hound::SampleFormat::Int};
    let mut wav=hound::WavWriter::create(&path,spec).unwrap();for _ in 0..2400{wav.write_sample::<i16>(100).unwrap();}wav.finalize().unwrap();
    let asset=store.put_asset(&path,"audio/wav",0.1,24000,1).unwrap();
    let profile=store.execute("listProfiles",&json!({})).unwrap()[0].clone();
    let connection=json!({"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null});
    let hash=super::super::cache::request_hash(&segment,&profile,&json!([]),&json!({}),&connection).unwrap();
    let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
    let take=json!({"id":"live-take","projectId":null,"revisionId":"stream","segmentId":"answer","asset":asset,"createdAt":now,"generatedAt":now,"reusedFromTakeId":null,"backend":"fish-cloud","model":"drama-3","requestHash":hash,"parentTakeId":null,"favorite":false,"rating":null,"note":"","alignment":[],"spokenText":"Hello.","chapter":null});
    let request=json!({"segment":segment,"profile":profile,"dictionaries":[],"references":{},"connection":connection});
    job["takeIds"]=json!(["live-take"]);job["completedSegments"]=json!(1);store.put_completed_segment(&take,&job,&request).unwrap();job["state"]=json!("completed");store.put_job(&job).unwrap();take
}

#[test]
fn live_replay_and_durable_save_keep_the_exact_recorded_request_and_audio(){
    let (_cleanup,mut store)=fixture();let take=complete(&mut store);
    let lookup=json!({"owner":"chat:session","alternateOwner":"chat:auto:session","answerId":"answer","revision":"final","source":"Hello.","profileId":"profile"});
    assert_eq!(store.execute("findAnswerAudio",&lookup).unwrap()["asset"]["id"],take["asset"]["id"]);
    let mut wrong=lookup.clone();wrong["source"]=json!("Changed.");assert!(store.execute("findAnswerAudio",&wrong).unwrap().is_null());
    wrong=lookup.clone();wrong["owner"]=json!("chat:other");wrong["alternateOwner"]=json!("chat:auto:other");assert!(store.execute("findAnswerAudio",&wrong).unwrap().is_null());
    let save=json!({"owner":"chat:session","alternateOwner":"chat:auto:session","answerId":"answer","revision":"final","source":"Hello.","title":"Answer","sessionId":"session"});
    let project=store.execute("saveAnswerAudio",&save).unwrap();
    let takes=store.execute("listTakes",&json!({"projectId":project["id"]})).unwrap();let saved=&takes[0];assert_eq!(saved["asset"]["id"],take["asset"]["id"]);
    let request=store.execute("takeRequest",&json!({"id":saved["id"]})).unwrap();assert_eq!(request["segment"]["liveFragments"],json!(["Hello."]));
    let mut profile=store.execute("listProfiles",&json!({})).unwrap().as_array().unwrap().iter().find(|profile|profile["id"]=="profile").unwrap().clone();profile["direction"]=json!("calm");store.execute("saveProfile",&json!({"profile":profile})).unwrap();
    assert!(store.execute("findAnswerAudio",&lookup).unwrap().is_null());
}

#[test]
fn listening_reviews_are_bound_to_takes_and_survive_portable_identity_remapping(){
    let (_cleanup,mut store)=fixture();complete(&mut store);
    let mut project=store.execute("saveAnswerAudio",&json!({"owner":"chat:session","alternateOwner":"chat:auto:session","answerId":"answer","revision":"final","source":"Hello.","title":"Answer","sessionId":"session"})).unwrap();
    let takes=store.execute("listTakes",&json!({"projectId":project["id"]})).unwrap();let take=&takes[0];
    let review=json!({"id":"review","takeId":take["id"],"voiceId":"voice","language":"de-DE","reviewer":"Fixture listener","reviewedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"listened":true,"verdict":"approved","note":"Synthetic fixture only","assetId":take["asset"]["id"],"audioSha256":take["asset"]["sha256"],"requestHash":take["requestHash"],"backend":take["backend"],"model":take["model"],"generatedAt":take["generatedAt"]});
    let previous=project["revisionId"].clone();project["voiceAuditions"]=json!([review]);
    let mut corrupted=project.clone();corrupted["voiceAuditions"][0]["voiceId"]=json!("another-voice");assert!(store.execute("saveProject",&json!({"project":corrupted,"expectedRevisionId":previous})).is_err());
    project=store.execute("saveProject",&json!({"project":project,"expectedRevisionId":previous})).unwrap();
    let archive=store.portable_snapshot(project["id"].as_str().unwrap(),project["revisionId"].as_str().unwrap()).unwrap();
    let imported=store.commit_portable_snapshot(&archive).unwrap();
    assert_eq!(imported["voiceAuditions"][0]["audioSha256"],take["asset"]["sha256"]);
    assert_ne!(imported["voiceAuditions"][0]["takeId"],take["id"]);
    let mut invalid=archive.clone();invalid["project"]["voiceAuditions"][0]["requestHash"]=json!("0".repeat(64));assert!(store.commit_portable_snapshot(&invalid).is_err());
}
