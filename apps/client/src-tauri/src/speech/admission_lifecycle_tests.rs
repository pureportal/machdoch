use super::*;
use super::super::super::{job_lifecycle::{self,RunOutcome},cache};

fn now()->String{chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}
fn snapshot(store:&SpeechStore,id:&str)->Value{let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).unwrap();serde_json::from_str(&data).unwrap()}
fn amount(store:&SpeechStore,id:&str)->f64{store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id=?1",[id],|row|row.get(0)).unwrap()}
fn request()->Value{
    let mut request=input("studio","A世🚀");let segment=request["segments"][0].clone();
    request["segments"]=json!((0..3).map(|index|{let mut value=segment.clone();value["id"]=json!(format!("segment-{index}"));value}).collect::<Vec<_>>());request
}
fn start(store:&mut SpeechStore,mut job:Value)->Value{job["state"]=json!("running");job["updatedAt"]=json!(now());store.put_job(&job).unwrap();job}
fn commit(store:&mut SpeechStore,job:&mut Value,reused:Option<&str>)->Value{commit_at(store,job,reused,now())}
fn commit_at(store:&mut SpeechStore,job:&mut Value,reused:Option<&str>,at:String)->Value{
    let snapshot=snapshot(store,job["id"].as_str().unwrap());let ordinal=job["completedSegments"].as_u64().unwrap() as usize;
    let segment=&snapshot["input"]["segments"][ordinal%snapshot["input"]["segments"].as_array().unwrap().len()];
    let path=store.root.join("fixture.wav");let mut writer=hound::WavWriter::create(&path,hound::WavSpec{channels:1,sample_rate:24000,bits_per_sample:16,sample_format:hound::SampleFormat::Int}).unwrap();for _ in 0..240{writer.write_sample::<i16>(1).unwrap();}writer.finalize().unwrap();
    let asset=store.put_asset(&path,"audio/wav",0.01,24000,1).unwrap();
    let hash=cache::request_hash(segment,&snapshot["profile"],&snapshot["dictionaries"],&snapshot["references"],&snapshot["connection"]).unwrap();
    let generated_at=if let Some(id)=reused{let data:String=store.connection.query_row("SELECT data FROM takes WHERE id=?1",[id],|row|row.get(0)).unwrap();serde_json::from_str::<Value>(&data).unwrap()["generatedAt"].clone()}else{job["createdAt"].clone()};
    let take=json!({"id":format!("{}-{ordinal}",job["id"].as_str().unwrap()),"projectId":job["projectId"],"revisionId":job["revisionId"],"segmentId":segment["id"],"spokenText":segment["spokenText"],"chapter":null,"asset":asset,"createdAt":at,"generatedAt":generated_at,"reusedFromTakeId":reused,"backend":"fish-cloud","model":"drama-3","requestHash":hash,"parentTakeId":null,"favorite":false,"rating":null,"note":"","alignment":[]});
    job["takeIds"].as_array_mut().unwrap().push(take["id"].clone());job["completedSegments"]=json!(ordinal+1);job["updatedAt"]=json!(at);
    let pinned=json!({"segment":segment,"profile":snapshot["profile"],"dictionaries":snapshot["dictionaries"],"references":snapshot["references"],"connection":{"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null}});
    store.put_completed_segment(&take,job,&pinned).unwrap();take
}

#[test]
fn interactive_work_and_pause_yield_only_between_committed_segments_without_releasing_the_remaining_reservation(){
    let directory=TestStore::new();let mut store=directory.open();let job=admit_now(&mut store,request(),settings(),"book").unwrap();let mut job=start(&mut store,job);
    assert!(!job_lifecycle::should_yield(&store,&job,true).unwrap());commit(&mut store,&mut job,None);
    let mut interactive=input("chat:manual:test","Hello");interactive["priority"]=json!(100);admit_now(&mut store,interactive,settings(),"interactive").unwrap();
    assert!(job_lifecycle::should_yield(&store,&job,true).unwrap());let yielded=job_lifecycle::finish(&mut store,"book",Ok(RunOutcome::Yielded),false,false,now()).unwrap();
    assert_eq!(yielded["state"],"queued");assert_eq!(yielded["completedSegments"],1);assert_eq!(yielded["takeIds"],job["takeIds"]);assert_eq!(amount(&store,"book"),9.0);
    job_lifecycle::request_cancel(&mut store,"chat:manual:test","interactive",now()).unwrap();let mut resumed=start(&mut store,yielded);
    assert!(!job_lifecycle::should_yield(&store,&resumed,true).unwrap());store.execute("queue",&json!({"paused":true})).unwrap();assert!(job_lifecycle::should_yield(&store,&resumed,true).unwrap());
    store.execute("queue",&json!({"paused":false})).unwrap();commit(&mut store,&mut resumed,None);commit(&mut store,&mut resumed,None);
    assert!(!job_lifecycle::should_yield(&store,&resumed,true).unwrap());let done=job_lifecycle::finish(&mut store,"book",Ok(RunOutcome::Completed),false,false,now()).unwrap();
    assert_eq!(done["state"],"completed");assert_eq!(done["usage"]["characters"],9);assert_eq!(done["usage"]["utf8Bytes"],24);assert_eq!(done["usage"]["completedRequests"],3);assert_eq!(amount(&store,"book"),9.0);
}

#[test]
fn cancellation_keeps_inflight_charge_uncertainty_and_releases_only_known_unsent_work(){
    for dispatched in [false,true]{
        let directory=TestStore::new();let mut store=directory.open();let job=admit_now(&mut store,request(),settings(),"book").unwrap();let mut job=start(&mut store,job);commit(&mut store,&mut job,None);
        assert!(job_lifecycle::request_cancel(&mut store,"wrong-owner","book",now()).is_err());
        let pending=job_lifecycle::request_cancel(&mut store,"studio","book",now()).unwrap();assert_eq!(pending["state"],"running");assert!(pending["cancelRequestedAt"].is_string());assert!(store.put_job(&job).unwrap_err().contains("cancellation"));
        let stopped=job_lifecycle::finish(&mut store,"book",Err("Speech cancelled.".into()),true,dispatched,now()).unwrap();assert_eq!(stopped["state"],if dispatched{"uncertain"}else{"cancelled"});
        assert_eq!(stopped["usage"]["estimatedCommittedCost"],3.0);assert_eq!(stopped["usage"]["estimatedUncertainCost"],if dispatched{3.0}else{0.0});assert_eq!(amount(&store,"book"),if dispatched{6.0}else{3.0});
        assert_eq!(stopped["usage"]["uncertainRequests"],u64::from(dispatched));if dispatched{assert!(stopped["error"].as_str().unwrap().contains("another charge"));}
        assert_eq!(job_lifecycle::request_cancel(&mut store,"studio","book",now()).unwrap(),stopped);
    }
}

#[test]
fn cancelling_a_queued_or_yielded_job_retains_estimates_for_already_generated_audio(){
    let directory=TestStore::new();let mut store=directory.open();let job=admit_now(&mut store,request(),settings(),"book").unwrap();
    let cancelled=job_lifecycle::request_cancel(&mut store,"studio","book",now()).unwrap();assert_eq!(cancelled["state"],"cancelled");assert_eq!(amount(&store,"book"),0.0);
    let mut request=request();request["parentJobId"]=job["id"].clone();let job=admit_now(&mut store,request,settings(),"retry").unwrap();let mut job=start(&mut store,job);commit(&mut store,&mut job,None);
    job_lifecycle::finish(&mut store,"retry",Ok(RunOutcome::Yielded),false,false,now()).unwrap();job_lifecycle::request_cancel(&mut store,"studio","retry",now()).unwrap();assert_eq!(amount(&store,"retry"),3.0);
}

#[test]
fn retry_usage_excludes_parent_takes_and_a_known_rejection_releases_the_unsent_estimate(){
    let directory=TestStore::new();let mut store=directory.open();let job=admit_now(&mut store,request(),settings(),"book").unwrap();let mut job=start(&mut store,job);commit(&mut store,&mut job,None);
    let failed=job_lifecycle::finish(&mut store,"book",Err("Rate limited.".into()),false,false,now()).unwrap();assert_eq!(amount(&store,"book"),3.0);
    let mut request=request();request["parentJobId"]=json!("book");let job=admit_now(&mut store,request,settings(),"retry").unwrap();assert_eq!(job["takeIds"],failed["takeIds"]);assert_eq!(amount(&store,"retry"),6.0);
    let mut job=start(&mut store,job);commit(&mut store,&mut job,None);commit(&mut store,&mut job,None);let done=job_lifecycle::finish(&mut store,"retry",Ok(RunOutcome::Completed),false,false,now()).unwrap();
    assert_eq!(done["usage"]["estimatedCommittedCost"],6.0);assert_eq!(done["usage"]["characters"],6);assert_eq!(amount(&store,"retry"),6.0);
}

#[test]
fn admitted_cache_audio_is_pinned_and_cannot_turn_into_an_unreserved_provider_call(){
    let directory=TestStore::new();let mut store=directory.open();let job=admit_now(&mut store,input("studio","A世🚀"),settings(),"original").unwrap();let mut job=start(&mut store,job);let take=commit(&mut store,&mut job,None);job_lifecycle::finish(&mut store,"original",Ok(RunOutcome::Completed),false,false,now()).unwrap();
    let mut request=input("studio","A世🚀");request["reuseCache"]=json!(true);request["cloudConsent"]=json!(false);request["budgetLimit"]=json!(3);
    let job=admit_now(&mut store,request,settings(),"cached").unwrap();assert_eq!(amount(&store,"cached"),0.0);let snapshot=snapshot(&store,"cached");let segment=&snapshot["input"]["segments"][0];
    assert_eq!(snapshot["cachedTakes"]["segment"],take["id"]);assert_eq!(cache::admitted_take(&store,&snapshot,segment,take["requestHash"].as_str().unwrap(),0).unwrap().unwrap()["id"],take["id"]);assert!(cache::admitted_take(&store,&snapshot,segment,take["requestHash"].as_str().unwrap(),1).unwrap().is_none());
    let mut job=start(&mut store,job);commit(&mut store,&mut job,take["id"].as_str());let done=job_lifecycle::finish(&mut store,"cached",Ok(RunOutcome::Completed),false,false,now()).unwrap();assert_eq!(done["usage"]["reusedSegments"],1);assert_eq!(amount(&store,"cached"),0.0);
    store.connection.execute("INSERT INTO speech_cache_evictions VALUES(?1,?2,0)",params![take["asset"]["id"].as_str().unwrap(),now()]).unwrap();assert!(cache::admitted_take(&store,&snapshot,segment,take["requestHash"].as_str().unwrap(),0).unwrap_err().contains("new render"));
}

#[test]
fn uncertain_live_usage_keeps_the_character_or_utf8_reservation_and_unknown_cost_is_never_reported_as_zero(){
    for (unit,expected) in [("characters",100.0),("utf8Bytes",400.0)]{
        let directory=TestStore::new();let mut store=directory.open();let mut settings=settings();settings["pricing"]["unit"]=json!(unit);
        let job=super::super::admit_live(&mut store,input("chat:manual:test","Hello"),settings,now(),"live".into(),100).unwrap();start(&mut store,job);
        job_lifecycle::request_cancel(&mut store,"chat:manual:test","live",now()).unwrap();assert!(super::super::super::live_input::append(&mut store,&json!({"owner":"chat:manual:test","jobId":"live","sequence":1,"text":" late","finish":false})).unwrap_err().contains("cancelling"));
        let stopped=job_lifecycle::finish(&mut store,"live",Err("Connection ended.".into()),false,true,now()).unwrap();assert_eq!(stopped["usage"]["estimatedCommittedCost"],0.0);assert_eq!(stopped["usage"]["estimatedUncertainCost"],expected);assert_eq!(amount(&store,"live"),expected);
    }
    let directory=TestStore::new();let mut store=directory.open();let mut settings=settings();settings["pricing"]=Value::Null;let job=admit_now(&mut store,input("studio","Unknown cost"),settings,"unknown").unwrap();start(&mut store,job);
    let stopped=job_lifecycle::finish(&mut store,"unknown",Err("Connection ended.".into()),false,true,now()).unwrap();assert!(stopped["usage"]["estimatedUncertainCost"].is_null());assert_eq!(stopped["usage"]["uncertainRequests"],1);
}


#[test]
fn equal_priority_books_rotate_at_committed_boundaries_even_with_identical_clocks(){
    let directory=TestStore::new();let mut store=directory.open();
    for id in ["book-a","book-b"]{admit_now(&mut store,request(),settings(),id).unwrap();}
    let fixed=now();let mut order=Vec::new();
    for round in 0..6{
        let mut job=job_lifecycle::claim_next(&mut store,1,fixed.clone()).unwrap().unwrap();
        let id=job["id"].as_str().unwrap().to_owned();order.push(id.clone());
        assert!(!job_lifecycle::should_yield(&store,&job,false).unwrap());
        assert!(job_lifecycle::claim_next(&mut store,1,fixed.clone()).unwrap().is_none());
        commit_at(&mut store,&mut job,None,fixed.clone());
        if job["completedSegments"]==job["totalSegments"]{
            assert!(!job_lifecycle::should_yield(&store,&job,true).unwrap());
            job_lifecycle::finish(&mut store,&id,Ok(RunOutcome::Completed),false,false,fixed.clone()).unwrap();
        }else{
            assert!(job_lifecycle::should_yield(&store,&job,true).unwrap());
            job_lifecycle::finish(&mut store,&id,Ok(RunOutcome::Yielded),false,false,fixed.clone()).unwrap();
        }
        if round==0{drop(store);store=directory.open();}
    }
    assert_eq!(order,vec!["book-a","book-b","book-a","book-b","book-a","book-b"]);
    assert!(job_lifecycle::claim_next(&mut store,1,fixed).unwrap().is_none());
    for id in ["book-a","book-b"]{
        let jobs=store.execute("listJobs",&json!({"id":id,"limit":1})).unwrap();
        assert_eq!(jobs[0]["state"],"completed");assert_eq!(jobs[0]["completedSegments"],3);
        assert_eq!(jobs[0]["usage"]["completedRequests"],3);assert_eq!(amount(&store,id),9.0);
    }
}

#[test]
fn dispatch_keeps_priority_concurrency_and_pause_ahead_of_round_robin_fairness(){
    let directory=TestStore::new();let mut store=directory.open();
    admit_now(&mut store,request(),settings(),"book").unwrap();
    let book=job_lifecycle::claim_next(&mut store,1,now()).unwrap().unwrap();
    let mut urgent=input("chat:manual:test","Hello");urgent["priority"]=json!(100);
    admit_now(&mut store,urgent,settings(),"urgent").unwrap();
    assert!(job_lifecycle::should_yield(&store,&book,false).unwrap());
    store.execute("queue",&json!({"paused":true})).unwrap();
    assert!(job_lifecycle::claim_next(&mut store,2,now()).unwrap().is_none());
    store.execute("queue",&json!({"paused":false})).unwrap();
    assert_eq!(job_lifecycle::claim_next(&mut store,2,now()).unwrap().unwrap()["id"],"urgent");
    assert!(job_lifecycle::claim_next(&mut store,2,now()).unwrap().is_none());
    assert!(job_lifecycle::claim_next(&mut store,0,now()).is_err());
}

#[test]
fn streaming_lookup_reads_only_the_requested_owned_segment_and_rejects_stopped_or_wrong_backend_jobs(){
    let directory=TestStore::new();let mut store=directory.open();
    let job=admit_now(&mut store,request(),settings(),"book").unwrap();let mut job=start(&mut store,job);
    let read=|store:&SpeechStore,owner:&str,segment:&str|super::super::super::stream_read::completed_asset(store,owner,"book",segment);
    assert!(read(&store,"studio","segment-0").unwrap().is_none());
    assert!(read(&store,"another-owner","segment-0").is_err());
    assert!(read(&store,"studio","foreign-segment").is_err());
    let take=commit(&mut store,&mut job,None);
    assert_eq!(read(&store,"studio","segment-0").unwrap().as_deref(),take["asset"]["id"].as_str());
    assert!(read(&store,"studio","segment-1").unwrap().is_none());
    store.connection.execute("UPDATE speech_requests SET snapshot=json_set(snapshot,'$.profile.backend','openai') WHERE job_id='book'",[]).unwrap();
    assert!(read(&store,"studio","segment-0").unwrap_err().contains("completed audio"));
    store.connection.execute("UPDATE speech_requests SET snapshot=json_set(snapshot,'$.profile.backend','fish-cloud') WHERE job_id='book'",[]).unwrap();
    job_lifecycle::finish(&mut store,"book",Err("Stream cancelled".into()),true,false,now()).unwrap();
    assert!(read(&store,"studio","segment-0").unwrap_err().contains("cancelled"));
}
