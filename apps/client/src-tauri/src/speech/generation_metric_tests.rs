use super::*;
use super::super::super::job_lifecycle::{self,RunOutcome};

#[test]
fn dispatch_measurements_preserve_each_queue_wait_and_match_late_worker_observations_by_ordinal(){
    let directory=TestDirectory::new();let mut store=directory.open();let project=save(&mut store,&draft(),Value::Null).unwrap();let mut queued=job(&project,"queued");queued["createdAt"]=json!("2026-10-20T00:00:00.000Z");queued["updatedAt"]=queued["createdAt"].clone();store.put_job(&queued).unwrap();let id=queued["id"].as_str().unwrap();
    job_lifecycle::claim_next(&mut store,1,"2026-10-20T00:00:01.500Z".into()).unwrap().unwrap();let yielded=job_lifecycle::finish(&mut store,id,Ok(RunOutcome::Yielded),false,false,"2026-10-20T00:00:02.000Z".into()).unwrap();job_lifecycle::claim_next(&mut store,1,"2026-10-20T00:00:03.000Z".into()).unwrap().unwrap();
    store.finish_dispatch_measurement(&yielded,&json!({"ordinal":1,"workerRunningMs":22.5,"cancellationInitiatedMs":null,"cancellationWorkerReleasedMs":null})).unwrap();let report=store.generation_performance(id).unwrap();let dispatches=report["dispatches"].as_array().unwrap();assert_eq!(dispatches.len(),2);assert_eq!(dispatches[0]["ordinal"],2);assert_eq!(dispatches[0]["state"],"running");assert_eq!(dispatches[0]["measurements"]["queueDelayMs"],1000.0);assert_eq!(dispatches[1]["measurements"]["queueDelayMs"],1500.0);assert_eq!(dispatches[1]["measurements"]["workerRunningMs"],22.5);assert_eq!(dispatches[1]["finishedAt"],"2026-10-20T00:00:02.000Z");
    drop(store);let store=directory.open();let recovered=store.generation_performance(id).unwrap();assert_eq!(recovered["dispatches"][0]["state"],"uncertain");assert!(recovered["dispatches"][0]["measurements"]["workerRunningMs"].is_null());assert_eq!(recovered["dispatches"][1]["measurements"]["workerRunningMs"],22.5);
}

#[test]
fn generation_measurements_separate_provider_cache_failure_and_unknown_first_audio(){
    let directory=TestDirectory::new();let mut store=directory.open();let snapshot=json!({"jobId":"job","profile":{"backend":"fish-cloud","model":"drama-3"},"PRIVATE_SCRIPT":"never include this","references":{"private":"recording"}});let segment=json!({"id":"segment","text":"PRIVATE_SCRIPT"});
    for index in 1..=20{store.record_request_measurement(&snapshot,&segment,"provider",index as f64*10.0,Some(index as f64),Some(2.0),"completed",true).unwrap();}
    store.record_request_measurement(&snapshot,&segment,"cache",1.0,None,Some(2.0),"completed",false).unwrap();store.record_request_measurement(&snapshot,&segment,"provider",99999.0,None,None,"failed",true).unwrap();let report=store.generation_performance("job").unwrap();assert_eq!(report["requestCount"],22);let groups=report["recentSuccessfulProviderPercentiles"].as_array().unwrap();let latency=groups.iter().find(|value|value["metric"]=="transportPrepareToFirstFrameMs").unwrap();assert_eq!(latency["count"],20);assert_eq!(latency["p50"],10.0);assert_eq!(latency["p95"],19.0);let cache=report["recentRequests"].as_array().unwrap().iter().find(|value|value["source"]=="cache").unwrap();assert!(cache["transportPrepareToFirstFrameMs"].is_null());assert!(cache["renderSpeed"].is_null());assert!(!report.to_string().contains("PRIVATE_SCRIPT"));assert!(!report.to_string().contains("recording"));
}
