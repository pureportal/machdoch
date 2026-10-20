use super::*;

#[test]
fn provider_response_survives_storage_cache_lineage_and_portable_projects_and_cannot_be_forged_for_reuse(){
    let directory=TestDirectory::new();let mut store=directory.open();let project=save(&mut store,&draft(),Value::Null).unwrap();let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24000,1).unwrap();let mut recorded=take(&project,&asset);
    recorded["backend"]=json!("google");recorded["model"]=json!("gemini-3.1-flash-tts-preview");
    recorded["providerResponse"]=json!({"provider":"google","modelVersion":"gemini-3.1-flash-tts-preview","responseId":"actual-fixture-response","usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":0,"totalTokenCount":3}});
    let mut request=generation_request(&mut recorded);request["profile"]["voiceId"]=json!("Kore");request["segment"]["voiceIds"]=json!(["Kore"]);request["segment"]=super::super::super::assistant_requests::prepare_segment(&request["segment"],&request["profile"]).unwrap();
    recorded["requestHash"]=json!(super::super::super::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"]).unwrap());
    let mut rendered=job(&project,"running");store.put_job(&rendered).unwrap();rendered["state"]=json!("completed");rendered["completedSegments"]=json!(1);rendered["takeIds"]=json!([recorded["id"]]);store.put_completed_segment(&recorded,&rendered,&request).unwrap();
    let mut reused=recorded.clone();reused["id"]=json!("reused-take");reused["reusedFromTakeId"]=recorded["id"].clone();rendered["id"]=json!("reused-job");rendered["state"]=json!("running");rendered["completedSegments"]=json!(0);rendered["takeIds"]=json!([]);store.put_job(&rendered).unwrap();rendered["state"]=json!("completed");rendered["completedSegments"]=json!(1);rendered["takeIds"]=json!([reused["id"]]);store.put_completed_segment(&reused,&rendered,&request).unwrap();
    let mut forged=reused.clone();forged["id"]=json!("forged-take");forged["providerResponse"]["responseId"]=json!("different-generation");assert!(store.put_take(&forged).unwrap_err().contains("providerResponse"));
    let manifest=store.portable_snapshot(project["id"].as_str().unwrap(),project["revisionId"].as_str().unwrap()).unwrap();assert_eq!(manifest["takes"].as_array().unwrap().len(),2);for take in manifest["takes"].as_array().unwrap(){assert_eq!(take["providerResponse"],recorded["providerResponse"]);}
    let imported=store.commit_portable_snapshot(&manifest).unwrap();let restored=store.execute("listTakes",&json!({"projectId":imported["id"]})).unwrap();assert_eq!(restored.as_array().unwrap().len(),2);for take in restored.as_array().unwrap(){assert_eq!(take["providerResponse"],recorded["providerResponse"]);}
    let listed=store.execute("listTakes",&json!({"projectId":project["id"]})).unwrap();assert_eq!(listed[0]["providerResponse"],recorded["providerResponse"]);assert!(store.connection.execute("UPDATE takes SET data=json_set(data,'$.providerResponse.responseId','mutated') WHERE id='take-1'",[]).is_err());
}

#[test]
fn diagnostics_includes_only_bounded_provider_response_facts_and_marks_reused_observations(){
    let directory=TestDirectory::new();let mut store=directory.open();let mut draft=draft();draft["title"]=json!("PRIVATE_PROJECT_TITLE");draft["source"]=json!("PRIVATE_SCRIPT");let project=save(&mut store,&draft,Value::Null).unwrap();let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24000,1).unwrap();
    let mut render=job(&project,"running");render["totalSegments"]=json!(12);store.put_job(&render).unwrap();
    let mut source=take(&project,&asset);source["backend"]=json!("google");source["model"]=json!("gemini-3.1-flash-tts-preview");source["spokenText"]=json!("PRIVATE_SPOKEN_TEXT");source["providerResponse"]=json!({"provider":"google","modelVersion":"returned-fixture-version","responseId":"returned-fixture-id","usageMetadata":{"candidatesTokenCount":0}});
    for index in 0..12{
        let mut observed=source.clone();observed["id"]=json!(format!("observed-{index:02}"));if index==11{observed["reusedFromTakeId"]=json!("observed-00");}
        store.put_take(&observed).unwrap();store.connection.execute("INSERT INTO job_takes VALUES(?1,?2)",params![render["id"].as_str(),observed["id"].as_str()]).unwrap();
    }
    let settings=json!({"connections":[],"cloudConsent":false,"maxConcurrent":1,"answerCharacterLimit":1000,"cacheRetentionDays":7});
    let bundle=super::super::super::diagnostics::collect(&store,&settings,&json!({"owner":"text-to-speech","limit":1}),"fixture","2026-10-20T00:00:00Z").unwrap();let job=&bundle["jobs"][0];assert_eq!(job["providerResponseTakeCount"],12);let responses=job["providerResponses"].as_array().unwrap();assert_eq!(responses.len(),10);assert!(responses.iter().any(|response|response["reused"]==true));
    for response in responses{assert_eq!(response["response"],source["providerResponse"]);assert_eq!(response["generatedAt"],source["generatedAt"]);}
    assert!(!bundle.to_string().contains("PRIVATE_"));assert!(super::super::super::diagnostics::collect(&store,&settings,&json!({"owner":"foreign","limit":1}),"fixture","2026-10-20T00:00:00Z").unwrap()["jobs"].as_array().unwrap().is_empty());
}
