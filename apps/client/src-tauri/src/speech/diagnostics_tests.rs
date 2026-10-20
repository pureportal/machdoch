use super::*;
use super::super::super::{diagnostics,job_lifecycle};

#[test]
fn diagnostics_project_only_scoped_job_facts_and_setting_names_without_private_content_or_credentials(){
    let directory=TestStore::new();let mut store=directory.open();
    admit_now(&mut store,input("private-owner-session","PRIVATE_SCRIPT_AND_ANSWER"),settings(),"owned").unwrap();
    admit_now(&mut store,input("other-owner","FOREIGN_PRIVATE_SCRIPT"),settings(),"foreign").unwrap();
    job_lifecycle::claim_next(&mut store,1,chrono::Utc::now().to_rfc3339()).unwrap().unwrap();
    job_lifecycle::finish(&mut store,"owned",Err("PRIVATE_PROVIDER_ERROR_AND_SECRET".into()),false,false,chrono::Utc::now().to_rfc3339()).unwrap();
    store.connection.execute("UPDATE speech_requests SET snapshot=json_set(snapshot,'$.references.private.transcript','PRIVATE_REFERENCE_TRANSCRIPT','$.references.private.rights','PRIVATE_RIGHTS_RECORD','$.profile.name','PRIVATE_PROFILE_NAME','$.dictionaries',json('[{\"rules\":[{\"text\":\"PRIVATE_DICTIONARY_RULE\"}]}]')) WHERE job_id='owned'",[]).unwrap();
    let mut configuration=settings();configuration["maxConcurrent"]=json!(1);configuration["cacheRetentionDays"]=json!(7);configuration["secret"]=json!("PRIVATE_API_KEY");configuration["modelRoot"]=json!("PRIVATE_MODEL_DIRECTORY");configuration["connections"][0]["url"]=json!("https://private-host.example");configuration["connections"][0]["runtimeVersion"]=json!("PRIVATE_RUNTIME_VERSION");
    let bundle=diagnostics::collect(&store,&configuration,&json!({"owner":"private-owner-session","limit":100}),"fixture-version","2026-10-20T00:00:00Z").unwrap();
    assert_eq!(bundle["jobs"].as_array().unwrap().len(),1);assert_eq!(bundle["jobs"][0]["jobId"],"owned");assert_eq!(bundle["jobs"][0]["backend"],"fish-cloud");assert_eq!(bundle["jobs"][0]["model"],"drama-3");assert_eq!(bundle["jobs"][0]["errorCategory"],"request-failed");assert_eq!(bundle["settings"]["maxConcurrent"],1);assert_eq!(bundle["connections"][0]["runtimePinned"],true);
    let encoded=bundle.to_string();for private in ["PRIVATE_","private-owner-session","other-owner","private-host.example","foreign"]{assert!(!encoded.contains(private));}
}

#[test]
fn diagnostics_bounds_history_and_identifies_missing_snapshots_without_exposing_other_owners(){
    let directory=TestStore::new();let mut store=directory.open();
    for index in 0..3{admit_now(&mut store,input("owner","Private"),settings(),&format!("job-{index}")).unwrap();}
    let bundle=diagnostics::collect(&store,&settings(),&json!({"owner":"owner","limit":2}),"fixture","2026-10-20T00:00:00Z").unwrap();assert_eq!(bundle["jobs"].as_array().unwrap().len(),2);
    for request in [json!({"limit":0}),json!({"limit":101}),json!({"limit":1.5}),json!({"limit":1,"owner":""}),json!({"limit":1,"includeScripts":true})]{assert!(diagnostics::collect(&store,&settings(),&request,"fixture","2026-10-20T00:00:00Z").is_err());}
    store.connection.execute("DELETE FROM speech_requests WHERE job_id='job-0'",[]).unwrap();
    let missing=diagnostics::collect(&store,&settings(),&json!({"limit":100}),"fixture","2026-10-20T00:00:00Z").unwrap();let job=missing["jobs"].as_array().unwrap().iter().find(|job|job["jobId"]=="job-0").unwrap();assert_eq!(job["errorCategory"],"missing-request");assert!(job["backend"].is_null());assert!(job["model"].is_null());
}

#[test]
fn diagnostics_reports_the_separate_design_model_and_uncertain_category_without_a_tts_model_substitution(){
    let directory=TestStore::new();let mut store=directory.open();let now=chrono::Utc::now().to_rfc3339();
    let request=json!({"owner":"owner","description":"Private design prompt","text":"Private preview","cloudConsent":true,"pricing":null,"budgetLimit":null});
    super::super::super::voice_workflow::admit(&mut store,"designVoice",request,settings(),now.clone(),"design".into()).unwrap();job_lifecycle::claim_next(&mut store,1,now.clone()).unwrap().unwrap();job_lifecycle::finish(&mut store,"design",Err("Private upstream detail".into()),false,true,now.clone()).unwrap();
    let bundle=diagnostics::collect(&store,&settings(),&json!({"owner":"owner","limit":10}),"fixture",&now).unwrap();assert_eq!(bundle["jobs"][0]["backend"],"fish-cloud");assert_eq!(bundle["jobs"][0]["model"],"voice-design-1");assert_eq!(bundle["jobs"][0]["errorCategory"],"uncertain-completion");assert_eq!(bundle["jobs"][0]["usage"]["uncertainRequests"],1);assert!(!bundle.to_string().contains("Private"));
}
