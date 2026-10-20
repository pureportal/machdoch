use super::*;

fn reference(store:&mut SpeechStore,directory:&TestDirectory)->Value{
    let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24000,1).unwrap();store.connection.execute("INSERT INTO speech_references VALUES(?1,'Accurate synthetic transcript','Synthetic test permission')",[asset["id"].as_str().unwrap()]).unwrap();asset
}
fn reference_profile(asset:&Value,backend:&str)->Value{
    let mut profile=profile();profile["id"]=json!("reference-profile");profile["name"]=json!("Reference profile");profile["dictionaryIds"]=json!([]);profile["chunkLength"]=json!(300);profile["referenceAssetIds"]=json!([asset["id"]]);profile["backend"]=json!(backend);profile.as_object_mut().unwrap().remove("voiceId");profile
}
fn preferences(backend:&str)->Value{json!({"connections":[{"backend":backend,"configured":true,"model":"drama-3","url":if backend=="sglang"{json!("http://127.0.0.1:8000")}else{Value::Null},"runtimeVersion":if backend=="sglang"{json!("pinned-test-runtime")}else{Value::Null}}],"cloudConsent":true,"pricing":null,"budgetLimit":null,"answerBudgetLimit":null,"answerCharacterLimit":1000})}
fn request()->Value{json!({"owner":"chat:manual:session","projectId":null,"revisionId":"answer","profileId":"reference-profile","segments":[{"id":"answer","text":"Hello.","spokenText":"Hello.","chapter":null,"voiceIds":[],"referenceAssetIds":[]}],"takes":1,"priority":100,"reuseCache":false,"cloudConsent":true,"budgetLimit":null})}

#[test]
fn default_profile_references_bind_completed_and_live_answers_before_snapshot_budget_and_provider_validation(){
    let directory=TestDirectory::new();let mut store=directory.open();let asset=reference(&mut store,&directory);
    for backend in ["fish-cloud","sglang"]{
        let profile=reference_profile(&asset,backend);store.execute("saveProfile",&json!({"profile":profile})).unwrap();
        let id=format!("answer-{backend}");super::super::super::admission::admit(&mut store,request(),preferences(backend),timestamp(),id.clone()).unwrap();
        let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[&id],|row|row.get(0)).unwrap();let snapshot=parse_json(data).unwrap();assert_eq!(snapshot["input"]["segments"][0]["referenceAssetIds"],json!([asset["id"]]));assert_eq!(snapshot["input"]["segments"][0]["voiceIds"],json!([]));assert_eq!(snapshot["references"][asset["id"].as_str().unwrap()]["transcript"],"Accurate synthetic transcript");
    }
    let profile=reference_profile(&asset,"fish-cloud");store.execute("saveProfile",&json!({"profile":profile})).unwrap();super::super::super::admission::admit_live(&mut store,request(),preferences("fish-cloud"),timestamp(),"live-reference".into(),100).unwrap();
    let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='live-reference'",[],|row|row.get(0)).unwrap();let snapshot=parse_json(data).unwrap();assert_eq!(snapshot["input"]["segments"][0]["referenceAssetIds"],json!([asset["id"]]));
    let original=request()["segments"][0].clone();let mut explicit=original.clone();explicit["voiceIds"]=json!(["another-voice"]);assert_eq!(super::super::super::profile_binding::apply(&explicit,&profile).unwrap(),explicit);
}

#[test]
fn default_library_and_assistant_voices_become_explicit_in_the_admitted_request(){
    let directory=TestDirectory::new();let mut store=directory.open();
    for (backend,model,voice) in [("fish-cloud","drama-3","library-voice"),("openai","gpt-4o-mini-tts","cedar"),("google","gemini-3.1-flash-tts-preview","Kore")]{
        let mut profile=profile();profile["id"]=json!("reference-profile");profile["dictionaryIds"]=json!([]);profile["backend"]=json!(backend);profile["model"]=json!(model);profile["voiceId"]=json!(voice);profile["chunkLength"]=json!(300);store.execute("saveProfile",&json!({"profile":profile})).unwrap();
        let mut preferences=preferences(backend);preferences["connections"][0]["model"]=json!(model);let id=format!("default-{backend}");super::super::super::admission::admit(&mut store,request(),preferences,timestamp(),id.clone()).unwrap();
        let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).unwrap();let snapshot=parse_json(data).unwrap();assert_eq!(snapshot["input"]["segments"][0]["voiceIds"],json!([voice]));assert_eq!(snapshot["input"]["segments"][0]["referenceAssetIds"],json!([]));
    }
}

