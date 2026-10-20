use super::*;

const NOW:&str="2026-10-20T00:00:00.000Z";
const LATER:&str="2026-10-20T00:02:01.000Z";

fn cast(voice:&str)->Value{json!([{"id":"narrator","name":"Narrator","voiceId":voice,"referenceAssetIds":[],"direction":""}])}
fn template(cast:Value)->Value{json!({"id":"template","name":"Template","source":"Hello.","cast":cast,"profileId":null,"exportSettings":{"format":"wav","sampleRate":48000,"channels":2,"bitrate":192000,"loudnessLufs":null,"truePeakDb":null},"revisionId":"initial","parentRevisionId":null,"createdAt":NOW,"updatedAt":NOW})}
fn preferences()->Value{json!({"connections":[{"backend":"fish-cloud","configured":true,"model":"drama-3","url":null,"runtimeVersion":null}],"cloudConsent":true,"pricing":null,"budgetLimit":null,"answerBudgetLimit":null,"answerCharacterLimit":1000})}
fn render()->Value{json!({"owner":"studio","projectId":null,"revisionId":"answer","profileId":"profile-1","segments":[{"id":"answer","text":"Hello.","spokenText":"Hello.","chapter":null,"voiceIds":["guard-voice"],"referenceAssetIds":[]}],"takes":1,"priority":100,"reuseCache":false,"cloudConsent":true,"budgetLimit":null})}
fn save_profile(store:&mut SpeechStore,voice:&str)->Result<Value,String>{let mut value=profile();value["voiceId"]=json!(voice);value["dictionaryIds"]=json!([]);store.execute("saveProfile",&json!({"profile":value}))}

#[test]
fn deletion_preflight_covers_base_cast_scene_overrides_profiles_templates_and_active_billable_jobs(){
    for scenario in ["base","scene","profile","template","job"]{
        let directory=TestDirectory::new();let mut store=directory.open();
        match scenario{
            "base"=>{let mut value=draft();value["cast"]=cast("guard-voice");save(&mut store,&value,Value::Null).unwrap();},
            "scene"=>{let mut value=draft();value["cast"]=cast("other-voice");value["cast"][0]["sceneOverrides"]=json!([{"sceneId":"scene","voiceId":"guard-voice","referenceAssetIds":[],"direction":""}]);save(&mut store,&value,Value::Null).unwrap();},
            "profile"=>{save_profile(&mut store,"guard-voice").unwrap();},
            "template"=>{store.execute("saveTemplate",&json!({"template":template(cast("guard-voice")),"expectedRevisionId":null})).unwrap();},
            _=>{save_profile(&mut store,"other-voice").unwrap();super::super::super::admission::admit(&mut store,render(),preferences(),NOW.into(),"active".into()).unwrap();},
        }
        assert!(store.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true}),NOW).unwrap_err().contains("assigned"),"{scenario}");assert_eq!(store.execute("listVoiceMutations",&json!({"offset":0,"limit":20})).unwrap()["total"],0);
    }
}

#[test]
fn deletion_guard_prevents_cross_connection_binding_and_admission_races_without_holding_the_database(){
    let directory=TestDirectory::new();let mut store=directory.open();save_profile(&mut store,"other-voice").unwrap();let pending=store.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true}),NOW).unwrap();
    let mut other=directory.open();assert_eq!(other.execute("queue",&json!({"paused":true})).unwrap()["paused"],true);
    let mut value=draft();value["cast"]=cast("guard-voice");assert!(save(&mut other,&value,Value::Null).unwrap_err().contains("unresolved deletion"));
    value["cast"]=cast("other-voice");value["cast"][0]["sceneOverrides"]=json!([{"sceneId":"scene","voiceId":"guard-voice","referenceAssetIds":[],"direction":""}]);assert!(save(&mut other,&value,Value::Null).is_err());
    assert!(save_profile(&mut other,"guard-voice").unwrap_err().contains("unresolved deletion"));assert!(other.execute("saveTemplate",&json!({"template":template(cast("guard-voice")),"expectedRevisionId":null})).unwrap_err().contains("unresolved deletion"));
    assert!(super::super::super::admission::admit(&mut other,render(),preferences(),NOW.into(),"blocked-job".into()).unwrap_err().contains("unresolved deletion"));
    for table in ["projects","revisions","jobs","speech_requests","speech_budget","templates"]{assert_eq!(other.connection.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|row|row.get::<_,i64>(0)).unwrap(),0,"{table}");}
    store.finish_voice_mutation(pending["id"].as_str().unwrap(),Some(401),NOW).unwrap();save_profile(&mut other,"guard-voice").unwrap();
}

#[test]
fn uncertain_deletion_survives_restart_and_observation_does_not_release_bindings_or_replay_the_mutation(){
    let directory=TestDirectory::new();let mut store=directory.open();let first=store.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true}),NOW).unwrap();let id=first["id"].as_str().unwrap().to_string();
    assert!(store.voice_mutation_for_check(&id,"2026-10-20T00:01:00.000Z").is_err());assert!(store.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true,"retryMutationId":id}),NOW).is_err());drop(store);
    let mut reopened=directory.open();let recovered=reopened.voice_mutation_for_check(&id,LATER).unwrap();assert_eq!(recovered["state"],"uncertain");assert_eq!(recovered["errorCategory"],"interrupted");
    let observed=reopened.observe_voice_mutation(&id,200,None,LATER).unwrap();assert_eq!(observed["state"],"uncertain");assert_eq!(observed["remoteStatus"],200);assert!(save_profile(&mut reopened,"guard-voice").is_err());
    assert!(reopened.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true}),LATER).is_err());let retried=reopened.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true,"retryMutationId":id}),LATER).unwrap();assert_eq!(retried["parentId"],id);assert!(reopened.finish_voice_mutation(&id,Some(200),LATER).is_err());assert!(save_profile(&mut reopened,"guard-voice").is_err());
    assert_eq!(reopened.finish_voice_mutation(retried["id"].as_str().unwrap(),Some(200),LATER).unwrap()["state"],"deleted");save_profile(&mut reopened,"guard-voice").unwrap();assert_eq!(reopened.execute("listVoiceMutations",&json!({"offset":0,"limit":1})).unwrap()["total"],2);
}

