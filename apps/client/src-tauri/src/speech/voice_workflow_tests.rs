use super::*;
use super::super::{job_lifecycle::{self,RunOutcome},voice_workflow_results};
use base64::{engine::general_purpose::STANDARD,Engine};
use std::path::PathBuf;

struct Directory(PathBuf);
impl Directory{
    fn new()->Self{let mut id=[0u8;16];getrandom::fill(&mut id).unwrap();let id:String=id.iter().map(|byte|format!("{byte:02x}")).collect();Self(std::env::temp_dir().join(format!("speech-voice-workflow-{id}")))}
    fn open(&self)->SpeechStore{SpeechStore::open(self.0.clone()).unwrap()}
}
impl Drop for Directory{fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}
fn now()->String{chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}
fn price()->Value{json!({"perRequest":1.25,"currency":"EUR","source":"Synthetic account contract","effectiveFrom":"2026-01-01","effectiveTo":"2026-12-31"})}
fn settings()->Value{json!({"cloudConsent":true,"budgetLimit":null,"connections":[{"backend":"fish-cloud","configured":true}]})}
fn design()->Value{json!({"owner":"studio","description":"Warm narrator","text":"Hallo 世界.","cloudConsent":true,"budgetLimit":10,"pricing":price()})}
fn creation()->Value{json!({"owner":"studio","name":"Designed voice","referenceAssetIds":[],"transcripts":[],"designCandidateId":"candidate-0","permissionConfirmed":true,"rightsEvidence":"My generated candidate","cloudConsent":true,"budgetLimit":10,"pricing":price()})}
fn response()->Value{
    let mut bytes=Vec::new();bytes.extend_from_slice(b"RIFF");bytes.extend_from_slice(&516u32.to_le_bytes());bytes.extend_from_slice(b"WAVEfmt ");bytes.extend_from_slice(&16u32.to_le_bytes());bytes.extend_from_slice(&1u16.to_le_bytes());bytes.extend_from_slice(&1u16.to_le_bytes());bytes.extend_from_slice(&24000u32.to_le_bytes());bytes.extend_from_slice(&48000u32.to_le_bytes());bytes.extend_from_slice(&2u16.to_le_bytes());bytes.extend_from_slice(&16u16.to_le_bytes());bytes.extend_from_slice(b"data");bytes.extend_from_slice(&480u32.to_le_bytes());for _ in 0..240{bytes.extend_from_slice(&1i16.to_le_bytes());}
    json!({"candidates":(0..2).map(|index|json!({"id":format!("candidate-{index}"),"index":index,"audio_base64":STANDARD.encode(&bytes),"sample_rate":24000,"duration_ms":10,"text":"Hallo 世界.","instruct":"Warm narrator","voice_design_signature":format!("signed-{index}"),"language":"de","responseSha256":"a".repeat(64)})).collect::<Vec<_>>()})
}
fn snapshot(store:&SpeechStore,id:&str)->Value{let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).unwrap();serde_json::from_str(&data).unwrap()}
fn amount(store:&SpeechStore,id:&str)->f64{store.connection.query_row("SELECT amount FROM speech_budget WHERE job_id=?1",[id],|row|row.get(0)).unwrap()}

#[test]
fn voice_workflow_candidates_survive_a_committed_restart_and_create_a_private_voice_from_the_actual_signed_audio(){
    let directory=Directory::new();let mut store=directory.open();
    let queued=admit(&mut store,"designVoice",design(),settings(),now(),"design".into()).unwrap();assert_eq!(queued["kind"],"voice-design");assert_eq!(amount(&store,"design"),1.25);assert_eq!(snapshot(&store,"design")["model"],"voice-design-1");
    let mut active=job_lifecycle::claim_next(&mut store,1,now()).unwrap().unwrap();
    let mut returned=response();returned["candidates"][1].as_object_mut().unwrap().remove("text");returned["candidates"][1].as_object_mut().unwrap().remove("voice_design_signature");
    voice_workflow_results::commit(&mut store,&mut active,returned,&now()).unwrap();assert_eq!(active["completedSegments"],1);
    assert!(result(&mut store,&json!({"owner":"foreign","jobId":"design"})).is_err());
    drop(store);let mut store=directory.open();
    let recovered=store.execute("listJobs",&json!({"owner":"studio","kinds":["voice-design"],"limit":1})).unwrap();assert_eq!(recovered[0]["state"],"completed");assert_eq!(recovered[0]["usage"]["estimatedCommittedCost"],1.25);assert_eq!(recovered[0]["usage"]["completedRequests"],1);assert_eq!(recovered[0]["usage"]["producedAudioSeconds"],0.02);
    let saved=result(&mut store,&json!({"owner":"studio","jobId":"design"})).unwrap();assert_eq!(saved["candidates"].as_array().unwrap().len(),2);assert_eq!(saved["candidates"][0]["metadata"]["voice_design_signature"],"signed-0");assert!(!saved.to_string().contains("audio_base64"));
    assert!(store.connection.execute("UPDATE speech_design_candidates SET metadata='{}'",[]).is_err());assert!(store.connection.execute("UPDATE speech_voice_workflow_results SET data='{}'",[]).is_err());
    assert_eq!(saved["candidates"][1]["previewText"],"Hallo 世界.");assert!(saved["candidates"][1]["metadata"].get("text").is_none());assert!(saved["candidates"][1]["metadata"].get("voice_design_signature").is_none());
    let mut unsigned=creation();unsigned["designCandidateId"]=json!("candidate-1");admit(&mut store,"createVoice",unsigned,settings(),now(),"unsigned".into()).unwrap();assert_eq!(snapshot(&store,"unsigned")["references"][0]["transcript"],"Hallo 世界.");assert!(snapshot(&store,"unsigned")["candidate"].get("voice_design_signature").is_none());job_lifecycle::request_cancel(&mut store,"studio","unsigned",now()).unwrap();
    admit(&mut store,"createVoice",creation(),settings(),now(),"create".into()).unwrap();let pinned=snapshot(&store,"create");assert_eq!(pinned["references"].as_array().unwrap().len(),1);assert_eq!(pinned["references"][0]["asset"]["id"],saved["candidates"][0]["asset"]["id"]);assert_eq!(pinned["references"][0]["transcript"],"Hallo 世界.");assert_eq!(pinned["candidate"]["voice_design_signature"],"signed-0");assert!(pinned["model"].is_null());
    let mut active=job_lifecycle::claim_next(&mut store,1,now()).unwrap().unwrap();
    let cancelled=job_lifecycle::request_cancel(&mut store,"studio","create",now()).unwrap();assert_eq!(cancelled["state"],"running");
    voice_workflow_results::commit(&mut store,&mut active,json!({"_id":"private-created","title":"Designed voice","visibility":"private","languages":["de"],"author":{"_id":"author-id","nickname":"Owner"},"source":"voice_design","licensed":false,"samples":[]}),&now()).unwrap();assert!(active["cancelRequestedAt"].is_string());
    let completed=job_lifecycle::finish(&mut store,"create",Ok(RunOutcome::Completed),true,true,now()).unwrap();assert_eq!(completed["state"],"completed");assert_eq!(completed["usage"]["completedRequests"],1);
    let created=result(&mut store,&json!({"owner":"studio","jobId":"create"})).unwrap();assert_eq!(created["voice"]["visibility"],"private");assert_eq!(created["voice"]["evidence"]["source"],"voice_design");assert_eq!(created["voice"]["evidence"]["authorId"],"author-id");assert!(created["voice"]["rights"].is_null());
}

