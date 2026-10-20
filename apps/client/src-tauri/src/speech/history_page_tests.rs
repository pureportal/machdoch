use super::*;

#[test]
fn take_history_pages_remain_scoped_to_the_project_and_job_and_provenance_uses_the_pinned_request(){
    let directory=TestDirectory::new();let mut store=directory.open();
    let project=save(&mut store,&draft(),Value::Null).unwrap();let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24_000,1).unwrap();
    let mut ids=Vec::new();
    for index in 0..3{
        let mut recorded=take(&project,&asset);recorded["id"]=json!(format!("take-{index}"));recorded["createdAt"]=json!("2026-10-20T00:00:00.000Z");recorded["generatedAt"]=recorded["createdAt"].clone();let request=generation_request(&mut recorded);
        store.put_take(&recorded).unwrap();store.connection.execute("INSERT INTO take_requests(take_id,data) VALUES(?1,?2)",params![recorded["id"].as_str().unwrap(),request.to_string()]).unwrap();ids.push(recorded["id"].clone());
    }
    let mut job=job(&project,"running");job["takeIds"]=json!(ids);job["totalSegments"]=json!(3);job["completedSegments"]=json!(3);store.put_job(&job).unwrap();
    let first=store.execute("listTakes",&json!({"projectId":project["id"],"jobId":job["id"],"limit":1})).unwrap();let second=store.execute("listTakes",&json!({"projectId":project["id"],"jobId":job["id"],"limit":1,"offset":1})).unwrap();
    assert_eq!(first[0]["id"],"take-0");assert_eq!(second[0]["id"],"take-1");assert_eq!(store.execute("listTakes",&json!({"jobId":job["id"]})).unwrap().as_array().unwrap().len(),3);
    assert_eq!(store.execute("listTakes",&json!({"projectId":"another-project","jobId":job["id"],"limit":1})).unwrap(),json!([]));
    for page in [json!({"limit":0}),json!({"limit":501}),json!({"offset":-1})]{assert!(store.execute("listTakes",&page).is_err());}
    let request=store.execute("takeRequest",&json!({"id":"take-0"})).unwrap();let provenance=store.execute("takeProvenance",&json!({"id":"take-0"})).unwrap();assert_eq!(provenance["profile"],request["profile"]);assert_eq!(provenance["segment"],request["segment"]);assert!(provenance.get("references").is_none());
}

#[test]
fn production_lookup_resolves_old_selected_takes_without_reading_unrelated_history(){
    let directory=TestDirectory::new();let mut store=directory.open();
    let project=save(&mut store,&draft(),Value::Null).unwrap();let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24_000,1).unwrap();
    for index in 0..25{
        let mut recorded=take(&project,&asset);recorded["id"]=json!(format!("take-{index:03}"));recorded["createdAt"]=json!("2026-10-20T00:00:00.000Z");recorded["generatedAt"]=recorded["createdAt"].clone();store.put_take(&recorded).unwrap();
    }
    let first=store.execute("listTakes",&json!({"projectId":project["id"],"limit":20})).unwrap();assert_eq!(first.as_array().unwrap().len(),20);assert!(!first.as_array().unwrap().iter().any(|take|take["id"]=="take-024"));
    let resolved=store.execute("resolveTakes",&json!({"projectId":project["id"],"ids":["take-024","take-001"]})).unwrap();assert_eq!(resolved[0]["id"],"take-024");assert_eq!(resolved[1]["id"],"take-001");
    let mut other=draft();other["id"]=json!("other-project");let other=save(&mut store,&other,Value::Null).unwrap();let mut foreign=take(&other,&asset);foreign["id"]=json!("foreign-take");store.put_take(&foreign).unwrap();
    for ids in [json!(["foreign-take"]),json!(["missing"]),json!(["take-001","take-001"]),json!([null]),json!(vec!["take-001";101])]{assert!(store.execute("resolveTakes",&json!({"projectId":project["id"],"ids":ids})).is_err());}
    assert_eq!(store.execute("resolveTakes",&json!({"projectId":project["id"],"ids":[]})).unwrap(),json!([]));
    store.execute("deleteProject",&json!({"id":project["id"]})).unwrap();assert!(store.execute("resolveTakes",&json!({"projectId":project["id"],"ids":[]})).is_err());
}

#[test]
fn active_job_filter_runs_before_paging_and_preserves_owner_and_project_scope(){
    let directory=TestDirectory::new();let mut store=directory.open();let project=save(&mut store,&draft(),Value::Null).unwrap();
    for index in 0..25{let mut recorded=job(&project,"queued");recorded["id"]=json!(format!("job-{index:03}"));recorded["createdAt"]=json!(format!("2026-10-20T00:00:{index:02}.000Z"));recorded["updatedAt"]=recorded["createdAt"].clone();store.put_job(&recorded).unwrap();if index>1{recorded["state"]=json!("cancelled");store.put_job(&recorded).unwrap();}}
    let page=store.execute("listJobs",&json!({"projectId":project["id"],"states":["queued","running"],"offset":0,"limit":1})).unwrap();assert_eq!(page[0]["id"],"job-001");
    let second=store.execute("listJobs",&json!({"projectId":project["id"],"states":["queued"],"offset":1,"limit":1})).unwrap();assert_eq!(second[0]["id"],"job-000");
    assert_eq!(store.execute("listJobs",&json!({"owner":"other","states":["queued"],"limit":20})).unwrap(),json!([]));assert_eq!(store.execute("listJobs",&json!({"projectId":"other","states":["queued"],"limit":20})).unwrap(),json!([]));
    for states in [json!([]),json!(["invented"]),json!(null),json!([1])]{assert!(store.execute("listJobs",&json!({"states":states,"limit":20})).is_err());}
}