#[test]
fn deletion_receipts_distinguish_confirmed_removal_unavailability_rejection_and_unknown_completion(){
    let directory=TestDirectory::new();let mut store=directory.open();
    for (index,(status,expected)) in [(Some(200),"deleted"),(Some(404),"unavailable"),(Some(401),"rejected"),(Some(403),"rejected"),(Some(402),"rejected"),(Some(422),"rejected"),(Some(429),"rejected"),(Some(503),"uncertain"),(Some(202),"uncertain"),(None,"uncertain")].iter().enumerate(){
        let pending=store.begin_voice_mutation("delete",&json!({"id":format!("voice-{index}"),"confirmed":true}),NOW).unwrap();let result=store.finish_voice_mutation(pending["id"].as_str().unwrap(),*status,NOW).unwrap();assert_eq!(result["state"],*expected);assert_eq!(result["httpStatus"],json!(status));
    }
    let page=store.execute("listVoiceMutations",&json!({"offset":2,"limit":2})).unwrap();assert_eq!(page["total"],10);assert_eq!(page["mutations"].as_array().unwrap().len(),2);assert!(store.begin_voice_mutation("delete",&json!({"id":"voice","confirmed":"true"}),NOW).is_err());
}

#[test]
fn voice_updates_preserve_bindings_and_store_only_explicit_validated_changes(){
    let directory=TestDirectory::new();let mut store=directory.open();save_profile(&mut store,"guard-voice").unwrap();
    let input=json!({"id":"guard-voice","confirmed":true,"changes":{"name":"Narrator 世界","visibility":"unlist"}});
    let pending=store.begin_voice_mutation("update",&input,NOW).unwrap();assert_eq!(pending["operation"],"update");assert_eq!(pending["changes"],input["changes"]);
    let mut other=directory.open();save_profile(&mut other,"guard-voice").unwrap();let mut project=draft();project["cast"]=cast("guard-voice");save(&mut other,&project,Value::Null).unwrap();
    assert!(store.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true}),NOW).is_err());
    let finished=store.finish_voice_mutation(pending["id"].as_str().unwrap(),Some(200),LATER).unwrap();assert_eq!(finished["state"],"updated");assert_eq!(finished["httpStatus"],200);assert_eq!(store.execute("listVoiceMutations",&json!({"offset":0,"limit":20})).unwrap()["mutations"][0],finished);
}

#[test]
fn uncertain_update_recovery_requires_identical_changes_and_never_infers_settlement_from_lookup(){
    let directory=TestDirectory::new();let mut store=directory.open();let input=json!({"id":"guard-voice","confirmed":true,"changes":{"visibility":"unlist"}});let pending=store.begin_voice_mutation("update",&input,NOW).unwrap();let id=pending["id"].as_str().unwrap();store.finish_voice_mutation(id,None,NOW).unwrap();drop(store);
    let mut store=directory.open();let observed=store.observe_voice_mutation(id,200,Some(&json!({"id":"guard-voice","name":"Narrator","visibility":"unlist"})),LATER).unwrap();assert_eq!(observed["state"],"uncertain");assert_eq!(observed["remoteVoice"]["visibility"],"unlist");
    assert!(store.begin_voice_mutation("delete",&json!({"id":"guard-voice","confirmed":true,"retryMutationId":id}),LATER).is_err());
    assert!(store.begin_voice_mutation("update",&json!({"id":"guard-voice","confirmed":true,"retryMutationId":id,"changes":{"visibility":"private"}}),LATER).is_err());
    let mut retry=input;retry["retryMutationId"]=json!(id);let retried=store.begin_voice_mutation("update",&retry,LATER).unwrap();assert_eq!(retried["parentId"],id);assert!(store.finish_voice_mutation(id,Some(200),LATER).is_err());assert_eq!(store.finish_voice_mutation(retried["id"].as_str().unwrap(),Some(200),LATER).unwrap()["state"],"updated");
}

#[test]
fn invalid_voice_changes_fail_before_creating_any_mutation(){
    let directory=TestDirectory::new();let mut store=directory.open();
    for changes in [json!({}),json!({"name":" "}),json!({"name":" leading"}),json!({"name":"two\nlines"}),json!({"name":"世".repeat(342)}),json!({"visibility":"public"}),json!({"visibility":null}),json!({"name":"Valid","secret":"private"})]{assert!(store.begin_voice_mutation("update",&json!({"id":"voice","confirmed":true,"changes":changes}),NOW).is_err());}
    assert!(store.begin_voice_mutation("update",&json!({"id":"voice","confirmed":false,"changes":{"name":"Valid"}}),NOW).is_err());assert_eq!(store.execute("listVoiceMutations",&json!({"offset":0,"limit":20})).unwrap()["total"],0);
}
