use super::*;

struct Cleanup(PathBuf);
impl Drop for Cleanup{fn drop(&mut self){fs::remove_dir_all(&self.0).unwrap();}}
struct Fixture{store:SpeechStore,project:Value,take:Value,_cleanup:Cleanup}

impl Fixture{
    fn new(duration:u32)->Self{
        let path=std::env::temp_dir().join(format!("speech-timing-{}",uuid().unwrap()));
        let mut store=SpeechStore::open(path.clone()).unwrap();
        let profile=json!({"id":"profile","name":"Synthetic timing fixture","backend":"fish-cloud","model":"drama-3","voiceId":"voice","direction":"","temperature":0.7,"topP":0.7,"chunkLength":200,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1.0});
        store.execute("saveProfile",&json!({"profile":profile})).unwrap();
        let project=store.execute("saveProject",&json!({"expectedRevisionId":null,"project":{"id":"project","title":"Timing fixture","source":"Hello.","cast":[],"profileId":"profile","revisionId":"","parentRevisionId":null,"createdAt":"","updatedAt":"","archived":false,"location":null,"timeline":[],"selectedTakes":{},"bookmarks":[],"variants":[]}})).unwrap();
        let source=path.join("source.wav");
        let mut writer=hound::WavWriter::create(&source,hound::WavSpec{channels:1,sample_rate:16000,bits_per_sample:16,sample_format:hound::SampleFormat::Int}).unwrap();
        for _ in 0..duration*16000{writer.write_sample::<i16>(100).unwrap();}writer.finalize().unwrap();
        let asset=store.put_asset(&source,"audio/wav",f64::from(duration),16000,1).unwrap();
        let segment=json!({"id":"segment","text":"Hello.","spokenText":"Hello.","chapter":null,"voiceIds":["voice"],"referenceAssetIds":[]});
        let connection=json!({"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null});
        let hash=super::super::cache::request_hash(&segment,&profile,&json!([]),&json!({}),&connection).unwrap();
        let now=timestamp();
        let take=json!({"id":"take","projectId":project["id"],"revisionId":project["revisionId"],"segmentId":"segment","spokenText":"Hello.","chapter":null,"asset":asset,"createdAt":now,"generatedAt":now,"reusedFromTakeId":null,"backend":"fish-cloud","model":"drama-3","requestHash":hash,"parentTakeId":null,"favorite":false,"rating":null,"note":"","alignment":[]});
        store.put_take(&take).unwrap();
        store.connection.execute("INSERT INTO take_requests VALUES(?1,?2)",params!["take",json!({"segment":segment,"profile":profile,"dictionaries":[],"references":{},"connection":connection}).to_string()]).unwrap();
        Self{store,project,take,_cleanup:Cleanup(path)}
    }
    fn input(&self)->Value{json!({"owner":"studio","takeId":"take","provider":"openai","model":"whisper-1","language":null,"pricing":{"perMinute":1.0,"billingIncrementSeconds":1,"currency":"USD","source":"Synthetic account quote","effectiveFrom":"2000-01-01","effectiveTo":"2099-01-01"},"budgetLimit":null,"cloudConsent":true,"reuseCache":true})}
    fn admit(&mut self,input:Value,id:&str)->Result<Value,String>{self.store.admit_timing(input,&json!({"cloudConsent":true,"budgetLimit":null}),&"f".repeat(64),true,timestamp(),id.into())}
    fn complete(&mut self)->Value{
        let mut job=self.admit(self.input(),"job").unwrap();job["state"]=json!("running");self.store.put_job(&job).unwrap();
        let window=super::super::transcript_timing::chunks(self.take["asset"]["duration"].as_f64().unwrap()).unwrap()[0].clone();
        let mut chunk=super::super::transcript_timing::parse_chunk(&json!({"text":"Hello.","words":[{"word":"Hello.","start":0.1,"end":0.8}],"language":"english","usage":{"type":"duration","seconds":1}}),&window,self.take["asset"]["duration"].as_f64().unwrap()).unwrap();
        chunk["window"]=window.clone();chunk["audioSha256"]=self.take["asset"]["sha256"].clone();chunk["uploadDuration"]=json!(1.0);chunk["receivedAt"]=json!(timestamp());chunk["admittedAt"]=job["createdAt"].clone();
        job["completedSegments"]=json!(1);self.store.put_timing_chunk(&job,0,&chunk).unwrap();
        let result=json!({"id":"timing","takeId":"take","assetId":self.take["asset"]["id"],"assetSha256":self.take["asset"]["sha256"],"provider":"openai","model":"whisper-1","languageHint":null,"transcript":"Hello.","words":chunk["words"],"createdAt":timestamp(),"measuredAt":chunk["receivedAt"],"jobId":"job","requestHash":super::super::transcript_timing::request_hash(self.take["asset"]["sha256"].as_str().unwrap(),None,&"f".repeat(64)),"provenance":{"encoderSha256":"f".repeat(64),"sourceDuration":self.take["asset"]["duration"],"admittedAt":job["createdAt"],"sampleRate":16000,"channels":1,"pipeline":1,"chunks":[{"window":window,"audioSha256":chunk["audioSha256"],"responseSha256":chunk["responseSha256"],"uploadDuration":1.0,"providerText":"Hello.","language":"english","usage":chunk["usage"]}]},"pricing":self.input()["pricing"],"estimatedCost":1.0/60.0,"reusedFromTimingId":null});
        job["timingId"]=json!("timing");self.store.put_timing(&result,&job).unwrap();job["state"]=json!("completed");self.store.put_job(&job).unwrap();result
    }
}

#[test]
fn timing_requires_explicit_provider_consent_and_a_verified_rate_when_budgeted(){
    let mut fixture=Fixture::new(1);
    let mut input=fixture.input();input["model"]=json!("gpt-4o-transcribe");assert!(fixture.admit(input,"wrong-model").is_err());
    let mut input=fixture.input();input["cloudConsent"]=json!(false);assert!(fixture.admit(input,"no-consent").is_err());
    let mut input=fixture.input();input["pricing"]=Value::Null;input["budgetLimit"]=json!(1);assert!(fixture.admit(input,"unknown-rate").unwrap_err().contains("verified"));
    let mut input=fixture.input();input["pricing"]["currency"]=json!("EUR");fixture.admit(fixture.input(),"usd").unwrap();assert!(fixture.admit(input,"eur").unwrap_err().contains("currency"));
    assert_eq!(fixture.store.connection.query_row("SELECT count(*) FROM jobs",[],|row|row.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn timing_is_immutable_selected_by_revision_and_portable_without_changing_synthesis(){
    let mut fixture=Fixture::new(1);let result=fixture.complete();
    assert!(fixture.store.connection.execute("UPDATE speech_timings SET data='{}' WHERE id='timing'",[]).is_err());
    assert!(fixture.store.connection.execute("UPDATE speech_timing_chunks SET data='{}' WHERE job_id='job'",[]).is_err());
    let original=fixture.store.execute("listTakes",&json!({"projectId":"project"})).unwrap();assert_eq!(original[0]["alignment"],json!([]));
    let mut project=fixture.project.clone();project["timingSelections"]=json!({"take":"timing"});
    let saved=fixture.store.execute("saveProject",&json!({"project":project,"expectedRevisionId":fixture.project["revisionId"]})).unwrap();
    let mut view=original.clone();fixture.store.apply_project_timing(&saved,&mut view).unwrap();assert_eq!(view[0]["alignment"],result["words"]);assert_eq!(view[0]["requestHash"],original[0]["requestHash"]);
    let archive=fixture.store.portable_snapshot("project",saved["revisionId"].as_str().unwrap()).unwrap();let imported=fixture.store.commit_portable_snapshot(&archive).unwrap();
    let selected=imported["timingSelections"].as_object().unwrap().iter().next().unwrap();assert_ne!(selected.0,"take");assert_ne!(selected.1,"timing");
    let records=fixture.store.project_timings(&imported).unwrap();assert_eq!(records[0]["words"],result["words"]);
    let mut wrong=saved.clone();wrong["timingSelections"]=json!({"take":"missing"});assert!(fixture.store.execute("saveProject",&json!({"project":wrong,"expectedRevisionId":saved["revisionId"]})).is_err());
}

#[test]
fn cached_timing_reserves_zero_without_upload_consent_or_additional_budget(){
    let mut fixture=Fixture::new(1);fixture.complete();
    let mut input=fixture.input();input["cloudConsent"]=json!(false);input["pricing"]=Value::Null;input["budgetLimit"]=json!(0);
    let job=fixture.store.admit_timing(input,&json!({"cloudConsent":false,"budgetLimit":0}),&"f".repeat(64),false,timestamp(),"cached".into()).unwrap();
    assert_eq!(job["kind"],"alignment");assert_eq!(fixture.store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id='cached'",[],|row|row.get::<_,f64>(0)).unwrap(),0.0);
}

#[test]
fn uncertain_timing_retry_reuses_only_committed_exact_audio_windows(){
    let mut fixture=Fixture::new(601);let mut job=fixture.admit(fixture.input(),"original").unwrap();job["state"]=json!("running");fixture.store.put_job(&job).unwrap();
    let window=super::super::transcript_timing::chunks(601.0).unwrap()[0].clone();let chunk=json!({"window":window,"words":[],"providerText":"","audioSha256":"a".repeat(64),"uploadDuration":601.0,"receivedAt":timestamp(),"admittedAt":job["createdAt"]});
    job["completedSegments"]=json!(1);fixture.store.put_timing_chunk(&job,0,&chunk).unwrap();job["state"]=json!("uncertain");fixture.store.put_job(&job).unwrap();
    let mut input=fixture.input();input["parentJobId"]=json!("original");input["confirmedUncertain"]=json!(false);assert!(fixture.admit(input.clone(),"unconfirmed").is_err());
    input["confirmedUncertain"]=json!(true);let next=fixture.admit(input.clone(),"retry").unwrap();assert_eq!(next["completedSegments"],1);assert_eq!(next["attempt"],2);assert_eq!(fixture.store.timing_chunks("retry").unwrap(),vec![chunk]);
    assert!((fixture.store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id='retry'",[],|row|row.get::<_,f64>(0)).unwrap()-2.0/60.0).abs()<1e-12);
    input["language"]=json!("de");assert!(fixture.admit(input,"changed").is_err());
}

#[test]
fn transcription_usage_settlement_retains_committed_and_uncertain_windows_without_charging_the_unsent_remainder(){
    let mut fixture=Fixture::new(1201);let mut job=fixture.admit(fixture.input(),"usage").unwrap();job["state"]=json!("running");fixture.store.put_job(&job).unwrap();
    let window=super::super::transcript_timing::chunks(1201.0).unwrap()[0].clone();let chunk=json!({"window":window,"words":[],"providerText":"","audioSha256":"a".repeat(64),"uploadDuration":601.0,"receivedAt":timestamp(),"admittedAt":job["createdAt"]});
    job["completedSegments"]=json!(1);fixture.store.put_timing_chunk(&job,0,&chunk).unwrap();
    let pending=super::super::job_lifecycle::request_cancel(&mut fixture.store,"studio","usage",timestamp()).unwrap();assert_eq!(pending["state"],"running");
    let stopped=super::super::job_lifecycle::finish(&mut fixture.store,"usage",Err("Transcription cancelled.".into()),true,true,timestamp()).unwrap();
    assert_eq!(stopped["state"],"uncertain");assert_eq!(stopped["usage"]["completedRequests"],1);assert_eq!(stopped["usage"]["inputAudioSeconds"],601.0);
    let retained=fixture.store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id='usage'",[],|row|row.get::<_,f64>(0)).unwrap();assert!((retained-(601.0+602.0)/60.0).abs()<1e-12);
}

#[test]
fn portable_timing_rejects_missing_mismatched_and_cyclic_evidence(){
    let mut fixture=Fixture::new(1);fixture.complete();
    let mut project=fixture.project.clone();project["timingSelections"]=json!({"take":"timing"});
    let saved=fixture.store.execute("saveProject",&json!({"project":project,"expectedRevisionId":fixture.project["revisionId"]})).unwrap();
    let archive=fixture.store.portable_snapshot("project",saved["revisionId"].as_str().unwrap()).unwrap();
    let mut missing=archive.clone();missing["timingResults"]=json!([]);assert!(fixture.store.commit_portable_snapshot(&missing).is_err());
    let mut mismatch=archive.clone();mismatch["timingResults"][0]["assetSha256"]=json!("a".repeat(64));assert!(fixture.store.commit_portable_snapshot(&mismatch).is_err());
    let mut cycle=archive.clone();cycle["timingResults"][0]["reusedFromTimingId"]=json!("timing");assert!(fixture.store.commit_portable_snapshot(&cycle).is_err());
    let mut words=archive;words["timingResults"][0]["words"][0]["end"]=json!(2);assert!(fixture.store.commit_portable_snapshot(&words).is_err());
    assert_eq!(fixture.store.execute("listProjects",&json!({"offset":0,"limit":20})).unwrap()["projects"].as_array().unwrap().len(),1);
}

#[test]
fn timing_cleanup_and_project_deletion_preserve_active_and_unknown_workspaces(){
    let mut fixture=Fixture::new(1);fixture.complete();fixture.admit(fixture.input(),"active").unwrap();
    let temporary=fixture.store.root.join("temporary");
    for id in ["job","active","unknown"]{let directory=temporary.join(format!("timing-{id}"));fs::create_dir_all(&directory).unwrap();fs::write(directory.join("upload.wav"),b"synthetic temporary upload").unwrap();}
    super::timing_store::clean_workspaces(&fixture.store.connection,&fixture.store.root,None).unwrap();
    assert!(!temporary.join("timing-job").exists());assert!(temporary.join("timing-active/upload.wav").exists());assert!(temporary.join("timing-unknown/upload.wav").exists());
    let mut active:Value=fixture.store.execute("listJobs",&json!({"owner":"studio"})).unwrap().as_array().unwrap().iter().find(|job|job["id"]=="active").unwrap().clone();active["state"]=json!("cancelled");fixture.store.put_job(&active).unwrap();
    fixture.store.execute("deleteProject",&json!({"id":"project"})).unwrap();
    assert!(!temporary.join("timing-active").exists());assert!(temporary.join("timing-unknown/upload.wav").exists());
    for table in ["speech_timings","speech_timing_chunks","revision_timings"]{assert_eq!(fixture.store.connection.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get::<_,i64>(0)).unwrap(),0);}
}