#[test]
fn voice_workflow_admission_checks_consent_permission_ownership_and_real_budget_quotes_before_mutation(){
    let directory=Directory::new();let mut store=directory.open();
    for (field,value) in [("cloudConsent",json!(false)),("description",json!("")),("text",json!("a".repeat(151))),("budgetLimit",json!(-1)),("pricing",Value::Null),("unverified",json!(true))]{
        let mut input=design();input[field]=value;assert!(admit(&mut store,"designVoice",input,settings(),now(),format!("invalid-{field}")).is_err(),"{field}");
    }
    let mut no_consent=settings();no_consent["cloudConsent"]=json!(false);assert!(admit(&mut store,"designVoice",design(),no_consent,now(),"disabled".into()).is_err());
    let mut low=settings();low["budgetLimit"]=json!(1);assert!(admit(&mut store,"designVoice",design(),low,now(),"budget".into()).is_err());
    for field in ["permissionConfirmed","designCandidateId"]{let mut input=creation();input[field]=if field=="permissionConfirmed"{json!(false)}else{json!("foreign-candidate")};assert!(admit(&mut store,"createVoice",input,settings(),now(),"invalid-create".into()).is_err());}
    for table in ["jobs","speech_requests","speech_budget"]{assert_eq!(store.connection.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get::<_,i64>(0)).unwrap(),0);}
    admit(&mut store,"designVoice",design(),settings(),now(),"first".into()).unwrap();let mut second=design();second["budgetLimit"]=json!(2);assert!(admit(&mut store,"designVoice",second,settings(),now(),"parallel".into()).unwrap_err().contains("exceeded"));
}

#[test]
fn voice_workflow_cancellation_and_uncertain_retries_keep_one_request_charge_and_trace_the_parent(){
    let directory=Directory::new();let mut store=directory.open();admit(&mut store,"designVoice",design(),settings(),now(),"queued".into()).unwrap();
    job_lifecycle::request_cancel(&mut store,"studio","queued",now()).unwrap();assert_eq!(amount(&store,"queued"),0.0);
    let mut retry=design();retry["parentJobId"]=json!("queued");admit(&mut store,"designVoice",retry,settings(),now(),"retry".into()).unwrap();
    let active=job_lifecycle::claim_next(&mut store,1,now()).unwrap().unwrap();assert_eq!(active["attempt"],2);assert_eq!(active["parentJobId"],"queued");
    let uncertain=job_lifecycle::finish(&mut store,"retry",Err("Connection ended".into()),false,true,now()).unwrap();assert_eq!(uncertain["state"],"uncertain");assert_eq!(uncertain["usage"]["estimatedUncertainCost"],1.25);assert_eq!(amount(&store,"retry"),1.25);
    let mut changed=design();changed["parentJobId"]=json!("retry");changed["text"]=json!("Changed");assert!(admit(&mut store,"designVoice",changed,settings(),now(),"changed".into()).is_err());
    let mut unknown=design();unknown["pricing"]=Value::Null;unknown["budgetLimit"]=Value::Null;admit(&mut store,"designVoice",unknown,settings(),now(),"unknown".into()).unwrap();job_lifecycle::claim_next(&mut store,1,now()).unwrap().unwrap();
    let uncertain=job_lifecycle::finish(&mut store,"unknown",Err("Connection ended".into()),false,true,now()).unwrap();assert!(uncertain["usage"]["estimatedUncertainCost"].is_null());
}