#[test]
fn profile_reference_validation_requires_unique_existing_recordings_permission_and_one_binding_mode(){
    let directory=TestDirectory::new();let mut store=directory.open();let asset=reference(&mut store,&directory);let profile=reference_profile(&asset,"fish-cloud");
    let mut mixed=profile.clone();mixed["voiceId"]=json!("voice");assert!(store.execute("saveProfile",&json!({"profile":mixed})).is_err());
    let mut duplicate=profile.clone();duplicate["referenceAssetIds"]=json!([asset["id"],asset["id"]]);assert!(store.execute("saveProfile",&json!({"profile":duplicate})).is_err());
    let mut missing=profile.clone();missing["referenceAssetIds"]=json!(["f".repeat(64)]);assert!(store.execute("saveProfile",&json!({"profile":missing})).is_err());
    let mut unsupported=profile.clone();unsupported["backend"]=json!("openai");unsupported["model"]=json!("gpt-4o-mini-tts");assert!(store.execute("saveProfile",&json!({"profile":unsupported})).is_err());
    store.connection.execute("UPDATE speech_references SET rights=''",[]).unwrap();assert!(store.execute("saveProfile",&json!({"profile":profile})).unwrap_err().contains("permission evidence"));
    let mut unbound=profile;unbound["referenceAssetIds"]=json!([]);assert!(super::super::super::profile_binding::apply(&request()["segments"][0],&unbound).unwrap_err().contains("Assign a voice"));
}

#[test]
fn default_reference_assets_and_permission_survive_profile_revision_snapshots_and_portable_projects_without_takes(){
    let directory=TestDirectory::new();let mut store=directory.open();let asset=reference(&mut store,&directory);let profile=reference_profile(&asset,"sglang");store.execute("saveProfile",&json!({"profile":profile})).unwrap();
    let mut project=draft();project["profileId"]=profile["id"].clone();let saved=save(&mut store,&project,Value::Null).unwrap();
    let linked:i64=store.connection.query_row("SELECT count(*) FROM revision_assets WHERE revision_id=?1 AND asset_id=?2",params![saved["revisionId"].as_str().unwrap(),asset["id"].as_str().unwrap()],|row|row.get(0)).unwrap();assert_eq!(linked,1);
    let path=directory.0.join("second-reference.wav");let mut bytes=fs::read(directory.audio()).unwrap();bytes[44]=1;fs::write(&path,bytes).unwrap();let second=store.put_asset(&path,"audio/wav",0.01,24000,1).unwrap();store.connection.execute("INSERT INTO speech_references VALUES(?1,'Second transcript','Second test permission')",[second["id"].as_str().unwrap()]).unwrap();let mut changed=profile.clone();changed["referenceAssetIds"]=json!([second["id"]]);store.execute("saveProfile",&json!({"profile":changed})).unwrap();
    let archive=store.portable_snapshot(saved["id"].as_str().unwrap(),saved["revisionId"].as_str().unwrap()).unwrap();assert!(archive["assets"].get(asset["id"].as_str().unwrap()).is_some());assert_eq!(archive["references"][asset["id"].as_str().unwrap()]["rightsEvidence"],"Synthetic test permission");
    assert!(archive["assets"].get(second["id"].as_str().unwrap()).is_some());assert_eq!(archive["revisionProfiles"][saved["revisionId"].as_str().unwrap()]["referenceAssetIds"],json!([asset["id"]]));
    let imported=store.commit_portable_snapshot(&archive).unwrap();let id=imported["profileId"].as_str().unwrap();let profiles=store.execute("listProfiles",&json!({})).unwrap();assert_eq!(profiles.as_array().unwrap().iter().find(|profile|profile["id"]==id).unwrap()["referenceAssetIds"],json!([second["id"]]));
    let data:String=store.connection.query_row("SELECT data FROM revision_profiles WHERE revision_id=?1",[imported["revisionId"].as_str().unwrap()],|row|row.get(0)).unwrap();assert_eq!(parse_json(data).unwrap()["referenceAssetIds"],json!([asset["id"]]));
    let mut damaged=archive;damaged["references"].as_object_mut().unwrap().clear();assert!(store.commit_portable_snapshot(&damaged).unwrap_err().contains("profile default reference"));
}
