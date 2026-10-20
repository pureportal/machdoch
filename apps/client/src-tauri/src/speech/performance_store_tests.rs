use super::*;

struct Fixture{store:SpeechStore,project:Value,source:Value,request:Value,_directory:TestDirectory}

impl Fixture{
    fn new(live:bool)->Self{
        let directory=TestDirectory::new();let mut store=directory.open();
        let dictionary=store.execute("saveDictionary",&json!({"dictionary":{"id":"dictionary-1","name":"Terms","revision":"","rules":[{"id":"rule","text":"Hello","phonemes":"HH AH0 L OW1","alphabet":"arpabet","caseSensitive":false}]}})).unwrap();
        let mut profile=profile();profile["voiceId"]=json!("voice");profile["direction"]=json!("calm");
        if live{profile["dictionaryIds"]=json!([]);}
        store.execute("saveProfile",&json!({"profile":profile})).unwrap();
        let mut draft=draft();draft["profileId"]=profile["id"].clone();draft["source"]=json!("Hello 世界.");
        let project=save(&mut store,&draft,Value::Null).unwrap();
        let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24000,1).unwrap();
        let mut source=take(&project,&asset);source["spokenText"]=json!("Hello 世界.");
        let mut segment=json!({"id":source["segmentId"],"text":"<|speaker:0|>Hello 世界.","spokenText":source["spokenText"],"chapter":null,"voiceIds":["voice"],"referenceAssetIds":[]});
        if live{segment["text"]=json!("Hello 世界.");segment["liveFragments"]=json!(["Hello ","世界."]);}
        let dictionaries=if live{json!([])}else{json!([dictionary])};
        let request=json!({"segment":segment,"profile":profile,"dictionaries":dictionaries,"references":{},"connection":{"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null}});
        source["requestHash"]=json!(super::super::super::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"]).unwrap());
        let mut job=job(&project,"running");store.put_job(&job).unwrap();job["completedSegments"]=json!(1);job["takeIds"]=json!([source["id"]]);
        store.put_completed_segment(&source,&job,&request).unwrap();job["state"]=json!("completed");store.put_job(&job).unwrap();
        let mut selected=project.clone();selected["selectedTakes"]=json!({(source["segmentId"].as_str().unwrap()):source["id"]});
        let project=save(&mut store,&selected,project["revisionId"].clone()).unwrap();
        Self{store,project,source,request,_directory:directory}
    }
    fn settings()->Value{json!({"connections":[{"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null,"configured":true}],"cloudConsent":true,"budgetLimit":null,"pricing":{"unit":"characters","perMillion":1000000,"currency":"USD","source":"Synthetic performance quote","effectiveFrom":"2000-01-01","effectiveTo":"2099-01-01"}})}
    fn input(&self)->Value{json!({"owner":"text-to-speech","takeId":self.source["id"],"note":"thoughtful 世界","takes":2,"cloudConsent":true,"budgetLimit":null})}
    fn admit(&mut self,input:Value,id:&str)->Result<Value,String>{super::super::super::generation::admit_performance(&mut self.store,input,Self::settings(),timestamp(),id.into())}
    fn snapshot(&self,id:&str)->Value{parse_json(self.store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).unwrap()).unwrap()}
    fn complete(&mut self)->Value{
        let mut input=self.input();input["takes"]=json!(1);let mut job=self.admit(input,"new-performance").unwrap();
        let snapshot=self.snapshot("new-performance");job["state"]=json!("running");self.store.put_job(&job).unwrap();
        let mut child=self.source.clone();child["id"]=json!("child");child["parentTakeId"]=self.source["id"].clone();
        child["createdAt"]=json!(timestamp());child["generatedAt"]=child["createdAt"].clone();
        let request=json!({"segment":snapshot["input"]["segments"][0],"profile":snapshot["profile"],"dictionaries":snapshot["dictionaries"],"references":snapshot["references"],"connection":self.request["connection"],"performanceNote":snapshot["performanceNote"]});
        child["requestHash"]=json!(super::super::super::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"]).unwrap());
        job["completedSegments"]=json!(1);job["takeIds"]=json!([child["id"]]);self.store.put_completed_segment(&child,&job,&request).unwrap();job["state"]=json!("completed");self.store.put_job(&job).unwrap();child
    }
}

#[test]
fn performance_preserves_the_source_revision_and_settings_after_the_live_profile_changes(){
    let mut fixture=Fixture::new(false);
    let mut changed=fixture.request["profile"].clone();changed["voiceId"]=json!("other");changed["temperature"]=json!(0.1);changed["direction"]=json!("different");fixture.store.execute("saveProfile",&json!({"profile":changed})).unwrap();
    let mut dictionary=fixture.request["dictionaries"][0].clone();dictionary["rules"][0]["phonemes"]=json!("HH EH1 L OW0");fixture.store.execute("saveDictionary",&json!({"dictionary":dictionary})).unwrap();
    let original=fixture.source.clone();let project=fixture.project.clone();fixture.admit(fixture.input(),"direction").unwrap();let snapshot=fixture.snapshot("direction");
    assert_eq!(snapshot["profile"]["direction"],"calm; thoughtful 世界");assert_eq!(snapshot["profile"]["voiceId"],"voice");assert_eq!(snapshot["profile"]["temperature"],0.7);
    assert_eq!(snapshot["dictionaries"],fixture.request["dictionaries"]);assert_eq!(snapshot["input"]["segments"][0],fixture.request["segment"]);assert_eq!(snapshot["input"]["reuseCache"],false);assert_eq!(snapshot["parentTakeId"],original["id"]);
    let billed=format!("[calm; thoughtful 世界]{}",fixture.request["segment"]["text"].as_str().unwrap());assert_eq!(snapshot["billableCharactersEstimate"],(billed.chars().count()*2) as u64);
    assert_eq!(fixture.store.timing_take(original["id"].as_str().unwrap()).unwrap(),original);assert_eq!(fixture.store.execute("getProject",&json!({"id":project["id"]})).unwrap(),project);
    assert_eq!(fixture.store.execute("listProfiles",&json!({})).unwrap()[0],changed);
}

#[test]
fn performance_rejections_leave_no_new_jobs_or_budget_reservations(){
    let mut fixture=Fixture::new(false);
    for note in ["","[whisper]","<soft>quiet</soft>","two\nlines"]{let mut input=fixture.input();input["note"]=json!(note);assert!(fixture.admit(input,"invalid").is_err());}
    let mut no_consent=fixture.input();no_consent["cloudConsent"]=json!(false);assert!(fixture.admit(no_consent,"consent").is_err());
    let mut settings=Fixture::settings();settings["connections"][0]["url"]=json!("https://other.test");let input=fixture.input();assert!(super::super::super::generation::admit_performance(&mut fixture.store,input,settings,timestamp(),"endpoint".into()).is_err());
    assert_eq!(fixture.store.connection.query_row("SELECT count(*) FROM jobs",[],|row|row.get::<_,i64>(0)).unwrap(),1);assert_eq!(fixture.store.connection.query_row("SELECT count(*) FROM speech_budget",[],|row|row.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn performance_retry_keeps_its_director_note_and_pinned_generation_material(){
    let mut fixture=Fixture::new(false);let mut job=fixture.admit(fixture.input(),"first").unwrap();let snapshot=fixture.snapshot("first");job["state"]=json!("failed");fixture.store.put_job(&job).unwrap();
    let mut input=snapshot["input"].clone();input["parentJobId"]=json!("first");assert_eq!(input["reuseCache"],false);
    let generation=super::super::super::generation::GenerationSnapshot::from_request(&snapshot,snapshot["parentTakeId"].as_str().unwrap().into(),snapshot["performanceNote"].as_str().unwrap().into()).unwrap();
    let retried=super::super::super::admission::admit_generation(&mut fixture.store,input,Fixture::settings(),timestamp(),"retry".into(),generation).unwrap();
    assert_eq!(retried["attempt"],2);assert_eq!(retried["parentJobId"],"first");let next=fixture.snapshot("retry");
    for field in ["profile","dictionaries","references","connection","parentTakeId","performanceNote"]{assert_eq!(next[field],snapshot[field]);}
}

#[test]
fn performance_lineage_and_note_survive_portable_roundtrip_and_forgery_is_rejected(){
    let mut fixture=Fixture::new(false);let child=fixture.complete();
    let project=fixture.project.clone();let archive=fixture.store.portable_snapshot(project["id"].as_str().unwrap(),project["revisionId"].as_str().unwrap()).unwrap();
    let mut forged=archive.clone();forged["takeRequests"]["child"]["performanceNote"]=json!("different");assert!(fixture.store.commit_portable_snapshot(&forged).is_err());
    let imported=fixture.store.commit_portable_snapshot(&archive).unwrap();let takes=fixture.store.execute("listTakes",&json!({"projectId":imported["id"]})).unwrap();let mapped=takes.as_array().unwrap().iter().find(|take|!take["parentTakeId"].is_null()).unwrap();
    assert_ne!(mapped["parentTakeId"],child["parentTakeId"]);assert_eq!(mapped["requestHash"],child["requestHash"]);let request=fixture.store.execute("takeRequest",&json!({"id":mapped["id"]})).unwrap();assert_eq!(request["performanceNote"],"thoughtful 世界");
    assert_eq!(fixture.store.execute("getProject",&json!({"id":project["id"]})).unwrap()["selectedTakes"],project["selectedTakes"]);
}

#[test]
fn performance_of_a_completed_live_take_is_an_explicit_new_fixed_text_generation(){
    let mut fixture=Fixture::new(true);let child=fixture.complete();let request=fixture.store.execute("takeRequest",&json!({"id":child["id"]})).unwrap();
    assert!(fixture.request["segment"].get("liveFragments").is_some());assert!(request["segment"].get("liveFragments").is_none());assert_eq!(request["segment"]["text"],fixture.request["segment"]["text"]);assert_eq!(child["parentTakeId"],fixture.source["id"]);
}
